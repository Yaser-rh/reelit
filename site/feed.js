import bridge from './bridge.js';
import { fetchFeed } from './reddit.js';
import Hls from 'hls.js';

const SEEN_STORAGE_KEY = "reelit_seen_posts_v1";

function getStoredSeenIds() {
  try {
    const raw = localStorage.getItem(SEEN_STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return new Set(arr);
      }
    }
  } catch (_) {}
  return new Set();
}

function saveStoredSeenIds(seenSet) {
  try {
    const arr = Array.from(seenSet);
    if (arr.length > 1500) {
      arr.splice(0, arr.length - 1500);
    }
    localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(arr));
  } catch (_) {}
}

export class FeedController {
  constructor({ container, onStatusUpdate, onDebugLog }) {
    this.container = container;
    this.onStatusUpdate = onStatusUpdate || (() => {});
    this.onDebugLog = onDebugLog || (() => {});

    this.items = [];
    this.renderedElements = new Map(); // index -> DOM element
    this.currentIndex = -1;
    this.isMuted = true; // start muted to comply with browser autoplay policies
    this.isLoading = false;
    this.hasMore = true;
    this.after = null;

    // Viewed reels tracking for dynamic feed freshness & rotation
    this.seenPostIds = getStoredSeenIds();
    this._saveSeenTimer = null;

    // Feed filter parameters
    this.subreddit = "";
    this.user = "";
    this.sort = "best";
    this.timeFilter = "day";

    this.setupIntersectionObserver();
    this.setupKeyboardNavigation();
  }

