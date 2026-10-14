// Reddit Reels Application Entrypoint
import bridge from './bridge.js';
import { FeedController } from './feed.js';
import {
  checkRedditSession,
  searchSubreddits,
  isTargetJoined,
  setTargetJoined,
  checkSubredditSubscription,
  checkUserSubscription,
  syncUserSubscriptions
} from './reddit.js';

// DOM Elements
const feedContainer = document.getElementById("feed");
const loadingScreen = document.getElementById("loading-screen");
const loadingText = document.getElementById("loading-text");
const errorModal = document.getElementById("error-modal");
const errorTitle = document.getElementById("error-title");
const errorDescription = document.getElementById("error-description");
const retryBtn = document.getElementById("retry-btn");

// Feed + sort pill and the one menu
const feedSortBtn = document.getElementById("feed-sort-btn");
const feedSortMenu = document.getElementById("feed-sort-menu");
const pillFeed = document.getElementById("pill-feed");
const pillSort = document.getElementById("pill-sort");
const menuFeedPanel = document.getElementById("menu-feed-panel");
const timeOptions = document.getElementById("time-options");
const subHeaderJoinBtn = document.getElementById("sub-header-join-btn");
const subHeaderJoinText = document.getElementById("sub-header-join-text");

const subSearchInput = document.getElementById("sub-search-input");
const subSearchClearBtn = document.getElementById("sub-search-clear-btn");
const subSearchHint = document.getElementById("sub-search-hint");
const subSearchResults = document.getElementById("sub-search-results");
const feedRecentSection = document.getElementById("feed-recent-section");
const feedRecentItems = document.getElementById("feed-recent-items");
const feedRecentClearBtn = document.getElementById("feed-recent-clear-btn");

const menuCreatorPanel = document.getElementById("menu-creator-panel");
const creatorBannerName = document.getElementById("creator-banner-name");
const creatorBackBtn = document.getElementById("creator-back-btn");
const creatorFollowBtn = document.getElementById("creator-follow-btn");
const creatorFollowText = document.getElementById("creator-follow-text");

const moreSheet = document.getElementById("more-sheet");
const moreSheetClose = document.getElementById("more-sheet-close");
const moreCommentsBtn = document.getElementById("more-comments-btn");
const moreCommentsCount = document.getElementById("more-comments-count");
const moreRefreshBtn = document.getElementById("more-refresh-btn");
const moreStatusBtn = document.getElementById("more-status-btn");

// Reelit Logo & Status Popover Elements
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
let moreItem = null;

const SORT_LABELS = {
  best: "Best",
  hot: "Hot",
  new: "New",
  top: "Top",
  rising: "Rising"
};

const TIME_LABELS = {
  hour: "Past hour",
  day: "Today",
  week: "This week",
  month: "This month",
  year: "This year",
  all: "All time"
};

// Debug logging helper (in-memory ring buffer to eliminate DOM writes & reflows while panel is closed)
const MAX_DEBUG_LOGS = 60;
const debugLogBuffer = [];

function renderDebugLogs() {
  if (!debugLogs) return;
  debugLogs.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const line of debugLogBuffer) {
    const entry = document.createElement("div");
    entry.textContent = line;
    frag.appendChild(entry);
  }
  debugLogs.appendChild(frag);
  if (debugPanel) debugPanel.scrollTop = debugPanel.scrollHeight;
}

