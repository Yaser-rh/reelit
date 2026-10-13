# Reelit: Implementation Log & Developer Handoff

> **Project**: Reelit – Personal TikTok-Style Vertical Video & Reels Feed for Reddit  
> **Status**: Fully functional on Windows (Vite + Chrome MV3 Extension Bridge) and as an Android PWA. [`CURRENT_BUGS.md`](CURRENT_BUGS.md) has no open items.  
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
  - **On-Demand HLS Lifecycle**: `hls.js` is imported only when a Reddit video needs it. A player is created for the active reel. A generation token (`_hlsGen`) drops a load that finishes after the viewer has swiped away, so two players cannot attach to the same element. Reels more than one slot away are unmounted and their HLS instances destroyed.
  - **Fatal fallback**: if HLS itself fails, playback uses `item.videoUrl` (the Reddit `fallback_url`). It does not rewrite the URL to an unverified `DASH_480`.
  - Audio backup: the sidecar `<audio>` (`DASH_AUDIO_128.mp4` and friends) plays only when HLS is not attached. While `_hls` is set, that element stays paused so the muxed HLS audio is not doubled.

### B. Redgifs ISP Blocking & Zero-Freeze Resiliency
* **Challenge**: User ISP blocks `*.redgifs.com`. When requests hang, sequential loops froze the entire feed, resulting in black screens after the first video. In addition, browser VPN extensions bypass `localhost`.
* **Solution**:
  - **Immediate Mount**: `site/feed.js` appends all posts to the DOM immediately.
  - **Reddit CDN cache is the timeout fallback, not the first download**: Redgifs posts mount with a poster and no `videoUrl`. The player does not start Reddit's cached MP4 while the API call is in flight. If the resolve exceeds 6.5s and a cache exists, that silent preview plays immediately. The same in-flight promise can still upgrade the reel to the Redgifs file when it returns. One attempt per post: swiping away and back does not start a second resolve.
  - **SD for playback, HD kept for download**: the API result prefers `urls.sd` (the `-mobile.mp4`). `urls.hd` is stored on `hdUrl` and used when the viewer downloads. The on-screen badge still reads "Redgifs HD" for a direct Redgifs file.
  - **CDN fallback order**: if the API fails, mobile hosts are probed first. HD hosts are probed only after every mobile candidate fails. `thumbs2.redgifs.com` is not a candidate. HTML page scrapes still run only when Reddit has no cached preview.

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
| **`manifest.json`** | `extension/manifest.json` | Manifest V3 configuration, permissions (`cookies`, `downloads`), host permissions (`reddit.com`, `redd.it`, `redgifs.com`), content script injection into `localhost` and GitHub Pages. Current version: `v1.7.0`. `reelit-extension.zip` is this folder packed for install. |
| **`background.js`** | `extension/background.js` | Service worker handling Reddit `.json` fetches with session cookies, automatic `old.reddit` <-> `www.reddit` fallback, and 4-strategy Redgifs resolution with strict timeouts. |
| **`content.js`** | `extension/content.js` | Injected into the web page. Bridges `window.postMessage` from the frontend to `chrome.runtime.sendMessage` in the background worker. Emits `EXTENSION_READY` on load. |
| **`index.html`** | `site/index.html` | Application shell: Top navigation bar, feed controls (subreddit & sort selector), status badge pill, audio toast, debug drawer, and `<meta name="referrer" content="no-referrer">`. |
| **`main.js`** | `site/main.js` | Web app entrypoint: wires UI controls, handles bridge connection state, triggers feed loads, and logs diagnostics. |
| **`bridge.js`** | `site/bridge.js` | Client-side Promise-based wrapper around `window.postMessage`. Correlates request IDs with timeout safety. |
| **`reddit.js`** | `site/reddit.js` | Reddit URL builder (`buildRedditUrl`), session checker (`checkRedditSession`), feed fetcher (`fetchFeed`), and media classification (`classifyPost`). |
| **`feed.js`** | `site/feed.js` | Core reel controller: `IntersectionObserver` scroll snapping, on-demand HLS player, gallery playback (`syncGallery`), Redgifs priority resolve, keyboard navigation (`J`/`K`/`↑`/`↓`/`Space`/`M`), and diagnostic badge management. |
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
5. Verify the extension **Reddit Reels Bridge** (v1.7.0) is enabled. Phone installs can use `reelit-extension.zip` from the repo root.
6. Ensure you are logged into Reddit in this browser profile.

