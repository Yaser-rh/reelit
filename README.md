# Reelit: Reddit Reels (TikTok-Style Vertical Feed)

A personal TikTok-style vertical video and media reel player for Reddit, powered by an unpacked Chrome Extension bridge that proxies requests using your logged-in Reddit session cookies and automatically resolves Redgifs videos.

---

## Architecture

```
[Website / PWA] (localhost:5173)
        │
        │  window.postMessage (request ID + type + payload)
        ▼
[Content Script] (content.js - injected into localhost origins)
        │
        │  chrome.runtime.sendMessage
        ▼
[Background Service Worker] (background.js)
        │
        │  fetch with credentials: 'include' (session cookies)
        ▼
Reddit .json / Redgifs API & Watch page
```

All Reddit and Redgifs network calls occur exclusively inside the extension background script to bypass CORS and leverage existing browser login cookies.

---

## Project Structure

```
reelit3/
├── extension/                 # Chrome Extension (Manifest V3)
│   ├── manifest.json          # Permissions (cookies, host permissions)
│   ├── background.js          # Service worker (Reddit fetch & Redgifs resolver)
│   └── content.js             # Window postMessage bridge
├── site/                      # Vite Frontend Web App
│   ├── index.html             # Shell with header, feed, and status modals
│   ├── main.js                # App entrypoint and UI event binding
│   ├── bridge.js              # Promise-based extension communication bridge
│   ├── reddit.js              # Reddit JSON client and media classifier
│   ├── feed.js                # Scroll-snap controller & video/audio player
│   ├── styles.css             # Full-screen dark mode TikTok UI styling
│   └── vite.config.js         # Vite configuration (port 5173, host enabled)
├── reelit-plan.txt            # Implementation plan specification
└── README.md
```

---

## Quick Start (Windows Testing)

### 1. Load the Chrome Extension

1. Open Google Chrome (or any Chromium browser like Brave, Edge, Titanium).
2. Navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle switch in the top-right corner).
4. Click **Load unpacked** (top-left button).
5. Select the `extension` folder inside this project directory:
   `C:\Users\rh22\Desktop\pls\reelit3\extension`
6. Verify that **Reddit Reels Bridge** appears in your extension list and is enabled.

> **Important**: Ensure you are logged into Reddit (`reddit.com` or `old.reddit.com`) in the same Chrome profile so your personal feed and upvotes can be retrieved.

### 2. Start the Local Website

Open a terminal in the `site` directory and start the Vite development server:

```powershell
cd C:\Users\rh22\Desktop\pls\reelit3\site
npm run dev
```

The app will be available at:
`http://localhost:5173/`

### 3. Open and Enjoy

1. Open `http://localhost:5173/` in the Chrome window where the extension is installed.
2. The top bar status indicator should turn **Green** (`v1.2.0 • Logged In`), confirming that the bridge handshake succeeded.
3. Your reels will load immediately!

---

## Features

- **TikTok / Reels Interface**: Full-screen vertical scroll snapping (`100dvh`), blurred ambient backdrop, and clean overlays.
- **On-Demand HLS Engine**: Initializes HLS streams on demand only for the active visible reel, preventing Chromium hardware decoder quota exhaustion.
- **Reddit Video Synchronized Audio**: High-definition HLS audio tracks with native fallback DASH track synchronization.
- **Redgifs Multi-Strategy Resolver & ISP Fallback**:
  - Automatically unblocks Redgifs videos using Reddit's CDN cache fallback (`v.redd.it`) when an ISP blocks `redgifs.com`.
  - Non-blocking background resolver upgrades streams to native Redgifs HD without freezing the feed.
- **Diagnostic Badge Overlay**: Live indicators displaying exact media source and audio state (`[ 🔴 Reddit Video ]`, `[ 🎬 Redgifs HD ]`, `[ 🛡️ Reddit Cache ]`, `[ 🔊 Audio ON ]`, `[ 🔇 Muted ]`).
- **Media Support**:
  - Reddit Hosted Videos (`v.redd.it`)
  - Redgifs
  - Reddit Galleries (horizontal swipe with indicator dots and arrow navigation)
  - Direct Images & Imgur GIFs
- **Feed & Subreddit Switcher**:
  - Home feed (your personal Reddit subscriptions)
  - `r/popular`, `r/all`, `r/TikTokCringe`, `r/funny`, `r/Damnthatsinteresting`
  - Custom Subreddit input prompt
  - Sorting: *Hot*, *Top* (day, week, month, year, all), *New*, *Rising*
- **Interactive Controls**:
  - **Single click / tap**: Play / Pause video with icon flash
  - **Double click / tap**: Like heart animation burst
  - **Mute / Unmute button**: Global sound toggle
  - **Reddit button**: Open original thread in a new tab
  - **Share button**: Copy Reddit permalink to clipboard
  - **Keyboard Shortcuts**:
    - `↓` or `J`: Next reel
    - `↑` or `K`: Previous reel
    - `←` / `→` or `H` / `L`: Gallery slide navigation
    - `Space`: Play / Pause
    - `M`: Mute / Unmute
    - `O`: Open thread on Reddit
- **Built-in Debug Console**: Click the status indicator badge in the top bar to inspect real-time bridge handshakes, fetch logs, and resolution statuses.

---

## Full Implementation Log

For in-depth architectural details, problem root causes, and developer handoff documentation, see:  
👉 [IMPLEMENTATION_LOG.md](./IMPLEMENTATION_LOG.md)

---

## Next Step: Android PWA Deployment

When you're ready to test on Android:
1. In Kiwi, Titanium, or Quetta Browser on Android, enable Developer Mode and load the `extension` folder unpacked.
2. Serve the `site` over your local Wi-Fi network (Vite's `--host` option displays your LAN IP, e.g., `http://192.168.1.x:5173`).
3. Add the page to your Home Screen to run it in full-screen standalone mode.
