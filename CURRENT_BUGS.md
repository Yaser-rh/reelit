# Current bugs

Nothing is open. Playback, pause, mute, galleries, Redgifs SD, the seek bar, and feed switches work on the paths below.

## Already fixed

Fixed in the seek-bar and feed-switch pass:

1. The seek bar follows playback. Non-finite durations (MediaSource / hls.js before a VOD length is applied) do not pin the fill at 0. `durationchange` and `seeked` paint again. A cancelled touch or a touch that leaves the bar clears `isDragging` from `window`, same as mouse. The knob, the time, and a taller track stay visible on the active reel without hover.
2. `loadInitialFeed` bumps a generation counter and `unobserve`s reel nodes before clearing them. An older in-flight page cannot append its posts or write `after`.
3. If unmuted autoplay is blocked, the app mute flag, the sound icon, and the reel badge all switch to muted, and the sidecar audio stops.
4. Retry loads the feed when the extension bridge is already connected. It starts the handshake only when the bridge is not ready.
5. A Redgifs CDN probe no longer treats a `.mp4` URL suffix as proof. The response has to be a video or `octet-stream` type, or a `206` that is not an HTML page.

Fixed after the playback and data pass:

1. Unmuting a paused Reddit video clears `_userPaused` and resumes through `playMedia`, so an HLS reel gets `startLoad()`.
2. Gallery pause lives on the gallery element. Tap and Space follow the visible slide, and a visibility bounce does not resume a pause.
3. If `hls.js` cannot attach, Safari plays the playlist natively. Other browsers play the Reddit MP4 with sidecar audio.
4. Imgur and direct-image URLs keep their original case. Lowercasing is only used to recognize the host and the file type.
5. The Redgifs CDN probe cancels the response body after it reads the headers.
6. Gallery dragging uses pointer capture on the gallery. It does not add a permanent `window` mouse listener.

The nine bugs fixed in the playback and data pass (scrubber `ReferenceError`, HLS double-attach, next-reel DASH preload, blind `DASH_480` rewrite, sidecar double audio, Redgifs timeout discard, CDN `Promise.any` picking HD, gallery `src="null"`, refresh leaking HLS) are not open either.

## Left alone on purpose

* Blurred backdrop (`filter: blur(8px)`, `will-change: transform`) and CSS background images on off-screen reels.
* `unmountVideo` clears `src` only when a reel is more than one away.
* Reel DOM nodes stay mounted for the session. Recycle far nodes only if a long session starts getting Titanium killed.
* The badge still says "Redgifs HD" while playback uses the SD file.
* Download prefers a real `hdUrl` from the Redgifs API.
* Subscription sync still starts during the first session, deferred with `requestIdleCallback`.
