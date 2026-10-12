// Reddit Reels Application Entrypoint
import bridge from './bridge.js';
import { FeedController } from './feed.js';
import { checkRedditSession } from './reddit.js';

// DOM Elements
const feedContainer = document.getElementById("feed");
const loadingScreen = document.getElementById("loading-screen");
const loadingText = document.getElementById("loading-text");
const errorModal = document.getElementById("error-modal");
const errorTitle = document.getElementById("error-title");
const errorDescription = document.getElementById("error-description");
const retryBtn = document.getElementById("retry-btn");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const feedSelect = document.getElementById("feed-select");
const sortSelect = document.getElementById("sort-select");
const timeSelect = document.getElementById("time-select");
const timeSelectorPill = document.getElementById("time-selector-pill");
const feedSelectorPill = document.getElementById("feed-selector-pill");
const creatorBanner = document.getElementById("creator-banner");
const creatorBannerName = document.getElementById("creator-banner-name");
const creatorBackBtn = document.getElementById("creator-back-btn");
const audioToast = document.getElementById("audio-toast");
const audioToastText = document.getElementById("audio-toast-text");
const debugPanel = document.getElementById("debug-panel");
const debugLogs = document.getElementById("debug-logs");
const debugToggleBtn = document.getElementById("debug-toggle-btn");
const closeDebugBtn = document.getElementById("close-debug-btn");
const statusPill = document.getElementById("status-pill");

let previousFeed = { subreddit: "", sort: "best", time: "day" };
let currentAuthor = "";

// Debug logging helper
function logDebug(message) {
  const time = new Date().toLocaleTimeString();
  const entry = document.createElement("div");
  entry.textContent = `[${time}] ${message}`;
  debugLogs.appendChild(entry);
  debugPanel.scrollTop = debugPanel.scrollHeight;
  console.log(`[Reelit] ${message}`);
}

// Show toast message
let toastTimer = null;
function showToast(message) {
  if (!audioToast || !audioToastText) return;
  audioToastText.textContent = message;
  audioToast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    audioToast.classList.remove("show");
  }, 1800);
}

// Initialize Feed Controller
const feedController = new FeedController({
  container: feedContainer,
  onStatusUpdate: (state) => {
    if (state.isLoading !== undefined) {
      if (state.isLoading && feedController.items.length === 0) {
        loadingScreen.style.display = "flex";
        loadingText.textContent = "Loading reels from Reddit...";
      } else {
        loadingScreen.style.display = "none";
      }
    }

    if (state.error) {
      showError("Reddit Feed Error", state.error);
    }

    if (state.clearError) {
      hideError();
      statusDot.className = "status-indicator connected";
    }

    if (state.isMuted !== undefined) {
      showToast(state.isMuted ? "Sound Off 🔇" : "Sound On 🔊");
    }

    if (state.toast) {
      showToast(state.toast);
    }

    if (state.openSaveModal) {
      openSaveModal(state.openSaveModal, state.element);
    }

    if (state.viewAuthor) {
      openAuthorProfile(state.viewAuthor);
    }

    if (state.changeSubreddit) {
      feedSelect.value = state.changeSubreddit;
      // If not in standard list, add it
      if (!feedSelect.value) {
        const opt = document.createElement("option");
        opt.value = state.changeSubreddit;
        opt.textContent = `r/${state.changeSubreddit}`;
        feedSelect.insertBefore(opt, feedSelect.lastElementChild);
        feedSelect.value = state.changeSubreddit;
      }
      if (sortSelect.value === "best") {
        sortSelect.value = "hot";
      }
      currentAuthor = "";
      if (creatorBanner) creatorBanner.style.display = "none";
      if (feedSelectorPill) feedSelectorPill.style.display = "flex";
      feedController.loadInitialFeed({
        subreddit: state.changeSubreddit,
        sort: sortSelect.value,
        timeFilter: timeSelect ? timeSelect.value : "day"
      });
    }
  },
  onDebugLog: (msg) => logDebug(msg)
});

// Save Modal Elements & Interaction
const saveModal = document.getElementById("save-modal");
const saveModalClose = document.getElementById("save-modal-close");
const saveModalTitle = document.getElementById("save-modal-post-title");
const saveActionDownload = document.getElementById("save-action-download");
const saveActionReddit = document.getElementById("save-action-reddit");
const saveRedditHeading = document.getElementById("save-reddit-btn-heading");
const saveRedditSub = document.getElementById("save-reddit-btn-sub");
const saveDownloadSub = document.getElementById("save-download-sub");

let currentSaveItem = null;
let currentSaveElement = null;

