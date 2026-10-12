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

// Navigation & Custom Dropdowns
const sortDropdown = document.getElementById("sort-dropdown");
const sortDropdownBtn = document.getElementById("sort-dropdown-btn");
const sortSelectedText = document.getElementById("sort-selected-text");
const sortDropdownMenu = document.getElementById("sort-dropdown-menu");

const timeDropdown = document.getElementById("time-dropdown");
const timeDropdownBtn = document.getElementById("time-dropdown-btn");
const timeSelectedText = document.getElementById("time-selected-text");
const timeDropdownMenu = document.getElementById("time-dropdown-menu");

const feedDropdown = document.getElementById("feed-dropdown");
const feedDropdownBtn = document.getElementById("feed-dropdown-btn");
const feedSelectedText = document.getElementById("feed-selected-text");
const feedDropdownMenu = document.getElementById("feed-dropdown-menu");

const creatorBanner = document.getElementById("creator-banner");
const creatorBannerName = document.getElementById("creator-banner-name");
const creatorBackBtn = document.getElementById("creator-back-btn");

// Reelit Logo & Status Popover Elements
const brandLogoWrapper = document.getElementById("brand-logo-wrapper");
const brandLogoBtn = document.getElementById("brand-logo-btn");
const logoStatusDot = document.getElementById("logo-status-dot");

const statusPopover = document.getElementById("status-popover");
const statusPopoverClose = document.getElementById("status-popover-close");
const popoverBridgeDot = document.getElementById("popover-bridge-dot");
const popoverBridgeText = document.getElementById("popover-bridge-text");
const popoverAccountName = document.getElementById("popover-account-name");
const popoverSeenCount = document.getElementById("popover-seen-count");
const popoverClearSeenBtn = document.getElementById("popover-clear-seen-btn");
const openLogsFromPopover = document.getElementById("open-logs-from-popover");

// Toast & Debug Elements
const audioToast = document.getElementById("audio-toast");
const audioToastText = document.getElementById("audio-toast-text");
const debugPanel = document.getElementById("debug-panel");
const debugLogs = document.getElementById("debug-logs");
const debugToggleBtn = document.getElementById("debug-toggle-btn");
const closeDebugBtn = document.getElementById("close-debug-btn");

// App State
let currentSubreddit = ""; // "" = Home (Following)
let currentSort = "best";
let currentTime = "day";
let currentAuthor = "";
let previousFeed = { subreddit: "", sort: "best", time: "day" };
let currentSessionInfo = null;

// Debug logging helper
function logDebug(message) {
  const time = new Date().toLocaleTimeString();
  const entry = document.createElement("div");
  entry.textContent = `[${time}] ${message}`;
  debugLogs?.appendChild(entry);
  if (debugPanel) debugPanel.scrollTop = debugPanel.scrollHeight;
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

    if (state.toggleDebug) {
      toggleDebugPanel();
    }

    if (state.refreshFeed) {
      feedController.refreshFeed();
    }

    if (state.seenCount !== undefined) {
      if (popoverSeenCount) {
        popoverSeenCount.textContent = `${state.seenCount} seen`;
      }
    }

    if (state.changeSubreddit) {
      selectSubreddit(state.changeSubreddit);
    }
  },
  onDebugLog: (msg) => logDebug(msg)
});

// Update Popover & Status Dot
function updatePopoverStats() {
  if (popoverSeenCount) {
    popoverSeenCount.textContent = `${feedController.getSeenCount()} seen`;
  }
}

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

// Dropdown Management
const allDropdowns = [sortDropdown, timeDropdown, feedDropdown].filter(Boolean);

function closeAllDropdowns() {
  allDropdowns.forEach((dd) => dd.classList.remove("open"));
}

function closeStatusPopover() {
  if (statusPopover) statusPopover.style.display = "none";
}

function toggleStatusPopover() {
  if (!statusPopover) return;
  closeAllDropdowns();
  if (statusPopover.style.display === "none" || !statusPopover.style.display) {
    updatePopoverStats();
    statusPopover.style.display = "flex";
  } else {
    statusPopover.style.display = "none";
  }
}

function toggleDebugPanel() {
  if (!debugPanel) return;
  debugPanel.classList.toggle("open");
}

function closeDebugPanel() {
  if (!debugPanel) return;
  debugPanel.classList.remove("open");
}

