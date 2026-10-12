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
const subHeaderJoinBtn = document.getElementById("sub-header-join-btn");
const subHeaderJoinText = document.getElementById("sub-header-join-text");

// Subreddit Search & Menu Elements
const feedMenuMain = document.getElementById("feed-menu-main");
const feedMenuSearch = document.getElementById("feed-menu-search");
const feedOpenSearchBtn = document.getElementById("feed-open-search-btn");
const subSearchBackBtn = document.getElementById("sub-search-back-btn");
const subSearchInput = document.getElementById("sub-search-input");
const subSearchClearBtn = document.getElementById("sub-search-clear-btn");
const subSearchHint = document.getElementById("sub-search-hint");
const subSearchResults = document.getElementById("sub-search-results");
const feedRecentSection = document.getElementById("feed-recent-section");
const feedRecentItems = document.getElementById("feed-recent-items");
const feedRecentClearBtn = document.getElementById("feed-recent-clear-btn");

const creatorBanner = document.getElementById("creator-banner");
const creatorBannerName = document.getElementById("creator-banner-name");
const creatorBackBtn = document.getElementById("creator-back-btn");
const creatorFollowBtn = document.getElementById("creator-follow-btn");
const creatorFollowText = document.getElementById("creator-follow-text");

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
      saveRecentSubreddit(state.changeSubreddit);
      selectSubreddit(state.changeSubreddit);
    }

    if (state.toggleJoin) {
      handleToggleJoin(state.toggleJoin.target, state.toggleJoin.type);
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
    subHeaderJoinBtn.style.display = "none";
    return;
  }
  const cleanCurrent = currentSubreddit.trim().toLowerCase().replace(/^r\//, "");
  const cleanTarget = (subreddit || "").trim().toLowerCase().replace(/^r\//, "");
  if (cleanCurrent === cleanTarget) {
    subHeaderJoinBtn.style.display = "inline-flex";
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

// Feed dropdown button: Resets search mode and opens main menu
feedDropdownBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  closeSubredditSearch();
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
    feedRecentSection.style.display = "none";
    feedRecentItems.innerHTML = "";
    return;
  }
  feedRecentSection.style.display = "block";
  feedRecentItems.innerHTML = "";
  list.forEach((subName) => {
    const item = document.createElement("div");
    item.className = `dropdown-item recent-sub-item ${currentSubreddit.toLowerCase() === subName.toLowerCase() ? "active" : ""}`;
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
  if (!subSearchResults) return;
  const list = loadRecentSubreddits();
  if (list.length === 0) {
    if (subSearchHint) {
      subSearchHint.textContent = "Type a name to search Reddit communities";
      subSearchHint.style.display = "block";
    }
    subSearchResults.innerHTML = "";
    return;
  }

  if (subSearchHint) {
    subSearchHint.style.display = "none";
  }

  subSearchResults.innerHTML = `
    <div class="search-recent-header">
      <span class="search-recent-title">Recent Searches</span>
      <button class="search-recent-clear-btn" id="search-recent-clear-btn" type="button" title="Clear all recent searches">Clear</button>
    </div>
  `;

  const clearBtn = subSearchResults.querySelector("#search-recent-clear-btn");
  clearBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    clearRecentSubreddits();
  });

  list.forEach((subName) => {
    const item = document.createElement("div");
    item.className = `search-result-item recent-sub-item ${currentSubreddit.toLowerCase() === subName.toLowerCase() ? "active" : ""}`;
    item.innerHTML = `
      <div class="recent-sub-left">
        <div class="search-result-icon" style="width: 22px; height: 22px; font-size: 0.62rem;">r/</div>
        <div class="search-result-text">
          <div class="search-result-name">r/${subName}</div>
        </div>
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
    subSearchResults.appendChild(item);
  });
}

// Subreddit Search UI Handlers
let searchDebounceTimer = null;
let currentSearchQuery = "";

function openSubredditSearch() {
  if (feedMenuMain) feedMenuMain.style.display = "none";
  if (feedMenuSearch) feedMenuSearch.style.display = "flex";
  if (subSearchInput) {
    subSearchInput.value = "";
    if (subSearchClearBtn) subSearchClearBtn.style.display = "none";
    renderSearchRecentView();
    setTimeout(() => subSearchInput.focus(), 60);
  }
}

function closeSubredditSearch() {
  if (feedMenuSearch) feedMenuSearch.style.display = "none";
  if (feedMenuMain) feedMenuMain.style.display = "block";
  renderRecentSubreddits();
}

feedOpenSearchBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  openSubredditSearch();
});

subSearchBackBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  closeSubredditSearch();
});

subSearchClearBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  if (subSearchInput) {
    subSearchInput.value = "";
    subSearchInput.focus();
  }
  if (subSearchClearBtn) subSearchClearBtn.style.display = "none";
  renderSearchRecentView();
});

subSearchInput?.addEventListener("input", (e) => {
  const query = e.target.value.trim().replace(/^r\//i, "");
  currentSearchQuery = query;

  if (subSearchClearBtn) {
    subSearchClearBtn.style.display = query ? "block" : "none";
  }

  clearTimeout(searchDebounceTimer);

  if (!query) {
    renderSearchRecentView();
    return;
  }

  if (subSearchHint) {
    subSearchHint.textContent = `Searching communities for "${query}"... ⏳`;
    subSearchHint.style.display = "block";
  }

  searchDebounceTimer = setTimeout(async () => {
    try {
      const results = await searchSubreddits(query, 8);
      if (currentSearchQuery !== query) return; // Discard stale query response

      if (results.length === 0) {
        if (subSearchHint) {
          subSearchHint.textContent = `No communities found matching "r/${query}". Press Enter to visit anyway.`;
          subSearchHint.style.display = "block";
        }
        if (subSearchResults) subSearchResults.innerHTML = "";
        return;
      }

      if (subSearchHint) subSearchHint.style.display = "none";
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
        subSearchHint.style.display = "block";
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

// Home option handler in main feed menu
feedMenuMain?.querySelector('[data-action="home"]')?.addEventListener("click", () => {
  selectSubreddit("");
});

function selectSubreddit(subName) {
  closeAllDropdowns();
  closeSubredditSearch();
  const clean = (subName || "").trim().replace(/^r\//i, "");
  currentSubreddit = clean;
  currentAuthor = "";

  if (creatorBanner) creatorBanner.style.display = "none";
  if (feedDropdown) feedDropdown.style.display = "inline-flex";

  // Update selection UI in feed dropdown
  const homeItem = feedMenuMain?.querySelector('[data-action="home"]');
  if (homeItem) {
    homeItem.classList.toggle("active", !clean);
  }

  if (feedSelectedText) {
    feedSelectedText.textContent = clean ? `r/${clean}` : "Home (Your Feed)";
  }

  // Update subreddit join button in header
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

  updateSubHeaderJoinButtonState("", false);

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
    const isFollowed = isTargetJoined(clean, "user");
    updateCreatorFollowButtonState(clean, isFollowed);
    // Authoritatively verify follow status with Reddit API
    checkUserSubscription(clean).then((verifiedFollowed) => {
      if (currentAuthor.toLowerCase() === clean.toLowerCase()) {
        updateCreatorFollowButtonState(clean, verifiedFollowed);
      }
    });
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

  if (feedSelectedText) {
    feedSelectedText.textContent = currentSubreddit ? `r/${currentSubreddit}` : "Home (Your Feed)";
  }

  renderRecentSubreddits();

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
        syncUserSubscriptions().then(() => {
          logDebug("User subscriptions synchronized from Reddit.");
          if (currentSubreddit) {
            const isJoined = isTargetJoined(currentSubreddit, "sub");
            updateSubHeaderJoinButtonState(currentSubreddit, isJoined);
            feedController.updateTargetButtons(currentSubreddit, "sub", isJoined);
          }
        });
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

// Initial setup
renderRecentSubreddits();
updateSortDropdownOptions();
updatePopoverStats();

logDebug("Reddit Reels web app initialized.");
