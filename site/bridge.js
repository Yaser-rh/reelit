// Reddit Reels Bridge Client
// Communicates with extension content script via window.postMessage

class ExtensionBridge {
  constructor() {
    this.ready = false;
    this.version = null;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.statusListeners = new Set();
    this.readyCallbacks = [];
    this.pingInterval = null;
    this.init();
  }

  init() {
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.target !== "REELS_PAGE") return;

      // Handle Handshake / Ready signals
      if (data.type === "EXTENSION_READY" || data.type === "PONG") {
        const wasReady = this.ready;
        this.ready = true;
        this.version = data.version || "1.0.0";

        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }

        if (!wasReady) {
          this._notifyStatus("connected", { version: this.version });
          this.readyCallbacks.forEach((cb) => cb());
          this.readyCallbacks = [];
        }
      }

      // Handle Request Responses
      if (data.id && this.pending.has(data.id)) {
        const entry = this.pending.get(data.id);
        this.pending.delete(data.id);
        clearTimeout(entry.timer);

        if (data.ok) {
          entry.resolve(data.data);
        } else {
          const err = new Error(data.error || "Extension request failed");
          err.status = data.status;
          entry.reject(err);
        }
      }
    });

    // Start proactive handshake pinging
    this.startHandshake();
  }

  startHandshake() {
    if (this.ready) return;

    let attempts = 0;
    const maxAttempts = 20;

    const ping = () => {
      if (this.ready) {
        if (this.pingInterval) clearInterval(this.pingInterval);
        return;
      }
      window.postMessage(
        {
          target: "REELS_EXTENSION",
          id: `ping_${Date.now()}_${attempts}`,
          type: "PING"
        },
        "*"
      );
      attempts++;
      if (attempts >= maxAttempts && !this.ready) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
        this._notifyStatus("disconnected", {
          message: "Extension not detected. Please verify the unpacked extension is installed and active."
        });
      }
    };

    ping();
    this.pingInterval = setInterval(ping, 400);
  }

  onStatusChange(callback) {
    this.statusListeners.add(callback);
    // Emit immediate current state
    callback(this.ready ? "connected" : "connecting", { version: this.version });
    return () => this.statusListeners.delete(callback);
  }

  _notifyStatus(status, details) {
    for (const listener of this.statusListeners) {
      try {
        listener(status, details);
      } catch (err) {
        console.error("Error in bridge status listener:", err);
      }
    }
  }

  isReady() {
    return this.ready;
  }

  waitForReady(timeoutMs = 6000) {
    if (this.ready) return Promise.resolve(true);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            "Reddit Reels extension bridge timed out. Make sure the extension is loaded unpacked in Chrome (chrome://extensions) and this tab is refreshed."
          )
        );
      }, timeoutMs);

      this.readyCallbacks.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  async send(type, payload, timeoutMs = 25000) {
    if (!this.ready) {
      try {
        await this.waitForReady(4000);
      } catch (err) {
        throw new Error(
          "Extension bridge is not connected. Load the unpacked extension in chrome://extensions, enable Developer mode, and reload."
        );
      }
    }

    const id = `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Extension request "${type}" timed out after ${timeoutMs}ms.`));
        }
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer, type });

      window.postMessage(
        {
          target: "REELS_EXTENSION",
          id,
          type,
          payload
        },
        "*"
      );
    });
  }

  // Convenience helper for Reddit calls
  async fetchReddit(url) {
    return await this.send("FETCH_REDDIT", { url });
  }

  // Convenience helper for Redgifs resolution
  async resolveRedgifs(urlOrId) {
    return await this.send("RESOLVE_REDGIFS", { url: urlOrId });
  }
}

export const bridge = new ExtensionBridge();
export default bridge;