// Global click-outside listener
document.addEventListener("click", (e) => {
  if (!e.target.closest(".custom-dropdown")) {
    closeAllDropdowns();
  }
  if (!e.target.closest("#status-popover") && !e.target.closest("#brand-logo-wrapper")) {
    closeStatusPopover();
  }
});

// ESC key closes popover or debug panel
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeStatusPopover();
    closeDebugPanel();
    closeAllDropdowns();
  }
});

function toggleDropdown(dropdownEl) {
  if (!dropdownEl) return;
  const isOpen = dropdownEl.classList.contains("open");
  closeAllDropdowns();
  closeStatusPopover();
  if (!isOpen) {
    dropdownEl.classList.add("open");
  }
}

sortDropdownBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleDropdown(sortDropdown);
});

timeDropdownBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleDropdown(timeDropdown);
});

feedDropdownBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleDropdown(feedDropdown);
});

// Sort Dropdown Selection Handler
sortDropdownMenu?.addEventListener("click", (e) => {
  const item = e.target.closest(".dropdown-item");
  if (!item) return;

  const newSort = item.dataset.value;
  if (!newSort) return;

  // Update active styling
  sortDropdownMenu.querySelectorAll(".dropdown-item").forEach((el) => el.classList.remove("active"));
  item.classList.add("active");
  if (sortSelectedText) sortSelectedText.textContent = item.textContent.trim();

  closeAllDropdowns();

  if (newSort === "top") {
    // Top sort reveals and opens timeframe dropdown so user chooses time range first
    currentSort = "top";
    if (timeDropdown) {
      timeDropdown.style.display = "inline-flex";
      setTimeout(() => {
        timeDropdown.classList.add("open");
      }, 50);
    }
    return;
  }

  // Any other sort hides timeframe dropdown and triggers immediate feed reload
  if (timeDropdown) {
    timeDropdown.style.display = "none";
  }
  currentSort = newSort;

  hideError();
  feedController.loadInitialFeed({
    user: currentAuthor,
    subreddit: currentAuthor ? "" : currentSubreddit,
    sort: currentSort,
    timeFilter: currentTime
  });
});

// Timeframe Dropdown Selection Handler
timeDropdownMenu?.addEventListener("click", (e) => {
  const item = e.target.closest(".dropdown-item");
  if (!item) return;

  const newTime = item.dataset.value;
  if (!newTime) return;

  timeDropdownMenu.querySelectorAll(".dropdown-item").forEach((el) => el.classList.remove("active"));
  item.classList.add("active");
  if (timeSelectedText) timeSelectedText.textContent = item.textContent.trim();

  currentTime = newTime;
  closeAllDropdowns();

  hideError();
  // Triggers Top sort feed load with chosen timeframe
  feedController.loadInitialFeed({
    user: currentAuthor,
    subreddit: currentAuthor ? "" : currentSubreddit,
    sort: "top",
    timeFilter: currentTime
  });
});

