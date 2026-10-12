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
const audioToast = document.getElementById("audio-toast");
const audioToastText = document.getElementById("audio-toast-text");
const debugPanel = document.getElementById("debug-panel");
const debugLogs = document.getElementById("debug-logs");
const debugToggleBtn = document.getElementById("debug-toggle-btn");
const closeDebugBtn = document.getElementById("close-debug-btn");
const statusPill = document.getElementById("status-pill");

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
      feedController.loadInitialFeed({
        subreddit: state.changeSubreddit,
        sort: sortSelect.value
      });
    }
  },
  onDebugLog: (msg) => logDebug(msg)
});

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
        sort: sortSelect.value
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

  feedController.loadInitialFeed({
    subreddit: val,
    sort: sortSelect.value
  });
});

sortSelect.addEventListener("change", (e) => {
  hideError();
  feedController.loadInitialFeed({
    subreddit: feedSelect.value,
    sort: e.target.value
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