function logDebug(message) {
  const time = new Date().toLocaleTimeString();
  const line = `[${time}] ${message}`;
  debugLogBuffer.push(line);
  if (debugLogBuffer.length > MAX_DEBUG_LOGS) {
    debugLogBuffer.shift();
  }
  console.log(`[Reelit] ${message}`);

  // Only touch the DOM if debug panel is open
  if (debugPanel?.classList.contains("open")) {
    const entry = document.createElement("div");
    entry.textContent = line;
    debugLogs?.appendChild(entry);
    while (debugLogs?.children.length > MAX_DEBUG_LOGS) {
      debugLogs.removeChild(debugLogs.firstChild);
    }
    debugPanel.scrollTop = debugPanel.scrollHeight;
  }
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
      saveRecentSubreddit(state.changeSubreddit);
      selectSubreddit(state.changeSubreddit);
    }

    if (state.toggleJoin) {
      handleToggleJoin(state.toggleJoin.target, state.toggleJoin.type);
    }

    if (state.openMore) {
      openMoreSheet(state.openMore);
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

// Overlay History Navigation Stack (Android Hardware / Gesture Back Button Guard)
const overlayStack = [];
let isPoppingOverlay = false;

function pushOverlay(name, closeFn) {
  if (overlayStack.length > 0 && overlayStack[overlayStack.length - 1].name === name) return;
  overlayStack.push({ name, close: closeFn });
  try {
    history.pushState({ reelitOverlay: name }, "");
  } catch (_) {}
}

function dismissOverlay(name) {
  if (isPoppingOverlay) return;
  const idx = overlayStack.findLastIndex((item) => item.name === name);
  if (idx !== -1) {
    overlayStack.splice(idx, 1);
    if (history.state?.reelitOverlay === name) {
      try {
        history.back();
      } catch (_) {}
    }
  }
}

window.addEventListener("popstate", () => {
  if (overlayStack.length > 0) {
    isPoppingOverlay = true;
    const top = overlayStack.pop();
    try {
      top.close();
    } finally {
      isPoppingOverlay = false;
    }
  }
});

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
    pushOverlay("saveModal", closeSaveModal);
  }
}

function closeSaveModal() {
  if (saveModal) saveModal.style.display = "none";
  currentSaveItem = null;
  currentSaveElement = null;
  dismissOverlay("saveModal");
}

saveModalClose?.addEventListener("click", closeSaveModal);
saveModal?.addEventListener("click", (e) => {
  if (e.target === saveModal) closeSaveModal();
});