// Subreddit Dropdown Selection Handler
feedDropdownMenu?.addEventListener("click", (e) => {
  const item = e.target.closest(".dropdown-item");
  if (!item) return;

  let val = item.dataset.value;

  if (val === "custom") {
    closeAllDropdowns();
    const custom = prompt("Enter subreddit name (e.g. 'damnthatsinteresting' or 'aww'):");
    if (!custom || !custom.trim()) return;

    const clean = custom.trim().replace(/^r\//i, "");
    selectSubreddit(clean);
    return;
  }

  selectSubreddit(val);
});

function selectSubreddit(subName) {
  closeAllDropdowns();
  const clean = (subName || "").trim().replace(/^r\//i, "");
  currentSubreddit = clean;
  currentAuthor = "";

  if (creatorBanner) creatorBanner.style.display = "none";
  if (feedDropdown) feedDropdown.style.display = "inline-flex";

  // Check if item exists in feed dropdown menu, or create it
  let matchingItem = null;
  feedDropdownMenu?.querySelectorAll(".dropdown-item").forEach((el) => {
    el.classList.remove("active");
    if (el.dataset.value && el.dataset.value.toLowerCase() === clean.toLowerCase()) {
      matchingItem = el;
    } else if (!clean && el.dataset.value === "") {
      matchingItem = el;
    }
  });

  if (!matchingItem && clean) {
    matchingItem = document.createElement("div");
    matchingItem.className = "dropdown-item";
    matchingItem.dataset.value = clean;
    matchingItem.textContent = `r/${clean}`;
    const divider = feedDropdownMenu?.querySelector(".dropdown-divider");
    if (divider) {
      feedDropdownMenu.insertBefore(matchingItem, divider);
    } else if (feedDropdownMenu) {
      feedDropdownMenu.appendChild(matchingItem);
    }
  }

  if (matchingItem) {
    matchingItem.classList.add("active");
    if (feedSelectedText) feedSelectedText.textContent = matchingItem.textContent.trim();
  } else if (feedSelectedText) {
    feedSelectedText.textContent = clean ? `r/${clean}` : "Home (Your Feed)";
  }

  // Update sort dropdown options based on new feed mode (Home vs Subreddit)
  updateSortDropdownOptions();

  hideError();
  feedController.loadInitialFeed({
    subreddit: currentSubreddit,
    sort: currentSort,
    timeFilter: currentTime
  });
}

/**
 * Configure visible sort options based on current feed mode:
 * 1. Home (Following): Only 'best' and 'new' (matching Reddit's Following options)
 * 2. Subreddit: 'hot', 'top', 'new', 'rising' (subreddits have no 'best')
 * 3. Creator Profile: 'new', 'hot', 'top'
 */
function updateSortDropdownOptions() {
  if (!sortDropdownMenu) return;

  if (currentAuthor) {
    // Creator profile mode
    sortDropdownMenu.querySelectorAll(".dropdown-item").forEach((el) => {
      const isSupported = ["new", "hot", "top"].includes(el.dataset.value);
      el.style.display = isSupported ? "" : "none";
    });
    if (currentSort === "best" || currentSort === "rising") {
      setSortSelection("new");
    } else {
      setSortSelection(currentSort);
    }
  } else if (currentSubreddit) {
    // Subreddit feed mode
    sortDropdownMenu.querySelectorAll(".dropdown-item").forEach((el) => {
      const isSupported = ["hot", "top", "new", "rising"].includes(el.dataset.value);
      el.style.display = isSupported ? "" : "none";
    });
    if (currentSort === "best") {
      setSortSelection("hot");
    } else {
      setSortSelection(currentSort);
    }
  } else {
    // Home feed (Following) mode: only Best and New!
    sortDropdownMenu.querySelectorAll(".dropdown-item").forEach((el) => {
      const isSupported = ["best", "new"].includes(el.dataset.value);
      el.style.display = isSupported ? "" : "none";
    });
    if (currentSort !== "best" && currentSort !== "new") {
      setSortSelection("best");
    } else {
      setSortSelection(currentSort);
    }
  }
}

function setSortSelection(sortValue) {
  currentSort = sortValue;
  if (!sortDropdownMenu) return;

  sortDropdownMenu.querySelectorAll(".dropdown-item").forEach((el) => {
    const isTarget = el.dataset.value === sortValue;
    el.classList.toggle("active", isTarget);
    if (isTarget && sortSelectedText) {
      sortSelectedText.textContent = el.textContent.trim();
    }
  });

  if (timeDropdown) {
    timeDropdown.style.display = sortValue === "top" ? "inline-flex" : "none";
  }
}

// Creator Profile Navigation
function openAuthorProfile(author) {
  if (!author) return;
  const clean = author.replace(/^u\//i, "");

  if (!currentAuthor) {
    previousFeed = {
      subreddit: currentSubreddit,
      sort: currentSort,
      time: currentTime
    };
  }

  currentAuthor = clean;
  if (creatorBanner && creatorBannerName) {
    creatorBanner.style.display = "flex";
    creatorBannerName.textContent = `u/${clean}`;
  }
  if (feedDropdown) {
    feedDropdown.style.display = "none";
  }

  updateSortDropdownOptions();

  hideError();
  feedController.loadInitialFeed({
    user: clean,
    sort: currentSort,
    timeFilter: currentTime
  });
}

function closeAuthorProfile() {
  currentAuthor = "";
  if (creatorBanner) {
    creatorBanner.style.display = "none";
  }
  if (feedDropdown) {
    feedDropdown.style.display = "inline-flex";
  }

  currentSubreddit = previousFeed.subreddit;
  updateSortDropdownOptions();
  setSortSelection(previousFeed.sort);

  if (timeDropdownMenu) {
    timeDropdownMenu.querySelectorAll(".dropdown-item").forEach((el) => {
      const isTarget = el.dataset.value === previousFeed.time;
      el.classList.toggle("active", isTarget);
      if (isTarget && timeSelectedText) {
        timeSelectedText.textContent = el.textContent.trim();
      }
    });
  }
  currentTime = previousFeed.time;

  // Update feed dropdown active item
  feedDropdownMenu?.querySelectorAll(".dropdown-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.value === currentSubreddit);
    if (el.dataset.value === currentSubreddit && feedSelectedText) {
      feedSelectedText.textContent = el.textContent.trim();
    }
  });

  hideError();
  feedController.loadInitialFeed({
    subreddit: currentSubreddit,
    sort: currentSort,
    timeFilter: currentTime
  });
}

creatorBackBtn?.addEventListener("click", closeAuthorProfile);

// Show error modal
function showError(title, desc) {
  loadingScreen.style.display = "none";
  errorModal.style.display = "flex";
  errorTitle.textContent = title;
  errorDescription.innerHTML = desc;
}

// Hide error modal
function hideError() {
  errorModal.style.display = "none";
}

// Reelit Logo Button: Toggles status popover, or closes logs if open
brandLogoBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  // If debug logs panel is currently open, pressing logo closes it!
  if (debugPanel?.classList.contains("open")) {
    closeDebugPanel();
    return;
  }
  toggleStatusPopover();
});

