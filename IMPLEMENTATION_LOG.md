# Reelit: Implementation Log & Developer Handoff

> **Project**: Reelit – Personal TikTok-Style Vertical Video & Reels Feed for Reddit  
> **Status**: Fully functional on Windows (Vite + Chrome MV3 Extension Bridge). Ready for Android PWA / further feature development.  
> **Last Updated**: October 2026

---

## 1. High-Level Architecture

Reelit runs as a local web application backed by an unpacked Manifest V3 Chrome Extension. The extension acts as a secure network proxy bridge to Reddit and Redgifs.

```
┌─────────────────────────────────────────────────────────────┐
│                       REELIT WEB APP                        │
│                 (http://localhost:5173/)                    │
│   • FeedController (Scroll snap, on-demand HLS, gallery)    │
│   • ExtensionBridge (window.postMessage client)             │
│   • Media Classifier (reddit.js)                            │
└──────────────────────────────┬──────────────────────────────┘
                               │
                window.postMessage (req_id, type, payload)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    EXTENSION CONTENT SCRIPT                 │
│                      (extension/content.js)                 │
│   • Injected into localhost / 127.0.0.1                     │
│   • Relays messages between page and background worker      │
└──────────────────────────────┬──────────────────────────────┘
                               │
                    chrome.runtime.sendMessage
                               ▼
┌─────────────────────────────────────────────────────────────┐
│               EXTENSION BACKGROUND SERVICE WORKER           │
│                   (extension/background.js)                 │
│   • Cookie access (reddit_session, token)                   │
│   • Bypasses CORS and referrer checks                       │
│   • Redgifs multi-strategy resolver & timeout manager       │
└──────────────┬───────────────────────────────┬──────────────┘
               │ fetch(credentials: 'include')  │ fetch(timeout: 2.5s)
               ▼                               ▼
    ┌────────────────────┐          ┌────────────────────┐
    │  old.reddit.com /  │          │   api.redgifs.com  │
    │   www.reddit.com   │          │  media.redgifs.com │
    └────────────────────┘          └────────────────────┘
```

---

## 2. Key Technical Problems Solved