function openSaveModal(item, element) {
  if (!item) return;
  currentSaveItem = item;
  currentSaveElement = element;

  if (saveModalTitle) {
    saveModalTitle.textContent = item.title || "Untitled Reel";
  }

  if (saveRedditHeading && saveRedditSub) {
    if (item.saved) {
      saveRedditHeading.textContent = "Unsave from Reddit";
      saveRedditSub.textContent = "Remove bookmark from your Reddit account";
    } else {
      saveRedditHeading.textContent = "Save to Reddit Account";
      saveRedditSub.textContent = "Bookmark this post on your Reddit profile";
    }
  }

  if (saveDownloadSub) {
    if (item.videoUrl) {
      saveDownloadSub.textContent = "Save MP4 video directly to Downloads folder";
    } else if (item.imageUrl || (item.images && item.images.length > 0)) {
      saveDownloadSub.textContent = "Save image directly to Downloads folder";
    } else {
      saveDownloadSub.textContent = "Download media to device";
    }
  }

  if (saveModal) {
    saveModal.style.display = "flex";
  }
}

function closeSaveModal() {
  if (saveModal) saveModal.style.display = "none";
  currentSaveItem = null;
  currentSaveElement = null;
}

saveModalClose?.addEventListener("click", closeSaveModal);
saveModal?.addEventListener("click", (e) => {
  if (e.target === saveModal) closeSaveModal();
});

saveActionDownload?.addEventListener("click", async () => {
  if (!currentSaveItem) return;
  const item = currentSaveItem;
  const downloadUrl = item.videoUrl || item.imageUrl || (item.images && item.images[0]?.url) || item.cachedVideoUrl;

  if (!downloadUrl) {
    showToast("No downloadable media URL available");
    closeSaveModal();
    return;
  }

  closeSaveModal();
  showToast("Downloading media... 📥");

  try {
    const res = await bridge.downloadMedia(downloadUrl, item.title || `reelit_${item.id}`);
    if (res?.success) {
      showToast(`Downloaded: ${res.filename} 📥`);
    } else if (res?.fallbackUrl) {
      const a = document.createElement("a");
      a.href = res.fallbackUrl;
      a.download = res.filename || "reelit_video.mp4";
      a.target = "_blank";
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast("Download started 📥");
    }
  } catch (err) {
    console.warn("Direct download failed, falling back to open URL:", err);
    window.open(downloadUrl, "_blank");
  }
});

saveActionReddit?.addEventListener("click", async () => {
  if (!currentSaveItem) return;
  const item = currentSaveItem;
  const el = currentSaveElement;
  const wasSaved = !!item.saved;

  closeSaveModal();
  showToast(wasSaved ? "Removing from Reddit... ⏳" : "Saving to Reddit... ⏳");

  try {
    const res = await bridge.saveToReddit(item.name || item.id, wasSaved);
    if (res?.success) {
      item.saved = !wasSaved;
      if (el) {
        const btn = el.querySelector(".save-btn");
        if (btn) {
          btn.classList.toggle("saved", item.saved);
          const label = btn.querySelector(".action-label");
          if (label) label.textContent = item.saved ? "Saved" : "Save";
        }
      }
      showToast(item.saved ? "Saved to your Reddit account! 🔖" : "Removed from saved posts 🗑️");
    }
  } catch (err) {
    showToast(`Reddit save failed: ${err.message}`);
  }
});

