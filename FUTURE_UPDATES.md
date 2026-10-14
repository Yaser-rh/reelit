# Future updates

Notes for later.

The one-page swipe, the deferred playback, and the short settle are in `site/styles.css` and `site/feed.js`. Backdrop blur on off-screen reels is still unchanged.

Touch paging on Android (Titanium) is the first item. A light swipe moves two, three, or more videos, and gallery slides do the same. The second item is how to make that swipe feel fast once it only moves one page.

## 1. One swipe, one reel

Vertical paging is native scroll-snap. `.feed-viewport` is `scroll-snap-type: y mandatory`. Each `.feed-item` is one screen (`100dvh`) and has:

```css
scroll-snap-align: start;
scroll-snap-stop: normal; /* Allows smooth flings past multiple reels */
```

`normal` lets the browser pass snap points. Chrome then rests where the fling coasts to, not on the next reel. On Android a short finger move still gets a fast fling. One reel is about one screen tall, so that coast commonly lands two to four items away. The comment on that line is the current behavior. ([MDN: scroll-snap-stop](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/scroll-snap-stop))

Galleries are the same mechanism sideways. `.gallery-container` is `scroll-snap-type: x mandatory`. `.gallery-slide` does not set `scroll-snap-stop`, so it defaults to `normal`. A short horizontal flick crosses several slide widths.

The 1.5× drag in `site/feed.js` is mouse-only (`pointerType !== "mouse"` returns early). It is not the phone path. `IntersectionObserver` follows the position the scroller already reached. It does not move the feed. The gallery `scroll` listener updates the counter and calls `syncGallery`. It does not change `scrollLeft`.

### Change, when we do this

Set `scroll-snap-stop: always` on the snap children:

- `.feed-item` — replace `normal`
- `.gallery-slide` — add the property

`always` means the scroller must not pass the next snap point in one gesture. A long flick then also moves only one reel or one gallery slide. Leave `scroll-snap-type: mandatory` as it is. Chrome on Android has supported `always` since Chrome 75, so Titanium should honor it.

While testing, compare `feed.clientHeight` with a `.feed-item`'s `offsetHeight`. Both are `100dvh` today, so they should match. If an item is taller than the scroller, mandatory snap can jump an extra reel on top of the fling.

### If the phone still skips

Some Android flings ignore `scroll-snap-stop` and only snap at the end of the coast. Own the gesture in `site/feed.js` only if a phone test still skips:

1. On `touchstart`, remember the finger position and the current reel or gallery slide.
2. On `touchend`, cancel the native fling by assigning `scrollTop` or `scrollLeft` to its current value. That stops momentum in Chromium.
3. If the finger moved past about 30–40px, smooth-scroll exactly one item. `scrollIntoView` for the feed, `scrollBy({ left: ±clientWidth })` for the gallery. Under that threshold, leave it so a tap stays play/pause.

Do not add that JavaScript in the same change as `always`. Together they fight and double-animate.

## 2. Make the swipe feel fast

`scroll-snap-stop: always` fixes the skip. It does not set how the settle moves. The snap curve is chosen by the browser, and CSS cannot set its duration. ([MDN: scroll-snap-type](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/scroll-snap-type))