### Step 2: Start the Development Server
```powershell
cd c:\Users\rh22\Desktop\pls\reelit3\site
npm run dev
```

### Step 3: Open the Web App
* Navigate to `http://localhost:5173/`.
* The status indicator in the top right will turn green (`v1.7.0 • Logged In`).
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

11. **Live Subreddit Search & Typeahead Retrieval (v1.6.0)**:
    - **Cleaned Feed Dropdown**: Removed all hardcoded subreddit presets. Clicking the feed pill presents a clean 2-option menu: **Home (Your Feed)** and **Search Subreddits...** (plus a dynamic Recent Communities list).
    - **Embedded Search View**: Clicking Search seamlessly expands an in-dropdown search bar with a back button, clear button, and autofocus input.
    - **Live Reddit Typeahead Autocomplete**:
      - As the user types (e.g. `fun`), queries Reddit's `/api/subreddit_autocomplete_v2.json` (with automatic fallback to `/subreddits/search.json`).
      - Renders real-time community suggestions with community icons, formatted subscriber counts (e.g. `59.2M members`), and NSFW tags.
      - 1-click selection loads the subreddit feed immediately and saves it to the user's Recent list in `localStorage`.

12. **Subreddit Join & Creator Profile Follow System (v1.7.0)**:
    - **Reddit API Subscription Proxy**: Added background worker action `SUBSCRIBE_TARGET` querying `POST https://www.reddit.com/api/subscribe` with user session credentials and modhash. Handles both communities (`sr_name="sub"`) and creators (`sr_name="u_username"`).
    - **Reel Overlay Controls**: Added compact `+ Join` / `Joined ✓` pills next to `r/subreddit` and `+ Follow` / `Following ✓` pills next to `u/author` on both visual video/image overlays and text cards.
    - **Creator Profile Header Follow**: Added interactive follow button to the top Creator banner (`#creator-banner`) when viewing user profile feeds.
    - **Search Suggestion Quick Join**: Each community row in live search results includes a direct `+ Join` button to subscribe without leaving the search menu.
    - **Optimistic Reactive State**: Persists joined state in `localStorage` (`reelit_joined_targets_v1`) and synchronizes all matching buttons across the DOM instantly, with automatic rollback and toast notifications.

13. **Subreddit Join, Follow Logic Refinement & Feed Isolation (v1.8.0)**:
    - **Cleaned Home Feed Overlays**:
      - Removed join buttons from home feed reels (posts on home feed come from joined communities; no redundant "+ Join" pills).
      - Removed user follow buttons across all home and subreddit reel cards; creators are followed exclusively via the dedicated Creator Profile header banner (`#creator-banner`).
      - Cleaned search typeahead suggestions: removed join buttons to keep the autocomplete menu focused solely on community navigation.
    - **Contextual Subreddit Join Button**:
      - Added `#sub-header-join-btn` in the top navigation header next to the subreddit pill, visible only when browsing a subreddit.
      - Displays live reactive subscription status (`+ Join` vs `Joined ✓`) synchronized across the header and active subreddit reels.
    - **Authoritative Subscription Status Checking**:
      - Fixed session subscription sync: on bridge connection, queries `/subreddits/mine/subscriber.json` to load user's subscribed subreddits and followed creators into cache.
      - Real-time Subreddit Verification: querying `/r/{sub}/about.json` evaluates Reddit's authoritative `data.user_is_subscriber` boolean directly.
      - Real-time Creator Verification: querying `/user/{author}/about.json` evaluates `data.subreddit.user_is_subscriber` directly.
      - Posts delivered in Home feed automatically seed cache with `sub:name` joined status.
    - **Seen Post Filtering Isolated to Home Feed**:
      - Home feed retains dynamic freshness rotation, tracking seen reels and filtering repeat items.
      - Subreddit feeds (and Creator profiles) are completely exempt from seen deduplication; they retain all posts returned by Reddit (`Hot`, `Top`, `New`, `Rising`) without items disappearing after being watched.
      - Scrolling in subreddits or creator profiles does not pollute the Home feed seen history.
    - **Recent Searches Management & Clear Button**:
      - Added a "Clear" button in the Recent Communities header within the feed dropdown menu.
      - Added individual `×` remove buttons on each recent search item to delete specific communities from history.
      - When opening the search view with an empty input, recent searches are displayed immediately with a "Clear" button and quick 1-click selection.
      - Action emits toast confirmation and dynamically updates localStorage.