statusPopoverClose?.addEventListener("click", closeStatusPopover);

openLogsFromPopover?.addEventListener("click", () => {
  closeStatusPopover();
  toggleDebugPanel();
});

popoverClearSeenBtn?.addEventListener("click", () => {
  feedController.clearSeenHistory();
  if (popoverSeenCount) popoverSeenCount.textContent = "0 seen";
});

// Bridge status listener
bridge.onStatusChange((status, details) => {
  logDebug(`Bridge status changed: ${status}`);

  const ver = details?.version || "1.3.0";

  if (status === "connected") {
    hideError();

    if (logoStatusDot) {
      logoStatusDot.className = "logo-status-dot connected";
    }
    if (popoverBridgeDot) {
      popoverBridgeDot.className = "status-indicator connected";
    }
    if (popoverBridgeText) {
      popoverBridgeText.textContent = `v${ver} Connected`;
    }

    // Query session cookies and username from background script
    checkRedditSession().then((session) => {
      currentSessionInfo = session;
      if (popoverAccountName) {
        popoverAccountName.textContent = session?.username || (session?.loggedIn ? "Logged In" : "Guest Mode");
      }
      if (session?.loggedIn) {
        logDebug(`Reddit session: Logged in as ${session.username || "user"} (${session.cookieCount} cookies detected). Bridge version: v${ver}`);
      } else {
        logDebug(`Reddit session: Guest mode. Bridge version: v${ver}`);
      }
    });

    // If feed hasn't been loaded yet, initialize
    if (feedController.items.length === 0 && !feedController.isLoading) {
      logDebug("Extension ready. Initializing Reddit feed...");
      updateSortDropdownOptions();
      feedController.loadInitialFeed({
        subreddit: currentSubreddit,
        sort: currentSort,
        timeFilter: currentTime
      });
    }
  } else if (status === "disconnected") {
    if (logoStatusDot) {
      logoStatusDot.className = "logo-status-dot error";
    }
    if (popoverBridgeDot) {
      popoverBridgeDot.className = "status-indicator error";
    }
    if (popoverBridgeText) {
      popoverBridgeText.textContent = "Disconnected";
    }

    showError(
      "Chrome Extension Not Found",
      "The <strong>Reddit Reels Bridge</strong> extension must be loaded unpacked in your browser.<br/><br/>" +
      "1. Open <code>chrome://extensions</code><br/>" +
      "2. Enable <strong>Developer mode</strong> (top right toggle)<br/>" +
      "3. Click <strong>Load unpacked</strong> and select the <code>extension</code> folder<br/>" +
      "4. Refresh this page."
    );
  } else {
    if (logoStatusDot) {
      logoStatusDot.className = "logo-status-dot";
    }
    if (popoverBridgeDot) {
      popoverBridgeDot.className = "status-indicator";
    }
    if (popoverBridgeText) {
      popoverBridgeText.textContent = "Connecting...";
    }
  }
});

retryBtn?.addEventListener("click", () => {
  hideError();
  loadingScreen.style.display = "flex";
  loadingText.textContent = "Re-checking extension bridge...";
  bridge.startHandshake();
});

// Debug panel controls
debugToggleBtn?.addEventListener("click", () => {
  toggleDebugPanel();
});

closeDebugBtn?.addEventListener("click", () => {
  closeDebugPanel();
});

// Initial sort dropdown options setup
updateSortDropdownOptions();
updatePopoverStats();

logDebug("Reddit Reels web app initialized.");