### A. Reddit Video Playback & Synchronized Audio
* **Challenge**: Reddit splits hosted video (`v.redd.it`) into separate video-only MP4 files and audio-only MP4 DASH files. Direct `<video src="fallback_url">` has no sound.
* **Solution**: 
  - Reddit's `HLSPlaylist.m3u8` is parsed by `hls.js`, muxing synchronized audio and video in a single `<video>` element.
  - **On-Demand HLS Lifecycle**: Instead of creating 50 concurrent Hls instances on page load (which exceeds Chromium's hardware limit of 16 `MediaSource` decoders), HLS is instantiated **only for the active visible reel**. Distant reels (>2 away) destroy their HLS instances to keep hardware decoders free.
  - Audio backup: If direct MP4 fallback is used, a synced hidden `<audio>` element plays DASH tracks (`DASH_AUDIO_128.mp4`).

### B. Redgifs ISP Blocking & Zero-Freeze Resiliency
* **Challenge**: User ISP blocks `*.redgifs.com`. When requests hang, sequential loops froze the entire feed, resulting in black screens after the first video. In addition, browser VPN extensions bypass `localhost`.
* **Solution**:
  - **Immediate Mount**: `site/feed.js` appends all posts to the DOM immediately.
  - **Instant Reddit CDN Cache Fallback**: When Reddit ingests Redgifs, it caches an MP4 transcode in `post.preview.reddit_video_preview.fallback_url` on `v.redd.it` (never blocked by ISPs). The player uses this immediately with zero black screens.
  - **Non-blocking Background Resolution**: Resolution runs asynchronously. If Redgifs resolves (e.g. desktop VPN active), `updateReelMedia()` upgrades the video to uncompressed Redgifs HD with audio. If it fails or times out (3.5s limit), it seamlessly continues playing the Reddit cache.
  - **Concurrent Probing**: Strategy 4 in `background.js` probes top CDN candidates in parallel with `Promise.any` rather than sequential timeouts.

### C. Origin & Referrer Policy (HTTP 403 Forbidden)
* **Challenge**: Reddit's CDN (`v.redd.it`, `i.redd.it`, `preview.redd.it`) inspects the HTTP `Referer` header. Requests from `http://localhost:5173/` were rejected with HTTP 403 Forbidden.
* **Solution**: Added `<meta name="referrer" content="no-referrer" />` in `site/index.html`. Browsers strip the referrer header, allowing direct media playback without 403 errors.

### D. Media Classifier Priority
* **Challenge**: Redgifs posts that had Reddit preview transcodes were previously matching the `reddit_video` rule first, branding them as Reddit videos and attempting to load non-existent preview HLS playlists.
* **Solution**: Prioritized `isRedgifs` check in `site/reddit.js` before hosted Reddit videos.

### E. Diagnostic Reel Badges
* Live on-screen indicator badges at the top-left of every video:
  - **Source**: `[ 🔴 Reddit Video ]`, `[ 🎬 Redgifs HD ]`, `[ 🛡️ Reddit Cache (ISP Fallback) ]`, `[ 📺 Redgifs Embed ]`, `[ 🖼️ Gallery (N) ]`, `[ 🖼️ Image ]`
  - **Sound**: `[ 🔊 Audio ON ]`, `[ 🔇 Audio (Muted) ]`, `[ 🔇 Silent / No Audio ]`

---

## 3. File Map & Responsibilities

| File | Path | Description |
| :--- | :--- | :--- |
| **`manifest.json`** | `extension/manifest.json` | Manifest V3 configuration, permissions (`cookies`, `downloads`), host permissions (`reddit.com`, `redd.it`, `redgifs.com`), content script injection into `localhost`. Current version: `v1.3.0`. |
| **`background.js`** | `extension/background.js` | Service worker handling Reddit `.json` fetches with session cookies, automatic `old.reddit` <-> `www.reddit` fallback, and 4-strategy Redgifs resolution with strict timeouts. |
| **`content.js`** | `extension/content.js` | Injected into the web page. Bridges `window.postMessage` from the frontend to `chrome.runtime.sendMessage` in the background worker. Emits `EXTENSION_READY` on load. |
| **`index.html`** | `site/index.html` | Application shell: Top navigation bar, feed controls (subreddit & sort selector), status badge pill, audio toast, debug drawer, and `<meta name="referrer" content="no-referrer">`. |
| **`main.js`** | `site/main.js` | Web app entrypoint: wires UI controls, handles bridge connection state, triggers feed loads, and logs diagnostics. |
| **`bridge.js`** | `site/bridge.js` | Client-side Promise-based wrapper around `window.postMessage`. Correlates request IDs with timeout safety. |
| **`reddit.js`** | `site/reddit.js` | Reddit URL builder (`buildRedditUrl`), session checker (`checkRedditSession`), feed fetcher (`fetchFeed`), and media classification (`classifyPost`). |
| **`feed.js`** | `site/feed.js` | Core reel controller: `IntersectionObserver` scroll snapping, on-demand HLS player, gesture controls (single tap pause, double tap like), keyboard navigation (`J`/`K`/`↑`/`↓`/`Space`/`M`), multi-image gallery carousel, and diagnostic badge management. |
| **`styles.css`** | `site/styles.css` | TikTok/Reels CSS: `100dvh` full-screen snapping, ambient blurred backdrop, action buttons column, diagnostic pill badges, and dark mode theme. |
| **`vite.config.js`** | `site/vite.config.js` | Vite config set to port `5173` with `host: true` enabled for LAN access. |

---

## 4. How to Run & Develop

### Prerequisites
* Google Chrome (or Chromium-based browser)
* Node.js v18+ installed

### Step 1: Load the Chrome Extension
1. Open Chrome and navigate to `chrome://extensions`.
2. Toggle **Developer mode** ON (top-right).
3. Click **Load unpacked** (top-left).
4. Select the folder: `c:\Users\rh22\Desktop\pls\reelit3\extension`.
5. Verify the extension **Reddit Reels Bridge** (v1.3.0) is enabled.
6. Ensure you are logged into Reddit in this browser profile.

### Step 2: Start the Development Server
```powershell
cd c:\Users\rh22\Desktop\pls\reelit3\site
npm run dev
```

### Step 3: Open the Web App
* Navigate to `http://localhost:5173/`.
* The status indicator in the top right will turn green (`v1.3.0 • Logged In`).
* Your personal feed will begin streaming immediately with dynamic feed rotation.

---

## 5. Recent Enhancements (October 2026 – v1.3.0)

1. **Dynamic Feed Freshness & Rotation**:
   - Switched Home feed default algorithm from static "Hot" to Reddit's dynamic "Best" recommendation engine (`/best.json`).
   - Added cache-busting timestamp parameters (`&_t=...`) and `cache: "no-store"` in extension service worker fetches to prevent stale HTTP disk caching on refresh.
2. **Automatic NSFW Age-Gate Bypass**:
   - Extension automatically sets and maintains the `over18=1` cookie for `.reddit.com` in the browser session, bypassing adult-content interstitials without manual prompt clicks.
3. **Interactive Video Control Bar & Scrubber**:
   - Sleek bottom progress bar with buffered range, fill indicator, draggable thumb, and live timestamp indicator bubble (`mm:ss / mm:ss`).
   - Supports both click-to-seek and drag-to-scrub with mouse and touch events across MP4 and HLS streams.
4. **Cleaned UI / UX & Action Column**:
   - Removed unnecessary Like and Share buttons.
   - Streamlined action column: Save button (with active state), Comments link, Sound button, and direct Reddit link.
   - Single tap on media is now an instantaneous play/pause toggle with zero detection lag.
5. **Dual-Option Save / Download Modal**:
   - Clicking Save prompts the user with two options:
     - **Download Media**: Saves MP4/image directly to user's device via `chrome.downloads` (with fallback).
     - **Save to Reddit Account**: Dispatches authenticated `/api/save` (or `/api/unsave`) with `modhash` via the extension bridge.

6. **Creator Profile Media Feeds (`u/author`)**:
   - Clicking any creator's username (`u/author`) enters Creator Mode, streaming their submitted posts via `/user/{username}/submitted.json`.
   - Displays a dedicated top banner with `u/author` and a "← Back to Feed" button to seamlessly return to your previous feed.
   - Graceful handling for suspended, banned, deleted, or empty user profiles.
7. **Centered Text-Only Post Cards**:
   - Expanded the media classifier to parse text-only submissions (`r/AskReddit`, `r/tifu`, stories, etc.).
   - Displays text posts in a frosted glass card centered vertically and horizontally with markdown rendering, readable typography, and vertical scrolling for long stories.
   - Diagnostic badge: `[ 📝 Text Post ]`.
8. **Top Sort Time-Range Filtering**:
   - When sorting by "Top" (in Home, Subreddits, or Creator Profiles), an interactive time selector dropdown appears: *Today*, *This Week*, *This Month*, *This Year*, and *All Time*.
9. **UI/UX Overhaul & Custom Frosted-Glass Controls (v1.4.0)**:
   - **Unified Top-Right Diagnostic Badge**: Consolidated video source and audio state into a single compact badge positioned discreetly at the top right of each reel (`🔴 Reddit • 🔊`, `🎬 Redgifs HD • 🔇`, `📝 Text`).
   - **Minimalist Top Navigation Layout**:
     - *Left*: Sort selector and Timeframe selector pills.
     - *Center*: Subreddit / Feed dropdown selector or Creator Profile banner.
     - *Right*: Reelit logo icon button with real-time connection status dot.
   - **Delayed "Top" Sort Feed Loading**: Selecting "Top" sort does not trigger an immediate feed fetch; it reveals and opens the Timeframe dropdown so the user chooses the desired timeframe first.
   - **Custom Frosted-Glass Dropdown Menus**: Replaced native browser `<select>` dropdowns with custom dark-mode frosted-glass menus featuring animated chevrons, active state highlights, and "+ Custom Subreddit" dialog integration.
   - **Resolved Creator Profile Sorting Bug**: Fixed user submitted post sort endpoint in `site/reddit.js` to pass `?sort=new|hot|top&t=...` as query parameters, and restricted the Sort dropdown options to supported user profile sorts (`New`, `Hot`, `Top`).

10. **Dynamic Feed Refresh & Status Popover (v1.5.0)**:
    - **Refresh Feed Button in Action Column**: Replaced the bridge button in the reel action column with a dedicated Refresh button (`.refresh-feed-btn`) with smooth spin animation. Tapping it pulls completely fresh, unseen posts.
    - **Seen Reel Tracking & Deduplication Engine**:
      - As reels enter the viewport, their IDs are tracked in `seenPostIds` and persisted in `localStorage`.
      - On feed refresh (and page reloads), seen reels are filtered out to ensure users never see repetitive content.
      - If filtering leaves fewer than 20 items, auto-pagination pulls subsequent pages seamlessly to guarantee a full queue of fresh reels.
    - **Reddit "Following" Sort Alignment**: Home feed sort options now strictly reflect Reddit's Following tab rules: **Best** and **New** (subreddits continue supporting *Hot*, *Top*, *New*, *Rising*).
    - **Reelit Logo Status Dot & Popover**:
      - Logo button features a real-time glowing status indicator (green = connected, red = disconnected).
      - Clicking the logo opens an App Status & Account popover showing extension health, detected Reddit username (e.g. `u/username`), and seen reels count (with a "Reset" history button).
      - Includes a "View Debug Logs" button; pressing the logo button again while logs are open immediately closes the debug console.

---

## 6. Next Steps / Future Roadmap

1. **In-App Comments Drawer**:
   - Slide-up bottom sheet showing top-level Reddit comments and discussion trees without leaving the app.
2. **Media Filter Toggle**:
   - Toggle in header to switch between "All Posts", "Videos Only", or "Text Only".
3. **Android PWA Packaging**:
   - Add web app manifest and service worker for standalone mobile PWA.