saveActionDownload?.addEventListener("click", async () => {
  if (!currentSaveItem) return;
  const item = currentSaveItem;
  const downloadUrl = item.hdUrl || item.videoUrl || item.imageUrl || (item.images && item.images[0]?.url) || item.cachedVideoUrl;

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

// Toggle subscription (Join community or Follow profile)
async function handleToggleJoin(target, type = "sub") {
  if (!target) return;
  const clean = String(target).trim().replace(/^\/?(?:r|u)\//i, "");
  const isUser = type === "user";
  const currentlyJoined = isTargetJoined(clean, type);
  const nextJoined = !currentlyJoined;
  const action = nextJoined ? "sub" : "unsub";

  // Optimistic UI updates across feed, creator banner, and header join button
  setTargetJoined(clean, type, nextJoined);
  feedController.updateTargetButtons(clean, type, nextJoined);
  updateCreatorFollowButtonState(clean, nextJoined);
  updateSubHeaderJoinButtonState(clean, nextJoined);

  const displayTarget = isUser ? `u/${clean}` : `r/${clean}`;
  if (nextJoined) {
    showToast(`Joined ${displayTarget}! ✓`);
  } else {
    showToast(`Left ${displayTarget}`);
  }

  try {
    await bridge.subscribeTarget(clean, type, action);
    logDebug(`Reddit subscription ${action} succeeded for ${displayTarget}`);
  } catch (err) {
    console.warn(`Failed to ${action} ${displayTarget}:`, err);
    // Rollback state on error
    setTargetJoined(clean, type, currentlyJoined);
    feedController.updateTargetButtons(clean, type, currentlyJoined);
    updateCreatorFollowButtonState(clean, currentlyJoined);
    updateSubHeaderJoinButtonState(clean, currentlyJoined);
    showToast(`Failed to ${action === "sub" ? "join" : "leave"} ${displayTarget}: ${err.message}`);
  }
}

function updateCreatorFollowButtonState(author, joined) {
  if (!currentAuthor) return;
  const cleanAuthor = currentAuthor.trim().toLowerCase().replace(/^u\//, "");
  const cleanTarget = (author || "").trim().toLowerCase().replace(/^u\//, "");
  if (cleanAuthor === cleanTarget && creatorFollowBtn) {
    creatorFollowBtn.classList.toggle("joined", joined);
    if (creatorFollowText) {
      creatorFollowText.textContent = joined ? "Following ✓" : "+ Follow";
    }
    creatorFollowBtn.title = joined ? "Unfollow creator" : "Follow creator";
  }
}

function updateSubHeaderJoinButtonState(subreddit, joined) {
  if (!subHeaderJoinBtn || !subHeaderJoinText) return;
  if (!currentSubreddit || currentAuthor) {
    subHeaderJoinBtn.hidden = true;
    return;
  }
  const cleanCurrent = currentSubreddit.trim().toLowerCase().replace(/^r\//, "");
  const cleanTarget = (subreddit || "").trim().toLowerCase().replace(/^r\//, "");
  if (cleanCurrent === cleanTarget) {
    subHeaderJoinBtn.hidden = false;
    subHeaderJoinBtn.classList.toggle("joined", joined);
    subHeaderJoinText.textContent = joined ? "Joined ✓" : "+ Join";
    subHeaderJoinBtn.title = joined ? "Leave community" : "Join community";
  }
}

subHeaderJoinBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  if (currentSubreddit) {
    handleToggleJoin(currentSubreddit, "sub");
  }
});

function closeFeedSortMenu() {
  if (!feedSortMenu) return;
  feedSortMenu.hidden = true;
  feedSortBtn?.classList.remove("open");
  feedSortBtn?.setAttribute("aria-expanded", "false");
  dismissOverlay("feedSortMenu");
}

function openFeedSortMenu() {
  if (!feedSortMenu) return;
  closeStatusPopover();
  closeMoreSheet();
  feedSortMenu.hidden = false;
  feedSortBtn?.classList.add("open");
  feedSortBtn?.setAttribute("aria-expanded", "true");
  pushOverlay("feedSortMenu", closeFeedSortMenu);
}

function toggleFeedSortMenu() {
  if (feedSortMenu && !feedSortMenu.hidden) closeFeedSortMenu();
  else openFeedSortMenu();
}

function closeAllDropdowns() {
  closeFeedSortMenu();
}

function closeStatusPopover() {
  if (statusPopover) statusPopover.style.display = "none";
  dismissOverlay("statusPopover");
}

function openStatusPopover() {
  if (!statusPopover) return;
  closeAllDropdowns();
  closeMoreSheet();
  updatePopoverStats();
  statusPopover.style.display = "flex";
  pushOverlay("statusPopover", closeStatusPopover);
}

function toggleStatusPopover() {
  if (!statusPopover) return;
  if (statusPopover.style.display === "none" || !statusPopover.style.display) {
    openStatusPopover();
  } else {
    closeStatusPopover();
  }
}

function openMoreSheet(item) {
  if (!item || !moreSheet) return;
  moreItem = item;
  closeFeedSortMenu();
  closeStatusPopover();
  if (moreCommentsCount) {
    moreCommentsCount.textContent = item.commentsFormatted || "0";
  }
  moreSheet.hidden = false;
  pushOverlay("moreSheet", closeMoreSheet);
}

function closeMoreSheet() {
  if (moreSheet) moreSheet.hidden = true;
  moreItem = null;
  dismissOverlay("moreSheet");
}

function toggleDebugPanel() {
  if (!debugPanel) return;
  const willOpen = !debugPanel.classList.contains("open");
  debugPanel.classList.toggle("open");
  if (willOpen) {
    renderDebugLogs();
    pushOverlay("debugPanel", closeDebugPanel);
  } else {
    dismissOverlay("debugPanel");
  }
}

function closeDebugPanel() {
  if (!debugPanel) return;
  debugPanel.classList.remove("open");
  dismissOverlay("debugPanel");
}

// Outside click closes the menu, the status popover, and the More sheet.
// No backdrop inside #feed: a layer there would eat swipes.
document.addEventListener("click", (e) => {
  if (!e.target.closest("#feed-sort-menu") && !e.target.closest("#feed-sort-btn")) {
    closeFeedSortMenu();
  }
  if (
    !e.target.closest("#status-popover") &&
    !e.target.closest("#brand-logo-btn") &&
    !e.target.closest("#more-status-btn")
  ) {
    closeStatusPopover();
  }
  if (!e.target.closest("#more-sheet") && !e.target.closest(".more-btn")) {
    closeMoreSheet();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeStatusPopover();
    closeDebugPanel();
    closeAllDropdowns();
    closeMoreSheet();
  }
});

feedSortBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleFeedSortMenu();
});

function loadFeedNow() {
  hideError();
  feedController.loadInitialFeed({
    user: currentAuthor,
    subreddit: currentAuthor ? "" : currentSubreddit,
    sort: currentSort,
    timeFilter: currentTime
  });
}

function chooseSort(newSort) {
  if (!newSort) return;
  if (newSort === "top") {
    setSortSelection("top");
    return;
  }
  setSortSelection(newSort);
  closeAllDropdowns();
  loadFeedNow();
}

function chooseTime(newTime) {
  if (!newTime) return;
  markTimeSelection(newTime);
  currentSort = "top";
  setSortSelection("top");
  closeAllDropdowns();
  loadFeedNow();
}

feedSortMenu?.addEventListener("click", (e) => {
  const sortRow = e.target.closest(".sort-row");
  if (sortRow && feedSortMenu.contains(sortRow)) {
    chooseSort(sortRow.dataset.value);
    return;
  }
  const timeChip = e.target.closest(".time-chip");
  if (timeChip && feedSortMenu.contains(timeChip)) {
    chooseTime(timeChip.dataset.value);
    return;
  }
  const feedRow = e.target.closest("[data-feed]");
  if (feedRow && feedSortMenu.contains(feedRow)) {
    selectSubreddit(feedRow.dataset.feed || "");
  }
});

// Recent Subreddits Storage
const RECENT_SUBS_KEY = "reelit_recent_subreddits_v1";

function loadRecentSubreddits() {
  try {
    const raw = localStorage.getItem(RECENT_SUBS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr;
    }
  } catch (_) {}
  return [];
}

function clearRecentSubreddits() {
  try {
    localStorage.removeItem(RECENT_SUBS_KEY);
  } catch (_) {}
  renderRecentSubreddits();
  renderSearchRecentView();
  showToast("Recent searches cleared 🧹");
}

function removeRecentSubreddit(name) {
  if (!name) return;
  const clean = name.trim().toLowerCase().replace(/^r\//i, "");
  let list = loadRecentSubreddits().filter((s) => s.toLowerCase() !== clean);
  try {
    localStorage.setItem(RECENT_SUBS_KEY, JSON.stringify(list));
  } catch (_) {}
  renderRecentSubreddits();
  renderSearchRecentView();
}

function saveRecentSubreddit(name) {
  if (!name || !name.trim()) return;
  const clean = name.trim().replace(/^r\//i, "");
  let list = loadRecentSubreddits().filter((s) => s.toLowerCase() !== clean.toLowerCase());
  list.unshift(clean);
  if (list.length > 5) list = list.slice(0, 5);
  try {
    localStorage.setItem(RECENT_SUBS_KEY, JSON.stringify(list));
  } catch (_) {}
  renderRecentSubreddits();
}

function renderRecentSubreddits() {
  if (!feedRecentSection || !feedRecentItems) return;
  const list = loadRecentSubreddits();
  if (list.length === 0) {
    feedRecentSection.hidden = true;
    feedRecentItems.innerHTML = "";
    return;
  }
  feedRecentSection.hidden = false;
  feedRecentItems.innerHTML = "";
  list.forEach((subName) => {
    const item = document.createElement("div");
    item.className = `menu-row recent-sub-item ${currentSubreddit.toLowerCase() === subName.toLowerCase() ? "active" : ""}`;
    item.dataset.value = subName;
    item.innerHTML = `
      <div class="recent-sub-left">
        <span class="search-result-icon" style="width: 18px; height: 18px; font-size: 0.58rem;">r/</span>
        <span class="recent-sub-name">r/${subName}</span>
      </div>
      <button class="recent-remove-btn" type="button" title="Remove r/${subName}">&times;</button>
    `;
    item.addEventListener("click", (e) => {
      if (e.target.closest(".recent-remove-btn")) return;
      selectSubreddit(subName);
    });
    const removeBtn = item.querySelector(".recent-remove-btn");
    removeBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      removeRecentSubreddit(subName);
    });
    feedRecentItems.appendChild(item);
  });
}

feedRecentClearBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  clearRecentSubreddits();
});

// Render recent searches view inside search mode dropdown
function renderSearchRecentView() {
  if (subSearchHint) subSearchHint.hidden = true;
  if (subSearchResults) subSearchResults.innerHTML = "";
  renderRecentSubreddits();
}

// Subreddit Search UI Handlers
let searchDebounceTimer = null;
let currentSearchQuery = "";

function closeSubredditSearch() {
  if (subSearchInput) subSearchInput.value = "";
  if (subSearchClearBtn) subSearchClearBtn.hidden = true;
  if (subSearchHint) subSearchHint.hidden = true;
  if (subSearchResults) subSearchResults.innerHTML = "";
  renderRecentSubreddits();
}

subSearchClearBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  if (subSearchInput) {
    subSearchInput.value = "";
    subSearchInput.focus();
  }
  if (subSearchClearBtn) subSearchClearBtn.hidden = true;
  renderSearchRecentView();
});