// Creator Profile Navigation
function openAuthorProfile(author) {
  if (!author) return;
  const clean = author.replace(/^u\//i, "");
  if (!currentAuthor) {
    previousFeed = {
      subreddit: feedSelect.value,
      sort: sortSelect.value,
      time: timeSelect ? timeSelect.value : "day"
    };
  }

  currentAuthor = clean;
  if (creatorBanner && creatorBannerName) {
    creatorBanner.style.display = "flex";
    creatorBannerName.textContent = `u/${clean}`;
  }
  if (feedSelectorPill) {
    feedSelectorPill.style.display = "none";
  }

  // Set sort to 'new' if currently 'best' (since creator profiles don't have 'best')
  if (sortSelect.value === "best") {
    sortSelect.value = "new";
  }

  if (timeSelectorPill) {
    timeSelectorPill.style.display = sortSelect.value === "top" ? "flex" : "none";
  }

  hideError();
  feedController.loadInitialFeed({
    user: clean,
    sort: sortSelect.value,
    timeFilter: timeSelect ? timeSelect.value : "day"
  });
}

function closeAuthorProfile() {
  currentAuthor = "";
  if (creatorBanner) {
    creatorBanner.style.display = "none";
  }
  if (feedSelectorPill) {
    feedSelectorPill.style.display = "flex";
  }

  feedSelect.value = previousFeed.subreddit;
  sortSelect.value = previousFeed.sort;
  if (timeSelect) timeSelect.value = previousFeed.time;
  if (timeSelectorPill) {
    timeSelectorPill.style.display = sortSelect.value === "top" ? "flex" : "none";
  }

  hideError();
  feedController.loadInitialFeed({
    subreddit: previousFeed.subreddit,
    sort: previousFeed.sort,
    timeFilter: previousFeed.time
  });
}

creatorBackBtn?.addEventListener("click", closeAuthorProfile);

// Show error modal
function showError(title, desc) {
  loadingScreen.style.display = "none";
  errorModal.style.display = "flex";
  errorTitle.textContent = title;
  errorDescription.innerHTML = desc;
  statusDot.className = "status-indicator error";
}

// Hide error modal
function hideError() {
  errorModal.style.display = "none";
}

// Bridge status listener
bridge.onStatusChange((status, details) => {
  logDebug(`Bridge status changed: ${status}`);

  if (status === "connected") {
    statusDot.className = "status-indicator connected";
    statusText.textContent = "Connected";
    hideError();

    // Query session cookies from background script
    checkRedditSession().then((session) => {
      const ver = details?.version || "1.1.0";
      if (session?.loggedIn) {
        logDebug(`Reddit session: Logged in (${session.cookieCount} cookies detected). Bridge version: v${ver}`);
        statusText.textContent = `v${ver} • Logged In`;
        statusPill.title = `Bridge v${ver} • Reddit Session: Active & Connected`;
      } else {
        logDebug(`Reddit session: Guest mode. Bridge version: v${ver}`);
        statusText.textContent = `v${ver} • Guest`;
        statusPill.title = `Bridge v${ver} • Reddit Session: Guest`;
      }
    });

    // If feed hasn't been loaded yet, load it now!
    if (feedController.items.length === 0 && !feedController.isLoading) {
      logDebug("Extension ready. Initializing Reddit feed...");
      feedController.loadInitialFeed({
        subreddit: feedSelect.value,
        sort: sortSelect.value,
        timeFilter: timeSelect ? timeSelect.value : "day"
      });
    }
  } else if (status === "disconnected") {
    statusDot.className = "status-indicator error";
    statusText.textContent = "Missing";
    showError(
      "Chrome Extension Not Found",
      "The <strong>Reddit Reels Bridge</strong> extension must be loaded unpacked in your browser.<br/><br/>" +
      "1. Open <code>chrome://extensions</code><br/>" +
      "2. Enable <strong>Developer mode</strong> (top right toggle)<br/>" +
      "3. Click <strong>Load unpacked</strong> and select the <code>extension</code> folder<br/>" +
      "4. Refresh this page."
    );
  } else {
    statusDot.className = "status-indicator";
    statusText.textContent = "Connecting";
  }
});

// Event Listeners for Feed & Sort Controls
feedSelect.addEventListener("change", (e) => {
  hideError();
  let val = e.target.value;
  if (val === "custom") {
    const custom = prompt("Enter subreddit name (e.g. 'damnthatsinteresting' or 'aww'):");
    if (custom && custom.trim()) {
      const clean = custom.trim().replace(/^r\//i, "");
      const opt = document.createElement("option");
      opt.value = clean;
      opt.textContent = `r/${clean}`;
      feedSelect.insertBefore(opt, feedSelect.lastElementChild);
      feedSelect.value = clean;
      val = clean;
    } else {
      feedSelect.value = "";
      val = "";
    }
  }

  // Subreddits don't support 'best' algorithm, switch to 'hot'
  if (val && sortSelect.value === "best") {
    sortSelect.value = "hot";
  } else if (!val && sortSelect.value === "hot") {
    // When returning to home feed, default to 'best'
    sortSelect.value = "best";
  }

  currentAuthor = "";
  if (creatorBanner) creatorBanner.style.display = "none";
  if (feedSelectorPill) feedSelectorPill.style.display = "flex";
  if (timeSelectorPill) {
    timeSelectorPill.style.display = sortSelect.value === "top" ? "flex" : "none";
  }

  feedController.loadInitialFeed({
    subreddit: val,
    sort: sortSelect.value,
    timeFilter: timeSelect ? timeSelect.value : "day"
  });
});

sortSelect.addEventListener("change", (e) => {
  hideError();
  const sortVal = e.target.value;
  if (timeSelectorPill) {
    timeSelectorPill.style.display = sortVal === "top" ? "flex" : "none";
  }
  feedController.loadInitialFeed({
    user: currentAuthor,
    subreddit: currentAuthor ? "" : feedSelect.value,
    sort: sortVal,
    timeFilter: timeSelect ? timeSelect.value : "day"
  });
});

timeSelect?.addEventListener("change", (e) => {
  hideError();
  feedController.loadInitialFeed({
    user: currentAuthor,
    subreddit: currentAuthor ? "" : feedSelect.value,
    sort: sortSelect.value,
    timeFilter: e.target.value
  });
});

retryBtn.addEventListener("click", () => {
  hideError();
  loadingScreen.style.display = "flex";
  loadingText.textContent = "Re-checking extension bridge...";
  bridge.startHandshake();
});

// Debug panel controls
statusPill.addEventListener("click", () => {
  debugPanel.classList.toggle("open");
});

debugToggleBtn.addEventListener("click", () => {
  debugPanel.classList.toggle("open");
});

closeDebugBtn.addEventListener("click", () => {
  debugPanel.classList.remove("open");
});

logDebug("Reddit Reels web app initialized.");