14. **Standalone Android PWA & GitHub Pages Hosting (v1.9.0)**:
    - **PWA Packaging via `vite-plugin-pwa`**:
      - Configured standalone PWA manifest with `display: "standalone"`, `orientation: "portrait"`, and solid black theme (`theme_color: "#000000"`, `background_color: "#000000"`).
      - Set base path to `/reelit/` (`https://yaser-rh.github.io/reelit/`) with matching manifest scope and start URL.
      - Generated full icon suite in `site/public/`: vector `favicon.svg`, `pwa-192x192.png`, `pwa-512x512.png` (with `any maskable` purpose), and `apple-touch-icon.png`.
    - **App-Shell Only Service Worker**:
      - Restricted Workbox precaching strictly to local static build assets (`**/*.{js,css,html,ico,png,svg}`).
      - No runtime caching for external domains, ensuring Reddit API and Redgifs media streams bypass the service worker without intercepting cookies or Range requests.
    - **Extension Origin Compatibility for Android Titanium Browser**:
      - Updated `extension/manifest.json` (`v1.5.0`) content scripts to match `https://yaser-rh.github.io/*` and `https://*.github.io/*`.
      - Allows the unpacked extension to bridge session cookies and CORS requests seamlessly on Android when using Chromium extension-capable browsers (Titanium Browser / Kiwi).
    - **Automated GitHub Pages Deployment**:
      - Added `.github/workflows/deploy.yml` for automated GitHub Actions build and deployment on push to `main`.

15. **Playback data use and scroll cost (October 2026)**:
    - **Redgifs quality**: playback requests `urls.sd`. `urls.hd` is kept for the download action. Resolution is limited to the visible reel and the next one, with a 6.5s race and a late upgrade from that same promise.
    - **Reddit video**: shorter HLS buffer, `capLevelToPlayerSize`, and no preload of the large DASH MP4 on the reel ahead. Sidecar DASH audio stays off while HLS is playing.
    - **Images**: `pickOptimalImageUrl` picks a preview near screen width instead of `preview.images[0].source`. Galleries prefer `meta.s.mp4` over the GIF, render that MP4 as `<video>`, and load slides through `data-src` only when the reel is on screen.
    - **Feed weight**: first page asks for 15 posts, later pages 25. Joined-subreddit writes are batched once per fetch. `hls.js` is a dynamic import. Debug lines stay in a 60-entry ring buffer and touch the DOM only while the log panel is open.
    - **Refresh**: `loadInitialFeed` calls `unmountVideo` on every mounted reel before clearing the container.
    - **Follow-ups closed**: gallery pause, unmute-while-paused, the missing `hls.js` fallback (Safari uses the playlist natively; other browsers use the MP4 plus sidecar audio), lowercased Imgur URLs, the CDN probe body, and gallery `window` listeners.

16. **Seek bar and feed switch (October 2026)**:
    - The scrubber paints from `timeupdate`, `durationchange`, and `seeked`. A non-finite duration does not force the fill back to 0. Touch end and touch cancel on `window` clear a drag the feed scroller interrupted.
    - The active reel shows the knob, the timestamp, and the thicker track without a hover.
    - `loadInitialFeed` bumps a generation id, drops observer entries, and ignores a page that belongs to the previous subreddit, sort, or refresh.
    - A blocked unmuted autoplay sets the app mute flag. Retry reloads the feed when the bridge is already up.
    - The Redgifs CDN probe accepts a video or `octet-stream` type, or a non-HTML `206`. A `200` HTML block page with a `.mp4` URL is not a video.
    - [`CURRENT_BUGS.md`](CURRENT_BUGS.md) has no open items. Far reel nodes stay mounted until a long session actually gets the phone killed.

17. **Extension v1.7.0 (October 2026)**:
    - `extension/manifest.json` is `1.7.0`. The content script reports that version from the manifest.
    - `reelit-extension.zip` was rebuilt from `manifest.json`, `background.js`, and `content.js`.
    - The packed background worker includes the Redgifs probe change: a `200` HTML block page is not treated as video.

---

## 6. Next Steps / Future Roadmap

1. **In-App Comments Drawer**:
   - Slide-up bottom sheet showing top-level Reddit comments and discussion trees without leaving the app.
2. **Media Filter Toggle**:
   - Toggle in header to switch between "All Posts", "Videos Only", or "Text Only".
3. **Open bug list**:
   - Nothing is open in [`CURRENT_BUGS.md`](CURRENT_BUGS.md).