subSearchInput?.addEventListener("input", (e) => {
  const query = e.target.value.trim().replace(/^r\//i, "");
  currentSearchQuery = query;

  if (subSearchClearBtn) {
    subSearchClearBtn.hidden = !query;
  }

  clearTimeout(searchDebounceTimer);

  if (!query) {
    renderSearchRecentView();
    return;
  }

  if (subSearchHint) {
    subSearchHint.textContent = `Searching communities for "${query}"... ⏳`;
    subSearchHint.hidden = false;
  }

  searchDebounceTimer = setTimeout(async () => {
    try {
      const results = await searchSubreddits(query, 8);
      if (currentSearchQuery !== query) return; // Discard stale query response

      if (results.length === 0) {
        if (subSearchHint) {
          subSearchHint.textContent = `No communities found matching "r/${query}". Press Enter to visit anyway.`;
          subSearchHint.hidden = false;
        }
        if (subSearchResults) subSearchResults.innerHTML = "";
        return;
      }

      if (subSearchHint) subSearchHint.hidden = true;
      if (subSearchResults) {
        subSearchResults.innerHTML = "";
        results.forEach((sub) => {
          const item = document.createElement("div");
          item.className = `search-result-item ${currentSubreddit.toLowerCase() === sub.name.toLowerCase() ? "active" : ""}`;
          item.innerHTML = `
            <div class="search-result-info">
              <div class="search-result-icon">
                ${sub.icon ? `<img src="${sub.icon}" onerror="this.remove()" />` : sub.name.substring(0, 1).toUpperCase()}
              </div>
              <div class="search-result-text">
                <div class="search-result-name">${sub.prefixed}</div>
                ${sub.subscribersFormatted ? `<div class="search-result-sub">${sub.subscribersFormatted}</div>` : ""}
              </div>
            </div>
            <div class="search-result-actions">
              ${sub.over18 ? `<span class="search-result-badge">18+</span>` : ""}
            </div>
          `;
          item.addEventListener("click", () => {
            saveRecentSubreddit(sub.name);
            selectSubreddit(sub.name);
          });
          subSearchResults.appendChild(item);
        });
      }
    } catch (err) {
      console.warn("Search error:", err);
      if (subSearchHint) {
        subSearchHint.textContent = `Search failed: ${err.message}`;
        subSearchHint.hidden = false;
      }
    }
  }, 220);
});

subSearchInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const query = subSearchInput.value.trim().replace(/^r\//i, "");
    if (!query) return;

    // If there is an active/first search result item, pick that
    const firstResult = subSearchResults?.querySelector(".search-result-item");
    if (firstResult) {
      firstResult.click();
      return;
    }

    saveRecentSubreddit(query);
    selectSubreddit(query);
  }
});