  setupIntersectionObserver() {
    this.observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const index = parseInt(entry.target.dataset.index, 10);
          if (isNaN(index)) return;

          if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
            this.handleItemVisible(index, entry.target);
          } else if (!entry.isIntersecting || entry.intersectionRatio < 0.2) {
            this.handleItemHidden(index, entry.target);
          }
        });
      },
      {
        root: this.container,
        threshold: [0.1, 0.6, 0.9]
      }
    );
  }

  setupKeyboardNavigation() {
    window.addEventListener("keydown", (e) => {
      // Don't intercept if user is typing in an input or select
      if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;

      if (e.code === "ArrowDown" || e.code === "KeyJ") {
        e.preventDefault();
        this.scrollToNext();
      } else if (e.code === "ArrowUp" || e.code === "KeyK") {
        e.preventDefault();
        this.scrollToPrev();
      } else if (e.code === "ArrowRight" || e.code === "KeyL") {
        const currentEl = this.renderedElements.get(this.currentIndex);
        const gallery = currentEl?.querySelector(".gallery-container");
        if (gallery) {
          e.preventDefault();
          gallery.scrollBy({ left: gallery.clientWidth, behavior: "smooth" });
        }
      } else if (e.code === "ArrowLeft" || e.code === "KeyH") {
        const currentEl = this.renderedElements.get(this.currentIndex);
        const gallery = currentEl?.querySelector(".gallery-container");
        if (gallery) {
          e.preventDefault();
          gallery.scrollBy({ left: -gallery.clientWidth, behavior: "smooth" });
        }
      } else if (e.code === "Space") {
        e.preventDefault();
        this.toggleCurrentPlayback();
      } else if (e.code === "KeyM") {
        e.preventDefault();
        this.toggleMute();
      } else if (e.code === "KeyO") {
        e.preventDefault();
        const currentItem = this.items[this.currentIndex];
        if (currentItem?.permalink) {
          window.open(currentItem.permalink, "_blank");
        }
      }
    });
  }

  scrollToNext() {
    if (this.currentIndex < this.items.length - 1) {
      const nextEl = this.renderedElements.get(this.currentIndex + 1);
      if (nextEl) {
        nextEl.scrollIntoView({ behavior: "smooth" });
      }
    }
  }

  scrollToPrev() {
    if (this.currentIndex > 0) {
      const prevEl = this.renderedElements.get(this.currentIndex - 1);
      if (prevEl) {
        prevEl.scrollIntoView({ behavior: "smooth" });
      }
    }
  }

  handleItemVisible(index, element) {
    if (this.currentIndex === index) return;
    this.currentIndex = index;

    const currentItem = this.items[index];
    if (currentItem && currentItem.id) {
      this.recordSeenItem(currentItem);
    }

    this.onDebugLog(`Active Reel: #${index} - ${currentItem?.title?.substring(0, 30)}...`);

    // Pause all other media & clean up distant HLS instances to prevent MediaSource decoder limits
    this.renderedElements.forEach((el, idx) => {
      if (idx !== index) {
        this.pauseMedia(el);
        if (Math.abs(idx - index) > 2) {
          const video = el.querySelector("video");
          if (video?._hls) {
            video._hls.destroy();
            video._hls = null;
          }
        }
      }
    });

    // Play active item
    this.playMedia(element);

    // Preload next 2 items
    this.preloadAhead(index, 2);

    // Infinite scroll check: near end
    if (index >= this.items.length - 4 && !this.isLoading && this.hasMore) {
      this.loadMore();
    }
  }

  recordSeenItem(item) {
    if (!item?.id) return;
    if (!this.seenPostIds.has(item.id)) {
      this.seenPostIds.add(item.id);
      clearTimeout(this._saveSeenTimer);
      this._saveSeenTimer = setTimeout(() => {
        saveStoredSeenIds(this.seenPostIds);
      }, 600);
      this.onStatusUpdate({ seenCount: this.seenPostIds.size });
    }
  }

  handleItemHidden(index, element) {
    this.pauseMedia(element);
  }

  playMedia(element) {
    const video = element.querySelector("video");
    const audio = element.querySelector("audio");
    const index = parseInt(element.dataset.index, 10);
    const item = this.items[index];

    if (video) {
      video.volume = 1.0;
      video.muted = this.isMuted;

      // On-demand HLS initialization for Reddit videos
      if (item?.hlsUrl && Hls.isSupported()) {
        if (!video._hls) {
          const hls = new Hls({
            capLevelToPlayerSize: true,
            maxBufferLength: 15,
            maxMaxBufferLength: 30,
            enableWorker: true
          });
          hls.loadSource(item.hlsUrl);
          hls.attachMedia(video);
          video._hls = hls;

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (element.dataset.index == this.currentIndex) {
              const playPromise = video.play();
              if (playPromise !== undefined) {
                playPromise.catch((err) => {
                  if (!this.isMuted) {
                    video.muted = true;
                    video.play().catch(() => {});
                  }
                });
              }
            }
          });

          hls.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
              console.warn("HLS fatal error, falling back to direct MP4 videoUrl", data);
              hls.destroy();
              video._hls = null;
              if (item.videoUrl) {
                video.src = item.videoUrl;
                video.load();
                if (element.dataset.index == this.currentIndex) {
                  video.play().catch(() => {});
                }
              }
            }
          });
          return;
        } else {
          video._hls.startLoad();
        }
      } else if (item?.videoUrl && (!video.src || video.src !== item.videoUrl)) {
        video.src = item.videoUrl;
        video.load();
      }

      const playPromise = video.play();
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          if (!this.isMuted) {
            console.warn("Unmuted autoplay restricted by browser policy, falling back to muted:", err);
            video.muted = true;
            video.play().catch(() => {});
          }
        });
      }
    }

    if (audio) {
      audio.volume = 1.0;
      audio.muted = this.isMuted;
      if (!this.isMuted && video && !video.paused) {
        audio.currentTime = video.currentTime;
        audio.play().catch(() => {});
      }
    }
  }

  pauseMedia(element) {
    const video = element.querySelector("video");
    const audio = element.querySelector("audio");

    if (video) {
      if (!video.paused) {
        video.pause();
      }
      if (video._hls) {
        video._hls.stopLoad();
      }
    }
    if (audio && !audio.paused) {
      audio.pause();
    }
  }

  toggleCurrentPlayback() {
    const currentEl = this.renderedElements.get(this.currentIndex);
    if (!currentEl) return;

    const video = currentEl.querySelector("video");
    if (!video) return;

    const flash = currentEl.querySelector(".play-indicator-flash");

    if (video.paused) {
      this.playMedia(currentEl);
      this.showFlashIcon(flash, "play");
    } else {
      this.pauseMedia(currentEl);
      this.showFlashIcon(flash, "pause");
    }
  }

  showFlashIcon(flashEl, type) {
    if (!flashEl) return;
    flashEl.innerHTML =
      type === "play"
        ? `<svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>`
        : `<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;

    flashEl.classList.remove("animate");
    // force reflow
    void flashEl.offsetWidth;
    flashEl.classList.add("animate");
    setTimeout(() => flashEl.classList.remove("animate"), 500);
  }

  toggleMute(targetElement = null) {
    this.isMuted = !this.isMuted;

    const currentEl = targetElement || this.renderedElements.get(this.currentIndex);
    const item = this.items[this.currentIndex];

    // Apply to current visible media
    if (currentEl) {
      const video = currentEl.querySelector("video");
      const audio = currentEl.querySelector("audio");

      if (video) {
        video.muted = this.isMuted;
        video.volume = 1.0;
        if (!this.isMuted && video.paused) {
          video.play().catch(() => {});
        }
      }

      if (audio) {
        audio.muted = this.isMuted;
        audio.volume = 1.0;
        if (this.isMuted) {
          audio.pause();
        } else if (video && !video.paused) {
          audio.currentTime = video.currentTime;
          audio.play().catch(() => {});
        }
      }

      const soundBtn = currentEl.querySelector(".sound-btn .action-icon-circle");
      if (soundBtn) {
        soundBtn.innerHTML = this.getSoundIconSvg(this.isMuted);
      }
    }

    // Keep all sound buttons & diagnostic badges in sync across reels
    this.renderedElements.forEach((el, idx) => {
      const btn = el.querySelector(".sound-btn .action-icon-circle");
      if (btn) {
        btn.innerHTML = this.getSoundIconSvg(this.isMuted);
      }
      const it = this.items[idx];
      if (it) {
        this.updateItemBadge(el, it);
      }
    });

    if (item && item.isIspFallback) {
      this.onStatusUpdate({ toast: "Redgifs blocked by ISP: playing Reddit preview (desktop VPN required for audio)" });
    } else if (item && (item.isGif || item.hasAudio === false)) {
      this.onStatusUpdate({ toast: "This video has no audio (GIF / Silent)" });
    } else {
      this.onStatusUpdate({
        isMuted: this.isMuted,
        toast: this.isMuted ? "Sound Off 🔇" : "Sound On 🔊"
      });
    }
  }

  getDiagnosticBadgeHtml(item) {
    if (item.isText || item.mediaType === "text") {
      return `<div class="diag-pill source-text">📝 Text</div>`;
    }
    if (item.isGallery) {
      return `<div class="diag-pill source-reddit">🖼️ Gallery (${item.images?.length || 0})</div>`;
    }
    if (item.mediaType === "image") {
      return `<div class="diag-pill source-reddit">🖼️ Image</div>`;
    }

    let sourcePrefix = "🔴 Reddit";
    let pillClass = "source-reddit";

    if (item.sourceType === "redgifs_direct") {
      sourcePrefix = "🎬 Redgifs HD";
      pillClass = "source-redgifs";
    } else if (item.sourceType === "reddit_cache" || item.isIspFallback) {
      sourcePrefix = "🛡️ Cache";
      pillClass = "source-isp-cache";
    } else if (item.sourceType === "redgifs_iframe") {
      sourcePrefix = "📺 Redgifs";
      pillClass = "source-redgifs";
    } else if (item.sourceType === "redgifs_pending") {
      sourcePrefix = "⏳ Resolving";
      pillClass = "source-redgifs";
    }

    let audioSuffix = "• 🔇";
    if (item.isGif || item.hasAudio === false) {
      audioSuffix = "• 🔇";
    } else if (!this.isMuted) {
      audioSuffix = "• 🔊";
    }

    return `<div class="diag-pill ${pillClass}">${sourcePrefix} ${audioSuffix}</div>`;
  }

  updateItemBadge(element, item) {
    if (!element) return;
    const badge = element.querySelector(".reel-debug-badge");
    if (badge) {
      badge.innerHTML = this.getDiagnosticBadgeHtml(item);
    }
  }

  updateReelMedia(element, item) {
    if (!element) return;

    this.updateItemBadge(element, item);

    // Ensure sound button is present and updated
    const actionColumn = element.querySelector(".action-column");
    let soundBtn = element.querySelector(".sound-btn");
    if (!soundBtn && actionColumn && item.videoUrl) {
      const statusBtn = element.querySelector(".bridge-status-btn");
      soundBtn = document.createElement("button");
      soundBtn.className = "action-btn sound-btn";
      soundBtn.title = "Toggle Sound";
      soundBtn.innerHTML = `
        <div class="action-icon-circle">
          ${this.getSoundIconSvg(this.isMuted)}
        </div>
        <span class="action-label">${item.isGif || item.hasAudio === false ? "No Sound" : "Sound"}</span>
      `;
      soundBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleMute(element);
      });
      if (statusBtn) {
        actionColumn.insertBefore(soundBtn, statusBtn);
      } else {
        actionColumn.appendChild(soundBtn);
      }
    } else if (soundBtn) {
      const soundLabel = soundBtn.querySelector(".action-label");
      if (soundLabel) {
        soundLabel.textContent = item.isGif || item.hasAudio === false ? "No Sound" : "Sound";
      }
    }

    const wrapper = element.querySelector(".media-wrapper");
    if (!wrapper) return;

    if (item.videoUrl) {
      let video = wrapper.querySelector("video");
      if (!video) {
        wrapper.innerHTML = `
          <video class="media-element" playsinline loop preload="metadata" ${item.thumbnailUrl ? `poster="${item.thumbnailUrl}"` : ""} ${this.isMuted ? "muted" : ""}></video>
          <div class="play-indicator-flash"></div>
        `;
        video = wrapper.querySelector("video");
        video.addEventListener("error", () => {
          if (item.cachedVideoUrl && video.src !== item.cachedVideoUrl) {
            item.sourceType = "reddit_cache";
            item.isIspFallback = true;
            item.hasAudio = false;
            this.updateItemBadge(element, item);
            video.src = item.cachedVideoUrl;
            video.load();
            if (element.dataset.index == this.currentIndex) {
              video.play().catch(() => {});
            }
          }
        });
      }

      if (video && video.src !== item.videoUrl) {
        const wasPlaying = !video.paused;
        const prevTime = video.currentTime;
        video.src = item.videoUrl;
        video.load();
        if (prevTime > 0) {
          try { video.currentTime = prevTime; } catch (_) {}
        }
        if (wasPlaying && element.dataset.index == this.currentIndex) {
          video.play().catch(() => {});
        }
      }

      if (video) {
        this.wireScrubber(element, video);
      }
    } else if (item.embedUrl) {
      wrapper.innerHTML = `
        <iframe class="media-element redgifs-iframe" src="${item.embedUrl}" allow="autoplay; fullscreen" loading="lazy"></iframe>
      `;
    }
  }

  getSoundIconSvg(muted) {
    if (muted) {
      return `<svg viewBox="0 0 24 24"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27l4.73 4.73H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>`;
    }
    return `<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`;
  }

  preloadAhead(currentIndex, count = 2) {
    for (let i = currentIndex + 1; i <= currentIndex + count && i < this.items.length; i++) {
      const item = this.items[i];
      if (!item) continue;

      const imgUrl = item.imageUrl || item.thumbnailUrl;
      if (imgUrl) {
        const img = new Image();
        img.src = imgUrl;
      }
    }
  }

  async loadInitialFeed(filter = {}) {
    this.subreddit = filter.subreddit || "";
    this.user = filter.user || "";
    this.sort = filter.sort || (this.user ? "new" : (this.subreddit ? "hot" : "best"));
    this.timeFilter = filter.timeFilter || "day";
    this.after = null;
    this.items = [];
    this.renderedElements.clear();
    this.container.innerHTML = "";
    this.currentIndex = -1;
    this.hasMore = true;

    await this.loadMore();
  }

  async loadMore() {
    if (this.isLoading || !this.hasMore) return;
    this.isLoading = true;
    this.onStatusUpdate({ isLoading: true });

    try {
      const targetLabel = this.user ? `u/${this.user}` : (this.subreddit ? `r/${this.subreddit}` : "home");
      this.onDebugLog(`Fetching Reddit feed (${targetLabel}/${this.sort})...`);

      const res = await fetchFeed({
        subreddit: this.subreddit,
        user: this.user,
        sort: this.sort,
        t: this.timeFilter,
        after: this.after
      });

      let currentAfter = res.after;
      if (!currentAfter) {
        this.hasMore = false;
      }
      this.after = currentAfter;

      this.onDebugLog(`Fetched ${res.rawCount} raw posts, classifying media...`);

      // Filter valid media posts
      const isMediaItem = (item) => Boolean(
        item.videoUrl ||
        item.embedUrl ||
        item.imageUrl ||
        (item.images && item.images.length > 0) ||
        item.cachedVideoUrl ||
        item.redgifsId ||
        item.isText
      );

      let allCandidates = res.items.filter(isMediaItem);
      let freshCandidates = allCandidates.filter((item) => !this.seenPostIds.has(item.id));

      // Auto-paginate up to 3 batches if seen filter leaves fewer than 15 items
      let pagePulls = 0;
      while (freshCandidates.length < 15 && currentAfter && pagePulls < 3) {
        pagePulls++;
        this.onDebugLog(`Filtered ${allCandidates.length - freshCandidates.length} seen posts. Auto-fetching page ${pagePulls + 1}...`);
        const nextRes = await fetchFeed({
          subreddit: this.subreddit,
          user: this.user,
          sort: this.sort,
          t: this.timeFilter,
          after: currentAfter
        });
        currentAfter = nextRes.after;
        this.after = currentAfter;
        if (!currentAfter) {
          this.hasMore = false;
        }
        const nextMedia = nextRes.items.filter(isMediaItem);
        allCandidates.push(...nextMedia);
        const nextFresh = nextMedia.filter((item) => !this.seenPostIds.has(item.id));
        freshCandidates.push(...nextFresh);
      }

      // If user has viewed all available posts, fallback to allCandidates so feed is never blank
      const itemsToRender = freshCandidates.length > 0 ? freshCandidates : allCandidates;
      if (freshCandidates.length === 0 && allCandidates.length > 0) {
        this.onStatusUpdate({ toast: "Caught up on all new reels! Showing latest." });
      }

      const newEntries = [];
      for (const item of itemsToRender) {
        const el = this.appendItem(item);
        newEntries.push({ item, el });
      }

      this.onDebugLog(`Total loaded reels: ${this.items.length} (${freshCandidates.length} fresh unseen)`);
      if (this.items.length > 0) {
        this.onStatusUpdate({ clearError: true });
      } else if (this.user && this.items.length === 0) {
        this.onStatusUpdate({
          error: `No public media posts found for <strong>u/${this.user}</strong>. The user may be deleted, suspended, or has no submitted posts.`
        });
      }

      // Non-blocking background resolution for Redgifs
      this.resolveRedgifsInBackground(newEntries);

    } catch (err) {
      console.error("Failed to load feed:", err);
      this.onStatusUpdate({ error: err.message });
      this.onDebugLog(`Feed fetch error: ${err.message}`);
    } finally {
      this.isLoading = false;
      this.onStatusUpdate({ isLoading: false });
    }
  }

  async resolveRedgifsInBackground(entries) {
    for (const { item, el } of entries) {
      if (!item.needsResolution) continue;

      try {
        this.onDebugLog(`[Background] Resolving Redgifs: ${item.originalUrl}`);
        const resolvePromise = bridge.resolveRedgifs(item.originalUrl);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Redgifs bridge timeout")), 3500)
        );
        const resolved = await Promise.race([resolvePromise, timeoutPromise]);

        if (resolved?.videoUrl) {
          this.onDebugLog(`[Background] Redgifs resolved: HD video ready`);
          item.videoUrl = resolved.videoUrl;
          item.thumbnailUrl = resolved.thumbnailUrl || item.thumbnailUrl;
          item.sourceType = "redgifs_direct";
          item.hasAudio = resolved.hasAudio !== false;
          item.isIspFallback = false;
          item.needsResolution = false;
          this.updateReelMedia(el, item);
        } else if (item.cachedVideoUrl) {
          item.videoUrl = item.cachedVideoUrl;
          item.hlsUrl = null;
          item.sourceType = "reddit_cache";
          item.isIspFallback = true;
          item.hasAudio = false;
          item.needsResolution = false;
          this.updateReelMedia(el, item);
        } else if (resolved?.embedUrl) {
          item.embedUrl = resolved.embedUrl;
          item.sourceType = "redgifs_iframe";
          item.needsResolution = false;
          this.updateReelMedia(el, item);
        }
      } catch (err) {
        this.onDebugLog(`[Background] Redgifs failed (${err.message}). Using fallback.`);
        if (item.cachedVideoUrl) {
          item.videoUrl = item.cachedVideoUrl;
          item.hlsUrl = null;
          item.sourceType = "reddit_cache";
          item.isIspFallback = true;
          item.hasAudio = false;
          item.needsResolution = false;
          this.updateReelMedia(el, item);
        } else if (item.redgifsId) {
          item.embedUrl = `https://www.redgifs.com/ifr/${item.redgifsId}?autoplay=0`;
          item.sourceType = "redgifs_iframe";
          item.needsResolution = false;
          this.updateReelMedia(el, item);
        }
      }
    }
  }

  appendItem(item) {
    const index = this.items.length;
    this.items.push(item);

    const el = document.createElement("div");
    el.className = "feed-item";
    el.dataset.index = index;

    // Ambient background
    const bgUrl = item.imageUrl || item.thumbnailUrl || (item.images && item.images[0]?.url) || "";
    const backdropHtml = bgUrl ? `<div class="item-backdrop" style="background-image: url('${bgUrl}');"></div>` : "";

    // Media element
    let mediaHtml = "";
    if (item.embedUrl && !item.videoUrl) {
      mediaHtml = `
        <iframe class="media-element redgifs-iframe" src="${item.embedUrl}" allow="autoplay; fullscreen" loading="lazy"></iframe>
      `;
    } else if (item.videoUrl) {
      const audioSources = (item.audioCandidates || [])
        .map((src) => `<source src="${src}" type="audio/mp4" />`)
        .join("");

      mediaHtml = `
        <video class="media-element" playsinline loop preload="metadata" ${item.thumbnailUrl ? `poster="${item.thumbnailUrl}"` : ""} ${this.isMuted ? "muted" : ""}></video>
        ${audioSources ? `<audio preload="none">${audioSources}</audio>` : (item.audioUrl ? `<audio src="${item.audioUrl}" preload="none"></audio>` : "")}
        <div class="play-indicator-flash"></div>
      `;
    } else if (item.images && item.images.length > 0) {
      mediaHtml = `
        <div class="gallery-wrapper">
          <div class="gallery-container">
            ${item.images.map((img) => `<div class="gallery-slide"><img class="media-element" src="${img.url}" loading="lazy" /></div>`).join("")}
          </div>
          ${item.images.length > 1 ? `
            <div class="gallery-counter">1 / ${item.images.length}</div>
            <button class="gallery-nav-btn prev hidden" title="Previous Image" aria-label="Previous">
              <svg viewBox="0 0 24 24"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
            </button>
            <button class="gallery-nav-btn next" title="Next Image" aria-label="Next">
              <svg viewBox="0 0 24 24"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
            </button>
            <div class="gallery-dots">
              ${item.images.map((_, i) => `<div class="gallery-dot ${i === 0 ? "active" : ""}" data-slide="${i}"></div>`).join("")}
            </div>
          ` : ""}
        </div>
      `;
    } else if (item.imageUrl) {
      mediaHtml = `
        <img class="media-element" src="${item.imageUrl}" loading="lazy" />
      `;
    } else if (item.isText) {
      mediaHtml = `
        <div class="text-post-wrapper">
          <div class="text-post-card">
            <div class="text-post-meta">
              <span class="subreddit-tag" data-sub="${item.subreddit}">${item.subredditPrefixed}</span>
              <span class="author-tag" data-author="${item.author}">${item.authorPrefixed}</span>
            </div>
            <h2 class="text-post-title">${this.escapeHtml(item.title)}</h2>
            ${item.selfText ? `<div class="text-post-body">${this.renderMarkdownText(item.selfText)}</div>` : ""}
          </div>
        </div>
      `;
    } else if (item.thumbnailUrl) {
      mediaHtml = `
        <img class="media-element" src="${item.thumbnailUrl}" loading="lazy" />
        <div class="play-indicator-flash"></div>
      `;
    }

    el.innerHTML = `
      ${backdropHtml}
      <div class="reel-debug-badge">
        ${this.getDiagnosticBadgeHtml(item)}
      </div>
      <div class="media-wrapper ${item.isText ? "text-wrapper" : ""}">
        ${mediaHtml}
      </div>

      <!-- Action Buttons Column -->
      <div class="action-column">
        <button class="action-btn save-btn ${item.saved ? "saved" : ""}" title="Save Reel">
          <div class="action-icon-circle">
            <svg viewBox="0 0 24 24"><path d="M17 3H7c-1.1 0-1.99.9-1.99 2L5 21l7-3 7 3V5c0-1.1-.9-2-2-2z"/></svg>
          </div>
          <span class="action-label">${item.saved ? "Saved" : "Save"}</span>
        </button>

        <a class="action-btn comments-btn" href="${item.permalink}" target="_blank" title="Reddit Comments">
          <div class="action-icon-circle">
            <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg>
          </div>
          <span class="action-label">${item.commentsFormatted}</span>
        </a>

        ${item.videoUrl ? `
          <button class="action-btn sound-btn" title="Toggle Sound">
            <div class="action-icon-circle">
              ${this.getSoundIconSvg(this.isMuted)}
            </div>
            <span class="action-label">${item.isGif || item.hasAudio === false ? "No Sound" : "Sound"}</span>
          </button>
        ` : ""}

        <button class="action-btn refresh-feed-btn" title="Refresh Feed (Get New Posts)">
          <div class="action-icon-circle refresh-icon-circle">
            <svg viewBox="0 0 24 24"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
          </div>
          <span class="action-label">Refresh</span>
        </button>
      </div>

      <!-- Information Overlay (Visual media only, omitted for text posts) -->
      ${!item.isText ? `
        <div class="item-info-overlay">
          <div class="author-subreddit-row">
            <span class="subreddit-tag" data-sub="${item.subreddit}">${item.subredditPrefixed}</span>
            <span class="author-tag" data-author="${item.author}">${item.authorPrefixed}</span>
          </div>
          <p class="post-title" title="Click to expand">${this.escapeHtml(item.title)}</p>
        </div>
      ` : ""}

      <!-- Interactive Video Scrubber -->
      ${item.videoUrl ? `
        <div class="video-scrubber-container">
          <div class="video-scrubber-track">
            <div class="video-scrubber-buffered"></div>
            <div class="video-scrubber-fill"></div>
            <div class="video-scrubber-thumb"></div>
          </div>
          <div class="video-time-bubble">0:00 / 0:00</div>
        </div>
      ` : ""}
    `;

    // Video element initial configuration
    const video = el.querySelector("video");
    if (video) {
      if (item.videoUrl && !item.hlsUrl) {
        video.src = item.videoUrl;
        video.load();
      } else if (item.hlsUrl && video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = item.hlsUrl;
        video.load();
      }
      // Note: Hls.js for item.hlsUrl is attached on-demand in playMedia() when the reel becomes active
    }

    this.bindItemEvents(el, item, index);
    this.container.appendChild(el);
    this.renderedElements.set(index, el);
    this.observer.observe(el);

    // If this is the very first reel appended, play it!
    if (index === 0) {
      setTimeout(() => {
        this.handleItemVisible(0, el);
      }, 100);
    }

    return el;
  }

  bindItemEvents(el, item, index) {
    const wrapper = el.querySelector(".media-wrapper");
    const video = el.querySelector("video");
    const audio = el.querySelector("audio");
    const soundBtn = el.querySelector(".sound-btn");
    const saveBtn = el.querySelector(".save-btn");
    const subTag = el.querySelector(".subreddit-tag");
    const postTitle = el.querySelector(".post-title");

    // Single click on media toggles Play/Pause
    wrapper?.addEventListener("click", (e) => {
      // Don't trigger if clicked on gallery scroll or buttons
      if (e.target.closest(".gallery-dots") || e.target.closest(".gallery-nav-btn")) return;
      if (item.videoUrl) {
        this.toggleCurrentPlayback();
      }
    });

    // Sound toggle
    soundBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleMute(el);
    });

    // Save prompt (Download vs Save to Reddit)
    saveBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onStatusUpdate({
        openSaveModal: item,
        element: el
      });
    });

    // Refresh feed button
    const refreshBtn = el.querySelector(".refresh-feed-btn");
    refreshBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      const svg = refreshBtn.querySelector("svg");
      if (svg) {
        svg.classList.remove("spin-anim");
        void svg.offsetWidth;
        svg.classList.add("spin-anim");
      }
      this.onStatusUpdate({ refreshFeed: true });
    });

    // Wire video scrubber if video element is present
    if (video) {
      this.wireScrubber(el, video);
    }

    // Click subreddit tags to filter
    const subTags = el.querySelectorAll(".subreddit-tag");
    subTags.forEach((tag) => {
      tag.addEventListener("click", (e) => {
        e.stopPropagation();
        const sub = tag.dataset.sub;
        if (sub) {
          this.onStatusUpdate({ changeSubreddit: sub });
        }
      });
    });

    // Click author tags to view creator profile
    const authorTags = el.querySelectorAll(".author-tag");
    authorTags.forEach((tag) => {
      tag.addEventListener("click", (e) => {
        e.stopPropagation();
        const author = tag.dataset.author || item.author;
        if (author) {
          this.onStatusUpdate({ viewAuthor: author });
        }
      });
    });

    // Expand title toggle
    postTitle?.addEventListener("click", (e) => {
      e.stopPropagation();
      postTitle.classList.toggle("expanded");
    });

    // Reddit audio track sync (backup for direct MP4 stream)
    if (video && audio) {
      video.addEventListener("play", () => {
        if (!this.isMuted) {
          audio.currentTime = video.currentTime;
          audio.play().catch(() => {});
        }
      });
      video.addEventListener("pause", () => {
        audio.pause();
      });
      video.addEventListener("seeking", () => {
        audio.currentTime = video.currentTime;
      });
      video.addEventListener("volumechange", () => {
        audio.muted = video.muted;
        audio.volume = video.volume;
      });
    }

    // Automatic failover if Redgifs stream is blocked by ISP during playback
    if (video) {
      video.addEventListener("error", (e) => {
        if (item.cachedVideoUrl && video.src !== item.cachedVideoUrl) {
          console.warn("[Reelit] Redgifs stream blocked by ISP. Failing over to Reddit cache.", e);
          this.onDebugLog(`ISP blocked Redgifs CDN -> Switched to Reddit cache: #${index}`);
          this.onStatusUpdate({ toast: "Redgifs blocked by ISP: playing Reddit preview" });
          item.sourceType = "reddit_cache";
          item.isIspFallback = true;
          item.hasAudio = false;
          this.updateItemBadge(el, item);
          video.src = item.cachedVideoUrl;
          video.load();
          video.play().catch(() => {});
        }
      });
    }

    // Gallery interactive controls: prev/next buttons, counter, clickable dots, and mouse drag
    const galleryContainer = el.querySelector(".gallery-container");
    const prevBtn = el.querySelector(".gallery-nav-btn.prev");
    const nextBtn = el.querySelector(".gallery-nav-btn.next");
    const counter = el.querySelector(".gallery-counter");
    const dots = el.querySelectorAll(".gallery-dot");

    if (galleryContainer && item.images?.length > 1) {
      const totalSlides = item.images.length;
      let currentSlide = 0;

      const updateGalleryState = (index) => {
        currentSlide = Math.max(0, Math.min(index, totalSlides - 1));
        if (counter) {
          counter.textContent = `${currentSlide + 1} / ${totalSlides}`;
        }
        dots.forEach((dot, i) => {
          dot.classList.toggle("active", i === currentSlide);
        });
        if (prevBtn) {
          prevBtn.classList.toggle("hidden", currentSlide === 0);
        }
        if (nextBtn) {
          nextBtn.classList.toggle("hidden", currentSlide === totalSlides - 1);
        }
      };

      galleryContainer.addEventListener("scroll", () => {
        const width = galleryContainer.clientWidth || 1;
        const index = Math.round(galleryContainer.scrollLeft / width);
        updateGalleryState(index);
      });

      prevBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        const width = galleryContainer.clientWidth;
        galleryContainer.scrollBy({ left: -width, behavior: "smooth" });
      });

      nextBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        const width = galleryContainer.clientWidth;
        galleryContainer.scrollBy({ left: width, behavior: "smooth" });
      });

      dots.forEach((dot) => {
        dot.addEventListener("click", (e) => {
          e.stopPropagation();
          const slideIdx = parseInt(dot.dataset.slide, 10);
          if (!isNaN(slideIdx)) {
            const width = galleryContainer.clientWidth;
            galleryContainer.scrollTo({ left: slideIdx * width, behavior: "smooth" });
          }
        });
      });

      // Mouse drag to scroll horizontally
      let isDown = false;
      let startX = 0;
      let scrollLeft = 0;

      galleryContainer.addEventListener("mousedown", (e) => {
        isDown = true;
        startX = e.pageX - galleryContainer.offsetLeft;
        scrollLeft = galleryContainer.scrollLeft;
      });

      window.addEventListener("mouseup", () => {
        isDown = false;
      });

      galleryContainer.addEventListener("mousemove", (e) => {
        if (!isDown) return;
        e.preventDefault();
        const x = e.pageX - galleryContainer.offsetLeft;
        const walk = (x - startX) * 1.5;
        galleryContainer.scrollLeft = scrollLeft - walk;
      });
    }
  }

  triggerHeartBurst(x, y, container) {
    const heart = document.createElement("div");
    heart.className = "like-heart-burst";
    heart.style.left = `${x}px`;
    heart.style.top = `${y}px`;
    heart.innerHTML = `<svg width="72" height="72" viewBox="0 0 24 24" fill="#ff4500"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`;
    container.appendChild(heart);
    setTimeout(() => heart.remove(), 800);
  }

  wireScrubber(el, video) {
    if (!el || !video) return;
    let scrubberContainer = el.querySelector(".video-scrubber-container");
    if (!scrubberContainer) {
      scrubberContainer = document.createElement("div");
      scrubberContainer.className = "video-scrubber-container";
      scrubberContainer.innerHTML = `
        <div class="video-scrubber-track">
          <div class="video-scrubber-buffered"></div>
          <div class="video-scrubber-fill"></div>
          <div class="video-scrubber-thumb"></div>
        </div>
        <div class="video-time-bubble">0:00 / 0:00</div>
      `;
      el.appendChild(scrubberContainer);
    }

    const scrubberTrack = scrubberContainer.querySelector(".video-scrubber-track");
    const scrubberFill = scrubberContainer.querySelector(".video-scrubber-fill");
    const scrubberBuffered = scrubberContainer.querySelector(".video-scrubber-buffered");
    const scrubberThumb = scrubberContainer.querySelector(".video-scrubber-thumb");
    const timeBubble = scrubberContainer.querySelector(".video-time-bubble");

    if (!scrubberTrack || scrubberTrack._wired) return;
    scrubberTrack._wired = true;

    let isDragging = false;

    const formatTime = (sec) => {
      if (isNaN(sec) || !isFinite(sec)) return "0:00";
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return `${m}:${s < 10 ? "0" : ""}${s}`;
    };

    const updateProgress = () => {
      if (isDragging || !video.duration) return;
      const pct = (video.currentTime / video.duration) * 100;
      if (scrubberFill) scrubberFill.style.width = `${pct}%`;
      if (scrubberThumb) scrubberThumb.style.left = `${pct}%`;
      if (timeBubble) {
        timeBubble.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
      }
    };

    const updateBuffer = () => {
      if (!video.duration || video.buffered.length === 0) return;
      try {
        const bufEnd = video.buffered.end(video.buffered.length - 1);
        const bufPct = Math.min(100, (bufEnd / video.duration) * 100);
        if (scrubberBuffered) scrubberBuffered.style.width = `${bufPct}%`;
      } catch (_) {}
    };

    video.addEventListener("timeupdate", updateProgress);
    video.addEventListener("progress", updateBuffer);
    video.addEventListener("loadedmetadata", () => {
      updateProgress();
      updateBuffer();
    });

    const handleSeek = (clientX) => {
      if (!scrubberTrack || !video.duration) return;
      const rect = scrubberTrack.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      video.currentTime = ratio * video.duration;
      if (scrubberFill) scrubberFill.style.width = `${ratio * 100}%`;
      if (scrubberThumb) scrubberThumb.style.left = `${ratio * 100}%`;
      if (timeBubble) {
        timeBubble.textContent = `${formatTime(ratio * video.duration)} / ${formatTime(video.duration)}`;
      }
    };

    scrubberTrack.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      isDragging = true;
      scrubberContainer.classList.add("scrubbing");
      handleSeek(e.clientX);

      const onMouseMove = (moveEvent) => {
        if (!isDragging) return;
        moveEvent.preventDefault();
        handleSeek(moveEvent.clientX);
      };

      const onMouseUp = () => {
        if (isDragging) {
          isDragging = false;
          scrubberContainer.classList.remove("scrubbing");
        }
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    });

    scrubberTrack.addEventListener("touchstart", (e) => {
      e.stopPropagation();
      isDragging = true;
      scrubberContainer.classList.add("scrubbing");
      if (e.touches[0]) handleSeek(e.touches[0].clientX);
    }, { passive: true });

    scrubberTrack.addEventListener("touchmove", (e) => {
      if (isDragging && e.touches[0]) {
        handleSeek(e.touches[0].clientX);
      }
    }, { passive: true });

    scrubberTrack.addEventListener("touchend", (e) => {
      e.stopPropagation();
      isDragging = false;
      scrubberContainer.classList.remove("scrubbing");
    });
  }

  renderMarkdownText(text) {
    if (!text) return "";
    let clean = this.escapeHtml(text);
    // Bold: **text**
    clean = clean.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
    // Italic: *text*
    clean = clean.replace(/\*(.*?)\*/g, "<em>$1</em>");
    // Paragraph breaks
    clean = clean.replace(/\n\n+/g, "</p><p>");
    // Single line breaks
    clean = clean.replace(/\n/g, "<br/>");
    return `<p>${clean}</p>`;
  }

  escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  getSeenCount() {
    return this.seenPostIds ? this.seenPostIds.size : 0;
  }

  clearSeenHistory() {
    if (this.seenPostIds) {
      this.seenPostIds.clear();
      saveStoredSeenIds(this.seenPostIds);
    }
    this.onStatusUpdate({ seenCount: 0, toast: "Seen history cleared! 🧹" });
  }

  async refreshFeed() {
    this.onStatusUpdate({ toast: "Fetching fresh reels... 🔄" });
    await this.loadInitialFeed({
      subreddit: this.subreddit,
      user: this.user,
      sort: this.sort,
      timeFilter: this.timeFilter
    });
  }
}
