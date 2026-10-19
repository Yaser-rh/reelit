import bridge from './bridge.js';
import { fetchFeed, isTargetJoined } from './reddit.js';

let HlsModule = null;
async function getHls() {
  if (!HlsModule) {
    try {
      const mod = await import('hls.js/dist/hls.light.min.mjs');
      HlsModule = mod.default || mod;
    } catch (err) {
      console.warn("Failed to dynamically load hls.light:", err);
    }
  }
  return HlsModule;
}

function isHlsSource(url) {
  if (!url) return false;
  const path = String(url).split(/[?#]/)[0];
  return /\.m3u8$/i.test(path);
}

// hls.js attaches a blob: URL. Safari plays the playlist on the element itself.
function isHlsDriving(video) {
  if (!video) return false;
  if (video._hls) return true;
  return isHlsSource(video.currentSrc) || isHlsSource(video.getAttribute("src"));
}

function canPlayNativeHls(video) {
  if (!video || typeof video.canPlayType !== "function") return false;
  const types = [
    video.canPlayType("application/vnd.apple.mpegurl"),
    video.canPlayType("application/x-mpegURL")
  ];
  return types.some((value) => value === "probably" || value === "maybe");
}

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

function scrubberMarkup() {
  return `
    <div class="video-time-row">
      <span class="video-time-current">0:00</span>
      <span class="video-time-duration">0:00</span>
    </div>
    <div class="video-scrubber-track">
      <div class="video-scrubber-buffered"></div>
      <div class="video-scrubber-fill"></div>
      <div class="video-scrubber-thumb"></div>
    </div>
  `;
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
    this.previousIndex = -1;
    this.isMuted = true; // start muted to comply with browser autoplay policies
    this.container.classList.toggle("is-muted", this.isMuted);
    this.isLoading = false;
    this.hasMore = true;
    this.after = null;
    this._feedGen = 0;

    // Viewed reels tracking for dynamic feed freshness & rotation
    this.seenPostIds = getStoredSeenIds();
    this._saveSeenTimer = null;

    // Feed filter parameters
    this.subreddit = "";
    this.user = "";
    this.sort = "best";
    this.timeFilter = "day";

    this._touching = false;
    this._touch = null;
    this._pendingIndex = -1;
    this._feedScrolling = false;
    this._paging = false;
    this._scrollEndTimer = null;
    this._suppressClick = false;

    this.setupIntersectionObserver();
    this.setupKeyboardNavigation();
    this.setupFeedMotion();
  }

  setupIntersectionObserver() {
    this.observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const index = parseInt(entry.target.dataset.index, 10);
          if (isNaN(index)) return;

          if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
            // A swipe commits from scrollend. This path only resumes the
            // reel that is already current after a visibility dip.
            if (this._feedScrolling || this._touching) return;
            if (this.currentIndex === index) {
              this.handleItemVisible(index, entry.target);
            }
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
        if (this.stepGallery(1)) e.preventDefault();
      } else if (e.code === "ArrowLeft" || e.code === "KeyH") {
        if (this.stepGallery(-1)) e.preventDefault();
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
    const base = this.indexFromScroll();
    this.scrollFeedToIndex((base < 0 ? this.currentIndex : base) + 1);
  }

  scrollToPrev() {
    const base = this.indexFromScroll();
    this.scrollFeedToIndex((base < 0 ? this.currentIndex : base) - 1);
  }

  indexFromScroll() {
    const height = this.container.clientHeight || 1;
    const index = Math.round(this.container.scrollTop / height);
    if (this.items.length === 0) return -1;
    return Math.max(0, Math.min(this.items.length - 1, index));
  }

  // overflow:hidden drops an Android fling that would otherwise keep coasting
  // after the finger lifts. The stylesheet value returns when the lock clears.
  cancelScrollAnim(el) {
    if (!el) return;
    el._scrollGen = (el._scrollGen || 0) + 1;
    if (el._scrollAnim) {
      cancelAnimationFrame(el._scrollAnim);
      el._scrollAnim = 0;
    }
    clearTimeout(el._pinTimer);
    el.style.scrollSnapType = "";
    if (el.style.overflow === "hidden") el.style.overflow = "";
  }

  killMomentum(el) {
    if (!el) return;
    this.cancelScrollAnim(el);
    const top = el.scrollTop;
    const left = el.scrollLeft;
    el.style.overflow = "hidden";
    el.scrollTop = top;
    el.scrollLeft = left;
  }

  animateTo(el, { top = null, left = null, duration = 200, onDone = null } = {}) {
    if (!el) return;
    el._scrollGen = (el._scrollGen || 0) + 1;
    const gen = el._scrollGen;
    if (el._scrollAnim) cancelAnimationFrame(el._scrollAnim);
    const startTop = el.scrollTop;
    const startLeft = el.scrollLeft;
    const toTop = top == null ? startTop : top;
    const toLeft = left == null ? startLeft : left;
    const deltaTop = toTop - startTop;
    const deltaLeft = toLeft - startLeft;
    const finish = () => {
      if (el._scrollGen !== gen) return;
      el._scrollAnim = 0;
      if (top != null) el.scrollTop = toTop;
      if (left != null) el.scrollLeft = toLeft;
      el.style.scrollSnapType = "";
      if (el.style.overflow === "hidden") el.style.overflow = "";
      if (top != null) el.scrollTop = toTop;
      if (left != null) el.scrollLeft = toLeft;
      clearTimeout(el._pinTimer);
      el._pinTimer = setTimeout(() => {
        if (el._scrollGen !== gen || el._scrollAnim) return;
        if (top != null) el.scrollTop = toTop;
        if (left != null) el.scrollLeft = toLeft;
      }, 80);
      if (onDone) onDone();
    };
    if (Math.abs(deltaTop) < 1 && Math.abs(deltaLeft) < 1) {
      finish();
      return;
    }
    el.style.scrollSnapType = "none";
    const started = performance.now();
    const step = (now) => {
      if (el._scrollGen !== gen) return;
      const progress = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      if (top != null) el.scrollTop = startTop + deltaTop * eased;
      if (left != null) el.scrollLeft = startLeft + deltaLeft * eased;
      if (progress < 1) {
        el._scrollAnim = requestAnimationFrame(step);
        return;
      }
      finish();
    };
    el._scrollAnim = requestAnimationFrame(step);
  }

  scrollFeedToIndex(index, duration = 200) {
    if (index < 0 || index >= this.items.length) return;
    const el = this.renderedElements.get(index);
    if (!el) return;
    this._paging = true;
    this.killMomentum(this.container);
    this.animateTo(this.container, {
      top: el.offsetTop,
      duration,
      onDone: () => {
        this._paging = false;
        this.finishFeedScroll();
      }
    });
  }

  stepGallery(direction) {
    const currentEl = this.renderedElements.get(this.currentIndex);
    const gallery = currentEl?.querySelector(".gallery-container");
    if (!gallery) return false;
    const width = gallery.clientWidth || 1;
    const slides = gallery.querySelectorAll(".gallery-slide").length;
    if (!slides) return false;
    const index = Math.round(gallery.scrollLeft / width);
    const target = Math.max(0, Math.min(slides - 1, index + direction));
    this.killMomentum(gallery);
    this.animateTo(gallery, {
      left: target * width,
      duration: 200,
      onDone: () => gallery._onScrollSettled?.()
    });
    return true;
  }

  notePendingReel() {
    const index = this.indexFromScroll();
    if (index < 0 || index === this._pendingIndex) return;
    this._pendingIndex = index;
    if (this.currentIndex >= 0 && this.currentIndex !== index) {
      const prev = this.renderedElements.get(this.currentIndex);
      if (prev) this.pauseMedia(prev, { cancelLoad: true });
    }
  }

  scheduleFeedSettle() {
    clearTimeout(this._scrollEndTimer);
    this._scrollEndTimer = setTimeout(() => this.finishFeedScroll(), 160);
  }

  finishFeedScroll() {
    if (this._touching || this._settling || this._paging) return;
    if (this.container._scrollAnim) {
      this.scheduleFeedSettle();
      return;
    }
    const index = this.indexFromScroll();
    const el = this.renderedElements.get(index);
    if (!el || index < 0) {
      this._feedScrolling = false;
      return;
    }
    this._settling = true;
    this._pendingIndex = index;
    try {
      this.handleItemVisible(index, el);
    } finally {
      this._settling = false;
      this._feedScrolling = false;
    }
  }

  touchShouldIgnore(target) {
    if (!target || typeof target.closest !== "function") return false;
    return Boolean(target.closest(
      "button, a, input, textarea, select, .video-scrubber-container, .text-post-card, .gallery-dot"
    ));
  }

  wakeCinema() {
    clearTimeout(this._cinemaTimer);
    const appEl = document.getElementById("app");
    if (appEl?.classList.contains("cinema-mode")) {
      appEl.classList.remove("cinema-mode");
    }
    const currentEl = this.renderedElements.get(this.currentIndex);
    const video = currentEl?.querySelector("video");
    if (video && !video.paused && !video.ended) {
      this.scheduleCinemaHide();
    }
  }

  scheduleCinemaHide() {
    clearTimeout(this._cinemaTimer);
    this._cinemaTimer = setTimeout(() => {
      const currentEl = this.renderedElements.get(this.currentIndex);
      const video = currentEl?.querySelector("video");
      if (!video || video.paused || video.ended) return;

      if (document.querySelector(".video-scrubber-container.scrubbing")) return;

      const menu = document.getElementById("feed-sort-menu");
      if (menu && !menu.hidden) return;

      const sheet = document.getElementById("more-sheet");
      if (sheet && !sheet.hidden) return;

      const popover = document.getElementById("status-popover");
      if (popover && popover.style.display !== "none" && popover.style.display) return;

      const saveModal = document.getElementById("save-modal");
      if (saveModal && saveModal.style.display !== "none" && saveModal.style.display) return;

      const debug = document.getElementById("debug-panel");
      if (debug?.classList.contains("open")) return;

      document.getElementById("app")?.classList.add("cinema-mode");
    }, 3500);
  }

  setupFeedMotion() {
    const feed = this.container;

    const wake = () => this.wakeCinema();
    feed.addEventListener("pointerdown", wake, { passive: true });
    window.addEventListener("mousemove", wake, { passive: true });
    window.addEventListener("keydown", wake, { passive: true });

    feed.addEventListener("scroll", () => {
      this._feedScrolling = true;
      this.wakeCinema();
      this.notePendingReel();
      if (this._touching) return;
      this.scheduleFeedSettle();
    }, { passive: true });

    feed.addEventListener("scrollend", () => {
      if (this._touching) return;
      clearTimeout(this._scrollEndTimer);
      this.finishFeedScroll();
    });

    feed.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      clearTimeout(feed._pinTimer);
      this._touching = true;
      this._paging = false;
      this.cancelScrollAnim(feed);
      this._touch = {
        x: t.clientX,
        y: t.clientY,
        time: performance.now(),
        index: Math.max(0, this.indexFromScroll()),
        ignore: this.touchShouldIgnore(e.target)
      };
      clearTimeout(this._scrollEndTimer);
    }, { passive: true });

    feed.addEventListener("touchend", (e) => {
      const start = this._touch;
      this._touching = false;
      this._touch = null;
      if (!start || start.ignore || e.changedTouches.length !== 1) {
        this.scheduleFeedSettle();
        return;
      }
      const t = e.changedTouches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      // A tap stays a tap. Play/pause is the click that follows.
      // Settle anyway so a swipe animation the finger interrupted still commits.
      if (absX < 12 && absY < 12) {
        this.scheduleFeedSettle();
        return;
      }
      if (absX > absY) {
        this.scheduleFeedSettle();
        return;
      }

      const page = feed.clientHeight || 1;
      const elapsed = performance.now() - start.time;
      const flick = elapsed < 280 && absY > 28;
      const travel = absY > page * 0.18;
      const dir = (flick || travel) ? (dy < 0 ? 1 : -1) : 0;
      const target = Math.max(0, Math.min(this.items.length - 1, start.index + dir));
      this._suppressClick = true;
      setTimeout(() => {
        this._suppressClick = false;
      }, 450);
      this.scrollFeedToIndex(target, dir === 0 ? 120 : 200);
    }, { passive: true });

    feed.addEventListener("touchcancel", () => {
      this._touching = false;
      this._touch = null;
      this.scheduleFeedSettle();
    }, { passive: true });
  }

  handleItemVisible(index, element) {
    // A visibility dip pauses the current reel without changing index.
    // Resume it unless the viewer explicitly tapped pause.
    if (this.currentIndex === index) {
      element.classList.add("is-current");
      const sameItem = this.items[index];
      if (sameItem) this.updateItemBadge(element, sameItem);
      const gallery = element.querySelector(".gallery-container");
      if (gallery) {
        if (gallery._userPaused) return;
        this.syncGallery(element, true);
        return;
      }
      const video = element.querySelector("video");
      if (video?._userPaused) return;
      this.playMedia(element);
      return;
    }
    const prevIndex = this.currentIndex;
    this.previousIndex = prevIndex;
    this.currentIndex = index;

    const isHomeFeed = !this.subreddit && !this.user;
    const currentItem = this.items[index];
    if (isHomeFeed && currentItem && currentItem.id) {
      this.recordSeenItem(currentItem);
    }

    this.onDebugLog(`Active Reel: #${index} - ${currentItem?.title?.substring(0, 30)}...`);

    // O(1) pause previous reel and drop any HLS load still in flight
    if (prevIndex >= 0 && prevIndex !== index) {
      const prevEl = this.renderedElements.get(prevIndex);
      if (prevEl) {
        prevEl.classList.remove("is-current");
        this.pauseMedia(prevEl, { cancelLoad: true });
      }
    }
    element.classList.add("is-current");
    this.wakeCinema();
    if (currentItem) this.updateItemBadge(element, currentItem);

    const activeVideo = element.querySelector(".gallery-container")
      ? null
      : element.querySelector("video");
    if (activeVideo) activeVideo._userPaused = false;

    // Mount and play active reel
    this.mountVideo(index, true);

    // Warm up next reel (1 ahead) with metadata only
    if (index + 1 < this.items.length) {
      this.mountVideo(index + 1, false);
    }

    // Unmount distant reels (> 1 away) to cancel background downloads & free hardware decoders
    this.renderedElements.forEach((el, idx) => {
      if (Math.abs(idx - index) > 1) {
        this.unmountVideo(idx);
      }
    });

    // Deep memory recycling for distant reels (> 6 away): release heavy backdrop textures
    this.renderedElements.forEach((el, idx) => {
      const dist = Math.abs(idx - index);
      const backdrop = el.querySelector(".item-backdrop");
      if (!backdrop) return;
      if (dist > 6) {
        if (backdrop.style.backgroundImage && backdrop.style.backgroundImage !== "none") {
          backdrop.dataset.cachedBg = backdrop.style.backgroundImage;
          backdrop.style.backgroundImage = "none";
        }
      } else if (dist <= 3) {
        if (backdrop.dataset.cachedBg) {
          backdrop.style.backgroundImage = backdrop.dataset.cachedBg;
          delete backdrop.dataset.cachedBg;
        }
      }
    });

    // Priority resolve Redgifs for active and next reel
    this.resolvePriorityRedgifs(index);

    // Preload next 2 image thumbnails
    this.preloadAhead(index, 2);

    // Infinite scroll check: near end
    if (index >= this.items.length - 4 && !this.isLoading && this.hasMore) {
      this.loadMore();
    }
  }

  mountVideo(index, autoPlay = false) {
    const el = this.renderedElements.get(index);
    const item = this.items[index];
    if (!el || !item) return;

    const wrapper = el.querySelector(".media-wrapper");
    if (!wrapper) return;

    if (el.querySelector(".gallery-container")) {
      if (autoPlay) {
        const gallery = el.querySelector(".gallery-container");
        if (gallery) gallery._userPaused = false;
        this.syncGallery(el, true);
      }
      return;
    }

    const hasVideo = Boolean(item.videoUrl || item.hlsUrl || item.cachedVideoUrl);
    if (!hasVideo && !item.redgifsId) return;

    let video = wrapper.querySelector("video");
    if (!video && (item.videoUrl || item.hlsUrl || item.cachedVideoUrl)) {
      const posterAttr = item.thumbnailUrl ? `poster="${item.thumbnailUrl}"` : "";
      const audioSources = (item.audioCandidates || [])
        .map((src) => `<source src="${src}" type="audio/mp4" />`)
        .join("");

      wrapper.innerHTML = `
        <video class="media-element" playsinline loop preload="metadata" ${posterAttr} ${this.isMuted ? "muted" : ""}></video>
        ${audioSources ? `<audio preload="none">${audioSources}</audio>` : (item.audioUrl ? `<audio src="${item.audioUrl}" preload="none"></audio>` : "")}
        <div class="play-indicator-flash"></div>
      `;
      video = wrapper.querySelector("video");
      this.wireScrubber(el, video);
    }

    if (video) {
      if (autoPlay) {
        this.playMedia(el);
      } else {
        // Preload next reel with metadata only (skip for HLS reels so we don't start downloading raw fallback DASH_1080)
        if (!item.hlsUrl && item.videoUrl && (!video.src || video.src !== item.videoUrl)) {
          video.src = item.videoUrl;
          video.preload = "metadata";
        }
      }
    }
  }

  unmountVideo(index) {
    const el = this.renderedElements.get(index);
    if (!el) return;

    this.pauseMedia(el, { cancelLoad: true });

    el.querySelectorAll("video").forEach((video) => {
      if (video._hls) {
        video._hls.destroy();
        video._hls = null;
      }
      if (video.getAttribute("src")) {
        video.removeAttribute("src");
        video.load();
      }
    });

    el.querySelectorAll("audio").forEach((audio) => {
      audio.pause();
    });
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
    // A dip below the visible threshold while this reel is still current
    // only pauses. Cancel the HLS load once another reel has taken over.
    this.pauseMedia(element, { cancelLoad: index !== this.currentIndex });
  }

  assignDirectMp4(video, item) {
    if (!video || !item?.videoUrl) return false;
    if (video._hls) {
      video._hls.destroy();
      video._hls = null;
    }
    video.src = item.videoUrl;
    video.load();
    return true;
  }

  syncSidecar(video, audio) {
    if (!audio || !video) return;
    if (isHlsDriving(video)) {
      if (!audio.paused) audio.pause();
      return;
    }
    audio.volume = 1.0;
    audio.muted = this.isMuted;
    if (!this.isMuted && !video.paused) {
      audio.currentTime = video.currentTime;
      audio.play().catch(() => {});
    }
  }

  async playMedia(element) {
    const gallery = element.querySelector(".gallery-container");
    if (gallery) {
      if (gallery._userPaused) return;
      this.syncGallery(element, true);
      return;
    }

    const video = element.querySelector("video");
    const audio = element.querySelector("audio");
    const index = parseInt(element.dataset.index, 10);
    const item = this.items[index];
    if (!item || !video) return;
    if (video._userPaused) return;

    video.volume = 1.0;
    video.muted = this.isMuted;

    const stillCurrent = () =>
      video.isConnected &&
      parseInt(element.dataset.index, 10) === this.currentIndex &&
      !video._userPaused;

    // On-demand dynamic HLS initialization for Reddit videos
    if (item.hlsUrl) {
      if (video._hls) {
        if (stillCurrent()) {
          video._hls.startLoad();
          video.play().catch(() => {});
          this.scheduleCinemaHide();
        }
        return;
      }

      // A load is already in flight for this reel. Let it finish.
      if (video._hlsAwaiting && video._hlsGen === video._hlsAwaiting && index === this.currentIndex) {
        return;
      }

      const gen = (video._hlsGen || 0) + 1;
      video._hlsGen = gen;
      video._hlsAwaiting = gen;

      const Hls = await getHls();

      // Swiped away, unmounted, or a newer playMedia call owns this element.
      if (video._hlsGen !== gen || !stillCurrent()) {
        if (video._hlsAwaiting === gen) video._hlsAwaiting = 0;
        return;
      }

      if (Hls && Hls.isSupported()) {
        const isSaveData = Boolean(
          navigator.connection?.saveData ||
          navigator.connection?.effectiveType === '2g' ||
          navigator.connection?.effectiveType === '3g'
        );
        const hls = new Hls({
          capLevelToPlayerSize: true,
          maxBufferLength: isSaveData ? 4 : 6,
          maxMaxBufferLength: isSaveData ? 8 : 10,
          enableWorker: true
        });

        if (video.getAttribute("src")) {
          video.removeAttribute("src");
          video.load();
        }

        hls.loadSource(item.hlsUrl);
        hls.attachMedia(video);
        video._hls = hls;
        if (video._hlsAwaiting === gen) video._hlsAwaiting = 0;

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (video._hlsGen !== gen || !stillCurrent()) return;
          const playPromise = video.play();
          this.scheduleCinemaHide();
          if (playPromise !== undefined) {
            playPromise.catch(() => {
              if (!stillCurrent() || this.isMuted) return;
              this.applyAutoplayMute(element);
              video.muted = true;
              video.play().catch(() => {});
            });
          }
        });

        hls.on(Hls.Events.ERROR, (event, data) => {
          if (!data.fatal || video._hlsGen !== gen) return;
          console.warn("HLS fatal error, falling back to direct MP4 videoUrl", data);
          hls.destroy();
          if (video._hls === hls) video._hls = null;
          if (item.videoUrl && stillCurrent() && this.assignDirectMp4(video, item)) {
            video.play().then(() => {
              if (stillCurrent()) {
                this.syncSidecar(video, audio);
                this.scheduleCinemaHide();
              }
            }).catch(() => {});
          }
        });
        return;
      }

      if (video._hlsAwaiting === gen) video._hlsAwaiting = 0;
      if (!stillCurrent()) return;

      // Safari plays HLS itself. Everywhere else, use the Reddit MP4.
      if (canPlayNativeHls(video)) {
        if (video.getAttribute("src") !== item.hlsUrl) {
          video.src = item.hlsUrl;
          video.load();
        }
      } else if (!this.assignDirectMp4(video, item)) {
        return;
      }
    } else if (item.videoUrl && (!video.src || video.src !== item.videoUrl)) {
      video.src = item.videoUrl;
      video.load();
    }

    const playPromise = video.play();
    if (playPromise !== undefined) {
      playPromise.catch((err) => {
        if (!stillCurrent() || this.isMuted) return;
        console.warn("Unmuted autoplay restricted by browser policy, falling back to muted:", err);
        this.applyAutoplayMute(element);
        video.muted = true;
        video.play().catch(() => {});
      });
    }

    // Sidecar audio only for a direct MP4. A playlist already carries the audio.
    this.syncSidecar(video, audio);
    this.scheduleCinemaHide();
  }

  applyAutoplayMute(element) {
    if (this.isMuted) return;
    this.isMuted = true;
    this.container.classList.toggle("is-muted", true);
    const audio = element?.querySelector("audio");
    if (audio) {
      audio.muted = true;
      if (!audio.paused) audio.pause();
    }
    const index = parseInt(element?.dataset.index, 10);
    const item = this.items[index];
    if (item) this.updateItemBadge(element, item);
    this.onStatusUpdate({ isMuted: true });
  }

  pauseMedia(element, { cancelLoad = false } = {}) {
    if (!element) return;
    this.wakeCinema();

    if (element.querySelector(".gallery-container")) {
      this.syncGallery(element, false);
      return;
    }

    const video = element.querySelector("video");
    const audio = element.querySelector("audio");

    if (video) {
      if (cancelLoad) video._hlsGen = (video._hlsGen || 0) + 1;
      if (!video.paused) video.pause();
      if (video._hls) video._hls.stopLoad();
    }
    if (audio && !audio.paused) audio.pause();
  }

  syncGallery(el, shouldPlay) {
    const gallery = el.querySelector(".gallery-container");
    if (!gallery) return;

    const slides = gallery.querySelectorAll(".gallery-slide");
    if (!slides.length) return;

    const width = gallery.clientWidth || 1;
    let current = Math.round(gallery.scrollLeft / width);
    if (!Number.isFinite(current)) current = 0;
    current = Math.max(0, Math.min(slides.length - 1, current));

    const isThisReel = parseInt(el.dataset.index, 10) === this.currentIndex;
    const allowPlay = shouldPlay && isThisReel;

    slides.forEach((slide, sIdx) => {
      const media = slide.querySelector("img, video");
      if (!media) return;

      const near = isThisReel && (sIdx === current || sIdx === current + 1);
      if (near) {
        const pending = media.dataset.src;
        if (pending && media.dataset.loadedSrc !== pending) {
          media.src = pending;
          media.dataset.loadedSrc = pending;
        }
      }

      if (media.tagName !== "VIDEO") return;

      const isCurrent = allowPlay && sIdx === current;
      if (isCurrent) {
        media.play().catch(() => {});
        return;
      }

      media.pause();
      if (near) return;

      // A user pause or a visibility dip keeps the open reel's files.
      // Once another reel is current, drop slides that are not on screen.
      if (isThisReel && !shouldPlay) return;

      // Stop files for slides that are not on screen. The url stays in data-src.
      const attrSrc = media.getAttribute("src");
      if (attrSrc && !media.dataset.src) media.dataset.src = attrSrc;
      if (media.getAttribute("src") || media.currentSrc) {
        media.removeAttribute("src");
        delete media.dataset.loadedSrc;
        media.load();
      }
    });
  }

  toggleCurrentPlayback() {
    const currentEl = this.renderedElements.get(this.currentIndex);
    if (!currentEl) return;

    const flash = currentEl.querySelector(".play-indicator-flash");
    const gallery = currentEl.querySelector(".gallery-container");
    if (gallery) {
      gallery._userPaused = !gallery._userPaused;
      this.syncGallery(currentEl, !gallery._userPaused);
      this.showFlashIcon(flash, gallery._userPaused ? "pause" : "play");
      return;
    }

    const video = currentEl.querySelector("video");
    if (!video) return;

    if (video.paused) {
      video._userPaused = false;
      this.playMedia(currentEl);
      this.showFlashIcon(flash, "play");
    } else {
      video._userPaused = true;
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
    this.container.classList.toggle("is-muted", this.isMuted);

    const currentEl = targetElement || this.renderedElements.get(this.currentIndex);
    const item = this.items[this.currentIndex];

    // Apply to current visible media. Galleries stay muted and are not resumed here.
    if (currentEl && !currentEl.querySelector(".gallery-container")) {
      const video = currentEl.querySelector("video");
      const audio = currentEl.querySelector("audio");

      if (video) {
        video.muted = this.isMuted;
        video.volume = 1.0;
        const isCurrent = currentEl === this.renderedElements.get(this.currentIndex);
        if (!this.isMuted && video.paused && isCurrent) {
          video._userPaused = false;
          this.playMedia(currentEl);
        }
      }

      if (audio) {
        audio.muted = this.isMuted;
        audio.volume = 1.0;
        if (this.isMuted) {
          audio.pause();
        } else if (video && !video.paused && !isHlsDriving(video)) {
          audio.currentTime = video.currentTime;
          audio.play().catch(() => {});
        }
      }

      if (item) {
        this.updateItemBadge(currentEl, item);
      }
    }

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

  getDiagnosticBadgeHtml(item, element) {
    if (!item) return "";
    if (item.isText || item.mediaType === "text") return "Text";
    if (item.isGallery) {
      const slide = element?.dataset.gallerySlide || "1";
      const total = element?.dataset.galleryTotal || String(item.images?.length || 0);
      return `Gallery ${slide}/${total}`;
    }
    if (item.mediaType === "image") return "Image";

    let sourcePrefix = "Video";
    if (item.sourceType === "redgifs_direct") sourcePrefix = "Redgifs HD";
    else if (item.sourceType === "reddit_cache" || item.isIspFallback) sourcePrefix = "Cache";
    else if (item.sourceType === "redgifs_iframe") sourcePrefix = "Redgifs";
    else if (item.sourceType === "redgifs_pending") sourcePrefix = "Resolving";

    let audioSuffix = " · Muted";
    if (item.isGif || item.hasAudio === false) audioSuffix = " · Silent";
    else if (!this.isMuted) audioSuffix = " · Sound";

    return `${sourcePrefix}${audioSuffix}`;
  }

  updateItemBadge(element, item) {
    if (!element || !item) return;
    if (this.renderedElements.get(this.currentIndex) !== element) return;
    const badge = document.getElementById("media-source-badge");
    if (!badge) return;
    badge.textContent = this.getDiagnosticBadgeHtml(item, element);
  }

  updateReelMedia(element, item) {
    if (!element) return;

    this.updateItemBadge(element, item);

    // Ensure sound button is present and updated
    const actionColumn = element.querySelector(".action-column");
    let soundBtn = element.querySelector(".sound-btn");
    if (!soundBtn && actionColumn && (item.videoUrl || item.cachedVideoUrl)) {
      soundBtn = document.createElement("button");
      soundBtn.className = "action-btn sound-btn";
      soundBtn.title = "Toggle Sound";
      soundBtn.innerHTML = `
        <div class="action-icon-circle">
          ${this.getSoundIconSvg()}
        </div>
        <span class="action-label">${item.isGif || item.hasAudio === false ? "No Sound" : "Sound"}</span>
      `;
      soundBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleMute(element);
      });
      actionColumn.insertBefore(soundBtn, actionColumn.firstChild);
      element.classList.add("has-scrubber");
    } else if (soundBtn) {
      const soundLabel = soundBtn.querySelector(".action-label");
      if (soundLabel) {
        soundLabel.textContent = item.isGif || item.hasAudio === false ? "No Sound" : "Sound";
      }
    }

    const wrapper = element.querySelector(".media-wrapper");
    if (!wrapper) return;

    if (item.videoUrl) {
      const idx = parseInt(element.dataset.index, 10);
      if (idx === this.currentIndex || idx === this.currentIndex + 1) {
        this.mountVideo(idx, idx === this.currentIndex);
      }
    } else if (item.embedUrl) {
      wrapper.innerHTML = `
        <iframe class="media-element redgifs-iframe" src="${item.embedUrl}" allow="autoplay; fullscreen" loading="lazy"></iframe>
      `;
    }
  }

  getSoundIconSvg() {
    return `
      <svg class="sound-icon-muted" viewBox="0 0 24 24"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27l4.73 4.73H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>
      <svg class="sound-icon-unmuted" viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
    `;
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
    this._feedGen = (this._feedGen || 0) + 1;
    this.subreddit = filter.subreddit || "";
    this.user = filter.user || "";
    this.sort = filter.sort || (this.user ? "new" : (this.subreddit ? "hot" : "best"));
    this.timeFilter = filter.timeFilter || "day";
    this.after = null;

    // Drop observer entries before the nodes leave the document. Far reel
    // nodes stay mounted during a session. Recycle them only if a long
    // session starts getting the phone killed.
    this.renderedElements.forEach((el, idx) => {
      this.observer.unobserve(el);
      this.unmountVideo(idx);
    });
    this.renderedElements.clear();
    this.items = [];
    this.container.innerHTML = "";
    const headerBadge = document.getElementById("media-source-badge");
    if (headerBadge) headerBadge.textContent = "";
    this.currentIndex = -1;
    this._pendingIndex = -1;
    this._feedScrolling = false;
    this._touching = false;
    this._touch = null;
    this._paging = false;
    clearTimeout(this._scrollEndTimer);
    this.container._scrollGen = (this.container._scrollGen || 0) + 1;
    if (this.container._scrollAnim) {
      cancelAnimationFrame(this.container._scrollAnim);
      this.container._scrollAnim = 0;
    }
    clearTimeout(this.container._pinTimer);
    this.container.style.scrollSnapType = "";
    this.container.style.overflow = "";
    this.hasMore = true;
    // The previous page may still be in flight. Release the lock so this
    // generation can fetch. That older call keeps its own generation and
    // ignores the response.
    this.isLoading = false;

    await this.loadMore();
  }

  async loadMore() {
    if (this.isLoading || !this.hasMore) return;
    const gen = this._feedGen || 0;
    this.isLoading = true;
    this.onStatusUpdate({ isLoading: true });

    try {
      const isInitial = this.items.length === 0;
      const batchLimit = isInitial ? 15 : 25;
      const targetLabel = this.user ? `u/${this.user}` : (this.subreddit ? `r/${this.subreddit}` : "home");
      this.onDebugLog(`Fetching Reddit feed (${targetLabel}/${this.sort}, limit=${batchLimit})...`);

      const res = await fetchFeed({
        subreddit: this.subreddit,
        user: this.user,
        sort: this.sort,
        t: this.timeFilter,
        after: this.after,
        limit: batchLimit
      });

      if (gen !== this._feedGen) return;

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

      const allCandidates = res.items.filter(isMediaItem);
      const isHomeFeed = !this.subreddit && !this.user;
      let itemsToRender = [];

      if (isHomeFeed) {
        // Home Feed Freshness: Filter out seen posts
        const freshCandidates = allCandidates.filter((item) => !this.seenPostIds.has(item.id));

        // Render fresh candidates immediately to achieve instantaneous First Paint!
        if (freshCandidates.length > 0) {
          itemsToRender = freshCandidates;
        } else {
          // If all candidates in this batch were already seen, fallback to allCandidates so feed is never blank
          itemsToRender = allCandidates;
          if (allCandidates.length > 0) {
            this.onStatusUpdate({ toast: "Caught up on recent reels! Showing latest." });
          }
        }
        this.onDebugLog(`Loaded reels: ${itemsToRender.length} (${freshCandidates.length} fresh unseen)`);
      } else {
        // Subreddit feed or Creator Profile: keep all candidates
        itemsToRender = allCandidates;
        this.onDebugLog(`Loaded subreddit/creator reels: ${itemsToRender.length}`);
      }

      for (const item of itemsToRender) {
        this.appendItem(item);
      }

      if (this.items.length > 0) {
        this.onStatusUpdate({ clearError: true });
      } else if (this.user && this.items.length === 0) {
        this.onStatusUpdate({
          error: `No public media posts found for <strong>u/${this.user}</strong>. The user may be deleted, suspended, or has no submitted posts.`
        });
      }

      // Priority resolution: only resolve active and next reel instead of walking the whole page
      this.resolvePriorityRedgifs(this.currentIndex >= 0 ? this.currentIndex : 0);

      // If feed has very few items (e.g. fewer than 5) and more are available, top up seamlessly in the background
      if (this.items.length < 5 && this.hasMore) {
        setTimeout(() => {
          if (gen === this._feedGen && !this.isLoading && this.hasMore) {
            this.loadMore();
          }
        }, 200);
      }

    } catch (err) {
      if (gen !== this._feedGen) return;
      console.error("Failed to load feed:", err);
      this.onStatusUpdate({ error: err.message });
      this.onDebugLog(`Feed fetch error: ${err.message}`);
    } finally {
      if (gen !== this._feedGen) return;
      this.isLoading = false;
      this.onStatusUpdate({ isLoading: false });
    }
  }

  applyResolvedRedgifs(item, resolved) {
    if (resolved?.videoUrl) {
      item.videoUrl = resolved.videoUrl;
      item.hdUrl = resolved.hdUrl || resolved.videoUrl;
      item.sdUrl = resolved.sdUrl || resolved.videoUrl;
      item.thumbnailUrl = resolved.thumbnailUrl || item.thumbnailUrl;
      item.sourceType = "redgifs_direct";
      item.hasAudio = resolved.hasAudio !== false;
      item.isIspFallback = false;
      item.needsResolution = false;
      return;
    }
    if (item.cachedVideoUrl) {
      item.videoUrl = item.cachedVideoUrl;
      item.hlsUrl = null;
      item.sourceType = "reddit_cache";
      item.isIspFallback = true;
      item.hasAudio = false;
      item.needsResolution = false;
      return;
    }
    if (resolved?.embedUrl) {
      item.embedUrl = resolved.embedUrl;
      item.sourceType = "redgifs_iframe";
      item.needsResolution = false;
    }
  }

  async resolvePriorityRedgifs(activeIdx) {
    const queue = [activeIdx, activeIdx + 1].filter(
      (idx) => idx >= 0 && idx < this.items.length && this.items[idx]?.needsResolution
    );

    for (const idx of queue) {
      const item = this.items[idx];
      const el = this.renderedElements.get(idx);
      if (!item || !item.needsResolution || item._isResolving) continue;

      item._isResolving = true;
      // One attempt per post. A timeout keeps the same promise for the late upgrade
      // instead of starting a second resolve when the viewer swipes back.
      item.needsResolution = false;
      let resolvePromise = null;
      try {
        this.onDebugLog(`[Priority] Resolving Redgifs: ${item.originalUrl}`);
        resolvePromise = bridge.resolveRedgifs({
          url: item.originalUrl,
          hasCachedVideo: Boolean(item.cachedVideoUrl)
        });

        let timeoutId = 0;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("Redgifs bridge timeout")), 6500);
        });
        try {
          const resolved = await Promise.race([resolvePromise, timeoutPromise]);
          clearTimeout(timeoutId);
          this.applyResolvedRedgifs(item, resolved);
        } catch (err) {
          clearTimeout(timeoutId);
          throw err;
        }
      } catch (err) {
        this.onDebugLog(`[Priority] Redgifs fallback used: ${err.message}`);
        const timedOut = String(err?.message || err).includes("timeout");
        if (item.cachedVideoUrl) {
          item.videoUrl = item.cachedVideoUrl;
          item.hlsUrl = null;
          item.sourceType = "reddit_cache";
          item.isIspFallback = true;
          item.hasAudio = false;
          item.needsResolution = false;
        } else if (item.redgifsId) {
          item.embedUrl = `https://www.redgifs.com/ifr/${item.redgifsId}?autoplay=0`;
          item.sourceType = "redgifs_iframe";
          item.needsResolution = false;
        }

        if (timedOut && resolvePromise) {
          resolvePromise.then((lateResult) => {
            if (!lateResult?.videoUrl) return;
            if (this.items[idx] !== item || item.sourceType === "redgifs_direct") return;
            if (!el?.isConnected) return;
            this.onDebugLog(`[Priority] Late Redgifs resolved: upgrading #${idx}`);
            this.applyResolvedRedgifs(item, lateResult);
            this.updateReelMedia(el, item);
          }).catch(() => {});
        }
      } finally {
        item._isResolving = false;
        if (el?.isConnected) this.updateReelMedia(el, item);
      }
    }
  }

  appendItem(item, options = {}) {
    const index = this.items.length;
    this.items.push(item);

    const isSubredditMode = Boolean(this.subreddit);
    const isSubJoined = isTargetJoined(item.subreddit, "sub");

    const hasVideo = Boolean(item.videoUrl || item.hlsUrl || item.cachedVideoUrl || item.needsResolution);

    const el = document.createElement("div");
    el.className = hasVideo ? "feed-item has-scrubber" : "feed-item";
    el.dataset.index = index;

    // Ambient background. Gallery backdrops use the still poster, never the GIF file.
    const firstSlide = item.images && item.images[0];
    let slideBg = "";
    if (firstSlide) {
      const poster = firstSlide.posterUrl || "";
      const posterIsGif = /\.gif($|\?)/i.test(poster);
      if (poster && !(firstSlide.mp4Url && posterIsGif)) slideBg = poster;
      else if (!firstSlide.mp4Url) slideBg = firstSlide.url || "";
    }
    const bgUrl = item.thumbnailUrl || item.imageUrl || slideBg || "";
    const backdropHtml = bgUrl ? `<div class="item-backdrop" style="background-image: url('${bgUrl}');"></div>` : "";

    // Media element
    let mediaHtml = "";
    if (item.embedUrl && !item.videoUrl) {
      mediaHtml = `
        <iframe class="media-element redgifs-iframe" src="${item.embedUrl}" allow="autoplay; fullscreen" loading="lazy"></iframe>
      `;
    } else if (hasVideo) {
      const audioSources = (item.audioCandidates || [])
        .map((src) => `<source src="${src}" type="audio/mp4" />`)
        .join("");

      mediaHtml = `
        <video class="media-element" playsinline loop preload="none" ${item.thumbnailUrl ? `poster="${item.thumbnailUrl}"` : ""} ${this.isMuted ? "muted" : ""}></video>
        ${audioSources ? `<audio preload="none">${audioSources}</audio>` : (item.audioUrl ? `<audio src="${item.audioUrl}" preload="none"></audio>` : "")}
        <div class="play-indicator-flash"></div>
      `;
    } else if (item.images && item.images.length > 0) {
      mediaHtml = `
        <div class="gallery-wrapper">
          <div class="gallery-container">
            ${item.images.map((img, i) => {
              if (img.mp4Url) {
                const poster = this.escapeHtml(img.posterUrl && !/\.gif($|\?)/i.test(img.posterUrl) ? img.posterUrl : "");
                return `<div class="gallery-slide" data-slide="${i}">
                  <video class="media-element" playsinline loop muted preload="none" ${poster ? `poster="${poster}"` : ""} data-src="${this.escapeHtml(img.mp4Url)}"></video>
                </div>`;
              } else {
                return `<div class="gallery-slide" data-slide="${i}">
                  <img class="media-element" data-src="${this.escapeHtml(img.url || "")}" alt="" />
                </div>`;
              }
            }).join("")}
          </div>
          ${item.images.length > 1 ? `
            <div class="gallery-counter" hidden>1 / ${item.images.length}</div>
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
          <div class="play-indicator-flash"></div>
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
              <div class="tag-group">
                <span class="subreddit-tag" data-sub="${item.subreddit}">${item.subredditPrefixed}</span>
                ${isSubredditMode ? `
                  <button class="join-btn sub-join-btn ${isSubJoined ? "joined" : ""}" data-target="${item.subreddit}" data-type="sub" type="button" title="${isSubJoined ? "Leave community" : "Join community"}">${isSubJoined ? "Joined ✓" : "+ Join"}</button>
                ` : ""}
              </div>
              ${item.author && item.author !== "[deleted]" ? `
                <div class="tag-group">
                  <span class="author-tag" data-author="${item.author}">${item.authorPrefixed}</span>
                </div>
              ` : ""}
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
      <div class="media-wrapper ${item.isText ? "text-wrapper" : ""}">
        ${mediaHtml}
      </div>

      <!-- Action Buttons Column: Sound, Save, More -->
      <div class="action-column">
        ${hasVideo ? `
          <button class="action-btn sound-btn" title="Toggle Sound" type="button">
            <div class="action-icon-circle">
              ${this.getSoundIconSvg()}
            </div>
            <span class="action-label">${item.isGif || item.hasAudio === false ? "No Sound" : "Sound"}</span>
          </button>
        ` : ""}

        <button class="action-btn save-btn ${item.saved ? "saved" : ""}" title="Save Reel" type="button">
          <div class="action-icon-circle">
            <svg viewBox="0 0 24 24"><path d="M17 3H7c-1.1 0-1.99.9-1.99 2L5 21l7-3 7 3V5c0-1.1-.9-2-2-2z"/></svg>
          </div>
          <span class="action-label">${item.saved ? "Saved" : "Save"}</span>
        </button>

        <button class="action-btn more-btn" title="More" type="button">
          <div class="action-icon-circle">
            <svg viewBox="0 0 24 24"><path d="M6 10a2 2 0 1 0 .001 4.001A2 2 0 0 0 6 10zm6 0a2 2 0 1 0 .001 4.001A2 2 0 0 0 12 10zm6 0a2 2 0 1 0 .001 4.001A2 2 0 0 0 18 10z"/></svg>
          </div>
          <span class="action-label">More</span>
        </button>
      </div>

      <!-- Information Overlay (Visual media only, omitted for text posts) -->
      ${!item.isText ? `
        <div class="item-info-overlay">
          <div class="author-subreddit-row">
            <div class="tag-group">
              <span class="subreddit-tag" data-sub="${item.subreddit}">${item.subredditPrefixed}</span>
              ${isSubredditMode ? `
                <button class="join-btn sub-join-btn ${isSubJoined ? "joined" : ""}" data-target="${item.subreddit}" data-type="sub" type="button" title="${isSubJoined ? "Leave community" : "Join community"}">${isSubJoined ? "Joined ✓" : "+ Join"}</button>
              ` : ""}
            </div>
            ${item.author && item.author !== "[deleted]" ? `
              <div class="tag-group">
                <span class="author-tag" data-author="${item.author}">${item.authorPrefixed}</span>
              </div>
            ` : ""}
          </div>
          <p class="post-title" title="Click to expand">${this.escapeHtml(item.title)}</p>
        </div>
      ` : ""}

      <!-- Interactive Video Scrubber -->
      ${hasVideo ? `
        <div class="video-scrubber-container">
          ${scrubberMarkup()}
        </div>
      ` : ""}
    `;

    this.bindItemEvents(el, item, index);
    this.container.appendChild(el);
    this.renderedElements.set(index, el);
    this.observer.observe(el);

    // If this is the very first reel appended, play it! (unless restoring feed state)
    if (index === 0 && !options.isRestore) {
      setTimeout(() => {
        if (this.currentIndex > 0 || this.indexFromScroll() > 0) return;
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
      if (this._suppressClick) {
        this._suppressClick = false;
        return;
      }
      // Don't trigger if clicked on gallery scroll or buttons
      if (e.target.closest(".gallery-dots") || e.target.closest(".gallery-nav-btn")) return;
      if (el._galleryDragged) {
        el._galleryDragged = false;
        return;
      }
      const gallery = el.querySelector(".gallery-container");
      if (gallery || item.videoUrl || item.hlsUrl) {
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

    const moreBtn = el.querySelector(".more-btn");
    moreBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onStatusUpdate({ openMore: item });
    });

    // Wire video scrubber if this reel has one main video. Gallery slides manage themselves.
    if (video && !el.querySelector(".gallery-container")) {
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

    // Click join/follow buttons to toggle subscription
    const joinBtns = el.querySelectorAll(".join-btn");
    joinBtns.forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const target = btn.dataset.target;
        const type = btn.dataset.type || "sub";
        if (target) {
          this.onStatusUpdate({
            toggleJoin: {
              target,
              type,
              button: btn
            }
          });
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
        this.syncSidecar(video, audio);
      });
      video.addEventListener("pause", () => {
        audio.pause();
      });
      video.addEventListener("seeking", () => {
        if (!isHlsDriving(video)) {
          audio.currentTime = video.currentTime;
        }
      });
      video.addEventListener("volumechange", () => {
        if (!isHlsDriving(video)) {
          audio.muted = video.muted;
          audio.volume = video.volume;
        }
      });
    }

    // Automatic failover if Redgifs stream is blocked by ISP during playback
    // or if a Reddit fallback DASH rendition fails
    if (video) {
      video.addEventListener("error", (e) => {
        // HLS plays from a blob: URL. Its own fatal handler picks the MP4.
        // A media error while HLS is attached must not start that download.
        if (video._hls) return;
        const current = video.currentSrc || "";
        if (!current || current.startsWith("blob:")) return;

        if (item.cachedVideoUrl && current !== item.cachedVideoUrl && video.dataset.fallbackApplied !== item.cachedVideoUrl) {
          console.warn("[Reelit] Redgifs stream blocked by ISP. Failing over to Reddit cache.", e);
          this.onDebugLog(`ISP blocked Redgifs CDN -> Switched to Reddit cache: #${index}`);
          this.onStatusUpdate({ toast: "Redgifs blocked by ISP: playing Reddit preview" });
          item.sourceType = "reddit_cache";
          item.isIspFallback = true;
          item.hasAudio = false;
          this.updateItemBadge(el, item);
          video.dataset.fallbackApplied = item.cachedVideoUrl;
          video.src = item.cachedVideoUrl;
          video.load();
          video.play().catch(() => {});
        } else if (
          item.sourceType === "reddit_video" &&
          item.videoUrl &&
          current !== item.videoUrl &&
          video.dataset.fallbackApplied !== item.videoUrl
        ) {
          console.warn("[Reelit] Reddit DASH video failed, falling back to original MP4", e);
          video.dataset.fallbackApplied = item.videoUrl;
          video.src = item.videoUrl;
          video.load();
          if (parseInt(el.dataset.index, 10) === this.currentIndex && !video._userPaused) {
            video.play().catch(() => {});
          }
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

      const paintGalleryChrome = (slideIndex) => {
        currentSlide = Math.max(0, Math.min(slideIndex, totalSlides - 1));
        el.dataset.gallerySlide = String(currentSlide + 1);
        el.dataset.galleryTotal = String(totalSlides);
        if (counter) {
          counter.textContent = `${currentSlide + 1} / ${totalSlides}`;
        }
        this.updateItemBadge(el, item);
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

      const commitGallery = () => {
        const width = galleryContainer.clientWidth || 1;
        const slideIndex = Math.round(galleryContainer.scrollLeft / width);
        paintGalleryChrome(slideIndex);
        this.syncGallery(el, !galleryContainer._userPaused);
      };
      galleryContainer._onScrollSettled = commitGallery;

      let galleryTouching = false;
      let galleryTouch = null;
      let galleryTimer = null;

      const scheduleGalleryCommit = () => {
        clearTimeout(galleryTimer);
        galleryTimer = setTimeout(commitGallery, 160);
      };

      galleryContainer.addEventListener("scroll", () => {
        const width = galleryContainer.clientWidth || 1;
        const slideIndex = Math.round(galleryContainer.scrollLeft / width);
        paintGalleryChrome(slideIndex);
        if (isDown || galleryTouching || galleryContainer._scrollAnim) return;
        scheduleGalleryCommit();
      }, { passive: true });

      galleryContainer.addEventListener("scrollend", () => {
        if (galleryTouching || galleryContainer._scrollAnim) return;
        clearTimeout(galleryTimer);
        commitGallery();
      });

      const goToSlide = (slideIndex, duration = 200) => {
        const width = galleryContainer.clientWidth || 1;
        const target = Math.max(0, Math.min(totalSlides - 1, slideIndex));
        this.killMomentum(galleryContainer);
        this.animateTo(galleryContainer, {
          left: target * width,
          duration,
          onDone: commitGallery
        });
      };

      galleryContainer.addEventListener("touchstart", (e) => {
        if (e.touches.length !== 1) return;
        if (e.target.closest(".gallery-nav-btn, .gallery-dot")) return;
        const t = e.touches[0];
        clearTimeout(galleryContainer._pinTimer);
        this.cancelScrollAnim(galleryContainer);
        galleryTouching = true;
        galleryTouch = {
          x: t.clientX,
          y: t.clientY,
          time: performance.now(),
          index: Math.round(galleryContainer.scrollLeft / (galleryContainer.clientWidth || 1))
        };
        clearTimeout(galleryTimer);
      }, { passive: true });

      galleryContainer.addEventListener("touchend", (e) => {
        const start = galleryTouch;
        galleryTouching = false;
        galleryTouch = null;
        if (!start || e.changedTouches.length !== 1) {
          scheduleGalleryCommit();
          return;
        }
        const t = e.changedTouches[0];
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        const absX = Math.abs(dx);
        const absY = Math.abs(dy);
        if (absX < 12 && absY < 12) {
          scheduleGalleryCommit();
          return;
        }
        if (absY >= absX) {
          scheduleGalleryCommit();
          return;
        }
        const width = galleryContainer.clientWidth || 1;
        const elapsed = performance.now() - start.time;
        const flick = elapsed < 280 && absX > 28;
        const travel = absX > width * 0.18;
        const dir = (flick || travel) ? (dx < 0 ? 1 : -1) : 0;
        el._galleryDragged = true;
        goToSlide(start.index + dir, dir === 0 ? 120 : 200);
      }, { passive: true });

      galleryContainer.addEventListener("touchcancel", () => {
        galleryTouching = false;
        galleryTouch = null;
        scheduleGalleryCommit();
      }, { passive: true });

      prevBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        goToSlide(currentSlide - 1);
      });

      nextBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        goToSlide(currentSlide + 1);
      });

      dots.forEach((dot) => {
        dot.addEventListener("click", (e) => {
          e.stopPropagation();
          const slideIdx = parseInt(dot.dataset.slide, 10);
          if (!isNaN(slideIdx)) goToSlide(slideIdx);
        });
      });

      // Mouse drag to scroll horizontally. Pointer capture stays on this element,
      // so a feed refresh does not leave a window mouseup listener behind.
      let isDown = false;
      let dragged = false;
      let startX = 0;
      let scrollLeft = 0;

      const endDrag = () => {
        if (dragged) el._galleryDragged = true;
        isDown = false;
        if (dragged) commitGallery();
      };

      galleryContainer.addEventListener("pointerdown", (e) => {
        if (e.pointerType !== "mouse" || e.button !== 0) return;
        el._galleryDragged = false;
        isDown = true;
        dragged = false;
        startX = e.pageX - galleryContainer.offsetLeft;
        scrollLeft = galleryContainer.scrollLeft;
        galleryContainer.setPointerCapture(e.pointerId);
      });

      galleryContainer.addEventListener("pointerup", endDrag);
      galleryContainer.addEventListener("pointercancel", endDrag);

      galleryContainer.addEventListener("pointermove", (e) => {
        if (!isDown || e.pointerType !== "mouse") return;
        e.preventDefault();
        const x = e.pageX - galleryContainer.offsetLeft;
        if (Math.abs(x - startX) > 4) dragged = true;
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
      scrubberContainer.innerHTML = scrubberMarkup();
      el.appendChild(scrubberContainer);
      el.classList.add("has-scrubber");
    }

    const scrubberTrack = scrubberContainer.querySelector(".video-scrubber-track");
    const scrubberFill = scrubberContainer.querySelector(".video-scrubber-fill");
    const scrubberBuffered = scrubberContainer.querySelector(".video-scrubber-buffered");
    const scrubberThumb = scrubberContainer.querySelector(".video-scrubber-thumb");
    const timeCurrent = scrubberContainer.querySelector(".video-time-current");
    const timeDuration = scrubberContainer.querySelector(".video-time-duration");

    if (!scrubberTrack || scrubberTrack._wired) return;
    scrubberTrack._wired = true;

    let isDragging = false;

    const formatTime = (sec) => {
      if (isNaN(sec) || !isFinite(sec)) return "0:00";
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return `${m}:${s < 10 ? "0" : ""}${s}`;
    };

    const playableDuration = () => {
      const duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0) return 0;
      return duration;
    };

    const paint = (ratio, duration) => {
      const clamped = Math.max(0, Math.min(1, ratio));
      if (scrubberFill) scrubberFill.style.transform = `scaleX(${clamped})`;
      if (scrubberThumb) scrubberThumb.style.left = `${clamped * 100}%`;
      if (timeCurrent) timeCurrent.textContent = formatTime(clamped * duration);
      if (timeDuration) timeDuration.textContent = formatTime(duration);
    };

    const updateProgress = () => {
      if (isDragging) return;
      const duration = playableDuration();
      if (!duration) return;
      paint(video.currentTime / duration, duration);
    };

    const updateBuffer = () => {
      const duration = playableDuration();
      if (!duration || video.buffered.length === 0) return;
      try {
        const bufEnd = video.buffered.end(video.buffered.length - 1);
        const bufRatio = Math.max(0, Math.min(1, bufEnd / duration));
        if (scrubberBuffered) scrubberBuffered.style.transform = `scaleX(${bufRatio})`;
      } catch (_) {}
    };

    video.addEventListener("timeupdate", updateProgress);
    video.addEventListener("progress", updateBuffer);
    video.addEventListener("loadedmetadata", () => {
      updateProgress();
      updateBuffer();
    });
    video.addEventListener("durationchange", () => {
      updateProgress();
      updateBuffer();
    });
    video.addEventListener("seeked", updateProgress);

    const handleSeek = (clientX) => {
      const duration = playableDuration();
      if (!scrubberTrack || !duration) return;
      const rect = scrubberTrack.getBoundingClientRect();
      if (!rect.width) return;
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      video.currentTime = ratio * duration;
      paint(ratio, duration);
    };

    const endDrag = () => {
      if (!isDragging) return;
      isDragging = false;
      scrubberContainer.classList.remove("scrubbing");
      updateProgress();
    };

    scrubberContainer.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
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
        endDrag();
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    });

    const onTouchMove = (e) => {
      if (!isDragging || !e.touches[0]) return;
      if (e.cancelable) e.preventDefault();
      handleSeek(e.touches[0].clientX);
    };

    const onTouchEnd = () => {
      endDrag();
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
    };

    scrubberContainer.addEventListener("touchstart", (e) => {
      if (isDragging) return;
      e.stopPropagation();
      isDragging = true;
      scrubberContainer.classList.add("scrubbing");
      if (e.touches[0]) handleSeek(e.touches[0].clientX);
      window.addEventListener("touchmove", onTouchMove, { passive: false });
      window.addEventListener("touchend", onTouchEnd);
      window.addEventListener("touchcancel", onTouchEnd);
    }, { passive: true });
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

  saveFeedState() {
    const idx = this.currentIndex >= 0 ? this.currentIndex : this.indexFromScroll();
    return {
      subreddit: this.subreddit,
      user: this.user,
      sort: this.sort,
      timeFilter: this.timeFilter,
      items: this.items.map((it) => ({ ...it })),
      currentIndex: Math.max(0, Math.min(this.items.length - 1, idx >= 0 ? idx : 0)),
      after: this.after,
      hasMore: this.hasMore
    };
  }

  restoreFeedState(state) {
    if (!state || !Array.isArray(state.items)) return;
    this._feedGen = (this._feedGen || 0) + 1;
    const gen = this._feedGen;

    this.killMomentum(this.container);
    clearTimeout(this._scrollEndTimer);
    clearTimeout(this._cinemaTimer);

    // Unmount and clean up current reels
    this.renderedElements.forEach((el, idx) => {
      this.observer.unobserve(el);
      this.unmountVideo(idx);
    });
    this.renderedElements.clear();
    this.items = [];
    this.container.innerHTML = "";
    const headerBadge = document.getElementById("media-source-badge");
    if (headerBadge) headerBadge.textContent = "";

    this.currentIndex = -1;
    this._pendingIndex = -1;
    this._feedScrolling = false;
    this._touching = false;
    this._touch = null;
    this._paging = false;

    // Restore feed parameters and pagination state
    this.subreddit = state.subreddit || "";
    this.user = state.user || "";
    this.sort = state.sort || (this.user ? "new" : (this.subreddit ? "hot" : "best"));
    this.timeFilter = state.timeFilter || "day";
    this.after = state.after || null;
    this.hasMore = state.hasMore !== false;
    this.isLoading = false;

    // Target reel index to restore to
    const targetIndex = Math.max(0, Math.min(state.items.length - 1, state.currentIndex >= 0 ? state.currentIndex : 0));

    // Append all previous items without auto-playing index 0
    for (const item of state.items) {
      this.appendItem(item, { isRestore: true });
    }

    if (this.items.length > 0) {
      this.onStatusUpdate({ clearError: true });
    }

    // Immediately position viewport on the target reel and resume playback
    const targetEl = this.renderedElements.get(targetIndex);
    if (targetEl) {
      this.container.style.scrollSnapType = "none";
      this.container.scrollTop = targetEl.offsetTop;

      // Settle scroll position and resume playback on next animation frame
      requestAnimationFrame(() => {
        if (this._feedGen !== gen) return;
        this.container.scrollTop = targetEl.offsetTop;
        this.container.style.scrollSnapType = "";
        this.handleItemVisible(targetIndex, targetEl);
      });
    } else if (this.items.length > 0) {
      const firstEl = this.renderedElements.get(0);
      if (firstEl) this.handleItemVisible(0, firstEl);
    }
  }

  updateTargetButtons(target, type, joined) {
    if (!target) return;
    const clean = String(target).trim().toLowerCase().replace(/^(?:r|u)\//, "");
    const allBtns = this.container.querySelectorAll(`.join-btn[data-target][data-type="${type}"]`);
    allBtns.forEach((btn) => {
      const btnTarget = (btn.dataset.target || "").trim().toLowerCase().replace(/^(?:r|u)\//, "");
      if (btnTarget === clean) {
        btn.classList.toggle("joined", joined);
        if (type === "user") {
          btn.textContent = joined ? "Following ✓" : "+ Follow";
          btn.title = joined ? "Unfollow creator" : "Follow creator";
        } else {
          btn.textContent = joined ? "Joined ✓" : "+ Join";
          btn.title = joined ? "Leave community" : "Join community";
        }
      }
    });
  }
}