function markFeedShortcuts() {
  const name = (currentSubreddit || "").trim().toLowerCase();
  menuFeedPanel?.querySelectorAll("[data-feed]").forEach((el) => {
    el.classList.toggle("active", (el.dataset.feed || "").toLowerCase() === name);
  });
}

function showFeedMenuPanel() {
  if (menuCreatorPanel) menuCreatorPanel.hidden = true;
  if (menuFeedPanel) menuFeedPanel.hidden = false;
}

function showCreatorMenuPanel() {
  if (menuFeedPanel) menuFeedPanel.hidden = true;
  if (menuCreatorPanel) menuCreatorPanel.hidden = false;
}

function selectSubreddit(subName) {
  closeAllDropdowns();
  closeSubredditSearch();
  const clean = (subName || "").trim().replace(/^r\//i, "");
  currentSubreddit = clean;
  currentAuthor = "";

  showFeedMenuPanel();
  markFeedShortcuts();

  // Update subreddit join button in the menu
  if (clean) {
    const isJoined = isTargetJoined(clean, "sub");
    updateSubHeaderJoinButtonState(clean, isJoined);
    // Authoritatively check subscription with Reddit API
    checkSubredditSubscription(clean).then((verifiedJoined) => {
      if (currentSubreddit.toLowerCase() === clean.toLowerCase()) {
        updateSubHeaderJoinButtonState(clean, verifiedJoined);
        feedController.updateTargetButtons(clean, "sub", verifiedJoined);
      }
    });
  } else {
    updateSubHeaderJoinButtonState("", false);
  }

  // Update sort dropdown options based on new feed mode (Home vs Subreddit)
  updateSortDropdownOptions();
  renderRecentSubreddits();

  hideError();
  feedController.loadInitialFeed({
    subreddit: currentSubreddit,
    sort: currentSort,
    timeFilter: currentTime
  });
}

function allowedSorts() {
  if (currentAuthor) return ["new", "hot", "top"];
  if (currentSubreddit) return ["hot", "top", "new", "rising"];
  return ["best", "new"];
}

function paintPill() {
  if (pillFeed) {
    if (currentAuthor) pillFeed.textContent = `u/${currentAuthor}`;
    else if (currentSubreddit) pillFeed.textContent = `r/${currentSubreddit}`;
    else pillFeed.textContent = "Home";
  }
  if (pillSort) {
    if (currentSort === "top") {
      pillSort.textContent = `Top · ${TIME_LABELS[currentTime] || "Today"}`;
    } else {
      pillSort.textContent = SORT_LABELS[currentSort] || currentSort;
    }
  }
}

/**
 * Configure visible sort options based on current feed mode:
 * 1. Home (Following): Only 'best' and 'new' (matching Reddit's Following options)
 * 2. Subreddit: 'hot', 'top', 'new', 'rising' (subreddits have no 'best')
 * 3. Creator Profile: 'new', 'hot', 'top'
 */
function updateSortDropdownOptions() {
  const allowed = allowedSorts();
  const rows = feedSortMenu ? Array.from(feedSortMenu.querySelectorAll(".sort-row")) : [];
  rows.forEach((el) => {
    el.hidden = !allowed.includes(el.dataset.value);
  });
  if (feedSortMenu && timeOptions) {
    allowed.forEach((value) => {
      const el = rows.find((row) => row.dataset.value === value);
      if (el) feedSortMenu.insertBefore(el, timeOptions);
    });
  }
  if (!allowed.includes(currentSort)) {
    setSortSelection(allowed[0]);
  } else {
    setSortSelection(currentSort);
  }
}

function setSortSelection(sortValue) {
  currentSort = sortValue;
  feedSortMenu?.querySelectorAll(".sort-row").forEach((el) => {
    el.classList.toggle("active", el.dataset.value === sortValue);
  });
  if (timeOptions) timeOptions.hidden = sortValue !== "top";
  paintPill();
}

function markTimeSelection(value) {
  currentTime = value;
  timeOptions?.querySelectorAll(".time-chip").forEach((el) => {
    el.classList.toggle("active", el.dataset.value === value);
  });
  if (currentSort === "top") paintPill();
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
  updateSubHeaderJoinButtonState("", false);
  showCreatorMenuPanel();
  if (creatorBannerName) creatorBannerName.textContent = `u/${clean}`;
  const isFollowed = isTargetJoined(clean, "user");
  updateCreatorFollowButtonState(clean, isFollowed);
  checkUserSubscription(clean).then((verifiedFollowed) => {
    if (currentAuthor.toLowerCase() === clean.toLowerCase()) {
      updateCreatorFollowButtonState(clean, verifiedFollowed);
    }
  });

  updateSortDropdownOptions();
  closeFeedSortMenu();
  pushOverlay("creatorProfile", closeAuthorProfile);

  hideError();
  feedController.loadInitialFeed({
    user: clean,
    sort: currentSort,
    timeFilter: currentTime
  });
}

function closeAuthorProfile() {
  currentAuthor = "";
  dismissOverlay("creatorProfile");
  showFeedMenuPanel();

  currentSubreddit = previousFeed.subreddit;
  markFeedShortcuts();
  if (currentSubreddit) {
    const isJoined = isTargetJoined(currentSubreddit, "sub");
    updateSubHeaderJoinButtonState(currentSubreddit, isJoined);
    checkSubredditSubscription(currentSubreddit).then((verifiedJoined) => {
      if (currentSubreddit.toLowerCase() === previousFeed.subreddit.toLowerCase()) {
        updateSubHeaderJoinButtonState(currentSubreddit, verifiedJoined);
        feedController.updateTargetButtons(currentSubreddit, "sub", verifiedJoined);
      }
    });
  } else {
    updateSubHeaderJoinButtonState("", false);
  }

  updateSortDropdownOptions();
  if (allowedSorts().includes(previousFeed.sort)) {
    setSortSelection(previousFeed.sort);
  }
  markTimeSelection(previousFeed.time);

  renderRecentSubreddits();
  closeFeedSortMenu();

  hideError();
  feedController.loadInitialFeed({
    subreddit: currentSubreddit,
    sort: currentSort,
    timeFilter: currentTime
  });
}

creatorBackBtn?.addEventListener("click", closeAuthorProfile);

creatorFollowBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  if (currentAuthor) {
    handleToggleJoin(currentAuthor, "user");
  }
});

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