What feels fast on a phone is two separate things: the page sticks to the finger, then it settles in a short ease-out. Native scroll already sticks to the finger. The floaty part is a long coast, plus main-thread work during that coast. On a 60Hz screen the frame budget is about 16.7ms. A missed frame shows the old position for a whole refresh, which is the stutter. ([Chromium, July 2026](https://blog.google/chromium/smoother-scrolling-how-we-halved-scroll-jank-in-chrome-on-android/))

### Do not add `scroll-behavior: smooth` on the feed

`scroll-behavior` changes programmatic scrolls only (`scrollTo`, `scrollIntoView`, fragment links). A finger swipe ignores it. ([MDN: scroll-behavior](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/scroll-behavior)) The `smooth` duration is also fixed by the browser and is often a long ease, which feels late. Keyboard `scrollIntoView({ behavior: "smooth" })` and the gallery button `scrollBy({ behavior: "smooth" })` already use that curve. If those should feel fast too, drive them with a short script (~180–220ms, ease-out) instead of `behavior: "smooth"`. Leave the CSS property off `.feed-viewport`.

### First pass: claim the gesture, then stay quiet until it ends

CSS, in the same edit as `scroll-snap-stop`:

- `touch-action: pan-y` on `.feed-viewport`. The browser then treats the gesture as vertical immediately, instead of waiting to see if it is horizontal. ([MDN: touch-action](https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action))
- Keep `touch-action: pan-x` on `.gallery-wrapper`, so a gallery swipe stays horizontal.
- `overscroll-behavior-x: contain` on `.gallery-container`. The feed already has `overscroll-behavior-y: contain`.

JavaScript, this is the part that makes the motion feel instant:

- `handleItemVisible` currently runs as soon as a reel crosses the 0.6 intersection ratio. That can happen mid-swipe, and it pauses the previous reel, calls `playMedia` (HLS import, player setup, `play()`), writes a seen id, and updates the badge. Move playback, HLS, and the seen-id write to `scrollend` on `#feed`. Chrome's guidance is to keep heavy work off the active scroll. ([Chrome: scrollend](https://developer.chrome.com/blog/scrollend-a-new-javascript-event))
- `scrollsnapchange` fires when the snap target is chosen, just before `scrollend`. Use that to know which reel won, and still start the video on `scrollend`. ([MDN: scroll snap events](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Scroll_snap/Using_scroll_snap_events))
- The gallery `scroll` listener calls `syncGallery` on every event, which can set `src` and call `play()` while the slide is still moving. Update the counter during the scroll. Load and play the slide on `scrollend`.

The finger path stays native. No custom drag loop in this pass.

### If the settle still glides too long

Native mandatory snap often waits until the finger has crossed about half the screen, then decelerates for a long time. A snappy pager decides earlier and finishes sooner:

- While the finger is down, let the browser scroll (it already tracks 1:1).
- On release, cancel momentum the same way as in section 1.
- Go to the next reel if the finger traveled more than about 20% of the screen, or the flick was quick. Otherwise snap back.
- Animate that last step in about 180–220ms with an ease-out (`cubic-bezier(0.22, 1, 0.36, 1)`). A snap back can be shorter, about 120ms. Ease-in-out feels slow because it starts late.

`scrollTo({ behavior: "smooth" })` cannot take a duration. A timed settle is a short `requestAnimationFrame` on `scrollTop` / `scrollLeft`. Do this only after the CSS `always` change has been tried on the phone. A transform-driven column (the reel track moves with `translate3d`, and DOM is recycled) is the fullest version of this and a much larger change. It is not the next step.

### Only if a swipe is still heavy

These change things the app currently keeps on purpose (`CURRENT_BUGS.md`: blurred backdrops stay on off-screen reels, and reel nodes stay mounted). Ask before doing them.

- `filter: blur(8px)` plus `will-change: transform` on every `.item-backdrop` is a paint cost on each frame of the swipe. Limiting that to the current reel and its neighbors, or using a pre-blurred still, is the likely win. `will-change` on every reel promotes more layers than the swipe needs.
- `content-visibility: auto` can skip layout and paint for reels far from the screen. Pair it with `contain-intrinsic-size: auto 100dvh` so the snap stride stays one screen. A wrong intrinsic size makes the feed jump. Nodes would stay in the DOM. Check snap alignment after, including a gallery reel.

### Order to implement later

1. `scroll-snap-stop: always` on reels and gallery slides. Confirm on the phone that one gesture moves one page, and that a tap still pauses.
2. `touch-action: pan-y` on the feed, `overscroll-behavior-x: contain` on the gallery.
3. Move play, HLS, seen-id writes, and gallery `syncGallery` to `scrollend`.
4. If the coast still feels long, add the short ease-out settle.
5. Backdrop blur and `content-visibility` only if the phone is still dropping frames, and only after a yes.
