// Reddit Reels Bridge Content Script
// Injected into allowed web origins to bridge window.postMessage with background.js

const BRIDGE_VERSION = chrome.runtime.getManifest()?.version || "1.1.0";

// Notify the web page that the extension is ready
function announceReady() {
  window.postMessage(
    {
      target: "REELS_PAGE",
      type: "EXTENSION_READY",
      version: BRIDGE_VERSION,
      timestamp: Date.now()
    },
    "*"
  );
}

// Announce immediately
announceReady();

// Announce again on interactive/complete if DOM was still loading
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", announceReady);
}

// Listen for messages from the page
window.addEventListener("message", (event) => {
  // Only handle messages coming from the same window
  if (event.source !== window) return;

  const data = event.data;
  if (!data || data.target !== "REELS_EXTENSION") return;

  const { id, type, payload } = data;

  // Instant handshake response
  if (type === "PING") {
    window.postMessage(
      {
        target: "REELS_PAGE",
        id,
        type: "PONG",
        version: BRIDGE_VERSION,
        ok: true
      },
      "*"
    );
    return;
  }

  // Forward to background service worker
  try {
    chrome.runtime.sendMessage({ id, type, payload }, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        window.postMessage(
          {
            target: "REELS_PAGE",
            id,
            type: `${type}_RESPONSE`,
            ok: false,
            error: lastError.message || "Failed to communicate with extension background service worker."
          },
          "*"
        );
        return;
      }

      window.postMessage(
        {
          target: "REELS_PAGE",
          id,
          type: `${type}_RESPONSE`,
          ok: response?.ok ?? false,
          data: response?.data,
          status: response?.status,
          error: response?.error
        },
        "*"
      );
    });
  } catch (err) {
    window.postMessage(
      {
        target: "REELS_PAGE",
        id,
        type: `${type}_RESPONSE`,
        ok: false,
        error: err.message || String(err)
      },
      "*"
    );
  }
});