moreSheetClose?.addEventListener("click", (e) => {
  e.stopPropagation();
  closeMoreSheet();
});

moreCommentsBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  const permalink = moreItem?.permalink;
  if (permalink) {
    window.open(permalink, "_blank", "noopener");
  } else {
    showToast("No comment thread for this post");
  }
  closeMoreSheet();
});

moreRefreshBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  closeMoreSheet();
  feedController.refreshFeed();
});

moreStatusBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  closeMoreSheet();
  openStatusPopover();
});

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
        // Defer subscription sync so it does not compete with initial video streaming & decoder startup
        const deferSync = () => {
          syncUserSubscriptions().then(() => {
            logDebug("User subscriptions synchronized from Reddit.");
            if (currentSubreddit) {
              const isJoined = isTargetJoined(currentSubreddit, "sub");
              updateSubHeaderJoinButtonState(currentSubreddit, isJoined);
              feedController.updateTargetButtons(currentSubreddit, "sub", isJoined);
            }
          });
        };

        if (typeof window.requestIdleCallback === "function") {
          window.requestIdleCallback(deferSync, { timeout: 4000 });
        } else {
          setTimeout(deferSync, 3500);
        }
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
  if (bridge.isReady()) {
    loadingText.textContent = "Loading reels from Reddit...";
    feedController.loadInitialFeed({
      user: currentAuthor,
      subreddit: currentAuthor ? "" : currentSubreddit,
      sort: currentSort,
      timeFilter: currentTime
    });
    return;
  }
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

// Initial setup
renderRecentSubreddits();
updateSortDropdownOptions();
updatePopoverStats();

logDebug("Reddit Reels web app initialized.");
