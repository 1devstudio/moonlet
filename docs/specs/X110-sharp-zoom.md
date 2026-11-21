# X110 — Sharp zoom

- **Status:** implemented
- **Priority / phase:** P1 · phase 4
- **PRD refs:** X65 (design canvas zoom), X64 (design system cards)
- **Related ADRs:** [0013](../adr/0013-design-systems-and-designs.md)

## Summary

A design's page, a snapshot's page, or a design system's card zoomed past 100% looks blurry today. The app scales the page's frame with a CSS `transform`, and WebKit draws the frame at 100% and stretches that picture. This happens with the page in its own web process (site isolation, ADR 0013) and in the app's own process alike. Above 100%, the page now draws itself at the zoom instead, so its text and lines are as sharp as at 100%. It still lays out at its viewport: its breakpoints, viewport units and the window size its scripts read are those of the viewport, not of the bigger frame.

## User journey

1. The user opens a design and zooms the canvas in to 150% (⌘= or +).
2. The page grows to 150%, as before, and its text is sharp.
3. The page shows the same layout as at 100%: a Phone page at 200% keeps its phone layout.
4. Comment and Edit mode work as at 100%: pins sit on their elements, the hover outline and the selection follow the pointer, and a resize by a handle gives the size the user dragged it to, in the page's px.
5. Zoomed back to 100% or less, the page is drawn as today.

## Behaviour and acceptance criteria

- [ ] At 100% and below, a frame is drawn as before X110: its page lays out at the viewport and the frame is scaled down (`lib/designView.test.ts` frames a page at 100% or less by scaling the frame (X110)).
- [ ] Above 100%, the frame is the zoomed size and asks its page to zoom itself by the zoom (`lib/designView.test.ts` frames a page above 100% at the zoomed size, and the page zooms itself (X110)).
- [ ] The scheme puts a zoom script in every page it serves, after the release script. It asks the app for the zoom once it starts, and the app answers. The app also tells it every new zoom or viewport, and again when the frame loads. The app takes the ask only from its own frame's page, and the script takes the zoom only from the app's window, only as a number from 1 to 4, and only with a viewport of whole px up to 99999 (`src-tauri/src/design_scheme.rs` every_page_a_frame_is_served_starts_with_the_release_script; `lib/designZoom.test.ts` asks the app for the zoom when it starts; takes the zoom only from the app's window, and only a number from 1 to 4; takes the zoom script's ask only from the frame's own window).
- [ ] The page lays out at the viewport the app gives with the zoom, not at the frame's size divided by the zoom: the frame may not have its new size yet when the zoom comes Once the zoom changes the window size the page reads, the page's `resize` listeners are told (`lib/designZoom.test.ts` takes the zoom only from the app's window, and only a number from 1 to 4; sizes a style the page or the bridge sets while zoomed, and a stylesheet it adds, at the viewport, and again when the viewport changes; tells the page's resize listeners once the zoom changes the viewport it reads).
- [ ] A zoomed page lays out at its viewport:
  - breakpoints in its stylesheets, inline and linked, and in a `<link>`'s or `<style>`'s `media`, match as at the viewport: a 390 px page at 200% does not match `(min-width: 600px)`, and does match `(min-width: 300px)`. This holds for a stylesheet linked while zoomed, once it loads, and for the `media` of a stylesheet whose rules cannot be read;
  - `vw`, `vh`, `vmin`, `vmax` (and their `s`/`l`/`d` forms) in its stylesheets, readable imported stylesheets and `style` attributes, the root's included, are those of the viewport: `50vw` on a 390 px page is 195 px of the page;
  - `innerWidth` and `innerHeight` are the viewport's;
  - `matchMedia` matches as at the viewport, and a list it gave answers `matches` at the zoom it is read at.

  A zoom the page gives its own root is given back at 100% (read only: JSDOM has no CSS zoom).

  A rule or a `media` the page changed through the CSSOM is taken as it now is. Back at 100%, every rule, `media` and `style` is as the page wrote it, and the page has its own linked stylesheets again (`lib/designZoom.test.ts` matches the breakpoints of its stylesheets at the viewport, and puts them back at 100%; sizes vw, vh, vmin and vmax at the viewport, in its stylesheets and style attributes, and puts them back at 100%; matches matchMedia's queries at the viewport while zoomed; corrects the media of a stylesheet whose rules it cannot read; sizes viewport units on the page's root element too; answers a matchMedia list made at one zoom as at the viewport after the zoom changes; takes a rule or a media query the page changed through the CSSOM as the page wrote it; `e2e/specs/design-zoom.e2e.ts` keeps a Phone page's layout at 200%, in a frame of the zoomed size where the page draws itself at 200%).
- [ ] The page's file is never changed by the zoom: the zoom script changes only the live page (`e2e/specs/design-zoom.e2e.ts` keeps a Phone page's layout at 200%, in a frame of the zoomed size where the page draws itself at 200%).
- [ ] In a zoomed page, the bridge reports boxes and takes pointer positions in the page's px, as at 100%. Pins sit on their elements, and a resize by a handle sets the size the drag gave in the page's px The bridge learns the zoom from the zoom script, which parses the app's message (`lib/designBridge.test.ts` in a page zoomed to 200%, reports boxes and takes the pointer in the page's px (X110); `e2e/specs/design-zoom.e2e.ts` puts a pin on its element at 200%).
- [ ] The design screen's canvas, a snapshot's page and a design system's card page all zoom this way, as they share the frame (`CardFrame`). Play (Fill at 100%, Fit at most 100%) and the tiles and thumbnails never go above 100%, so they are drawn as before.

## UI

No new controls. The zoom bar, ⌘=, ⌘- and ⌘0 work as in X65 and X64.

## Protocol and RPCs

No daemon change. Between the app and a framed page, through `postMessage`:

- page → app: `moonlet:zoom?`, sent by the zoom script when it starts.
- app → page: `moonlet:zoom=<n>,<w>x<h>`, where `n` is the zoom the page draws itself at (`1` when the frame is scaled instead), and `w`×`h` is its viewport in whole px, such as `moonlet:zoom=2,390x844`. The bridge takes the same message, to report boxes and take the pointer in the page's px.

## Data and config

None. Nothing is saved.

## Security considerations

- A framed page is untrusted HTML (X64). The zoom script runs with the page's rights and only changes the live page's styles. It takes a zoom only from `window.parent`, only a number from 1 to 4, and only with a viewport of whole px up to 99999.
- The app takes `moonlet:zoom?` only from its own frame's window, and answers with the zoom and the viewport alone.
- The scheme now serves stylesheets, and only them, with `Access-Control-Allow-Origin: *` (`src-tauri/src/design_scheme.rs` a_page_may_read_its_own_linked_stylesheets). A sandboxed page has an opaque origin, so without the header its own linked stylesheets cannot be read, and their breakpoints cannot be corrected. The zoom script loads a copy of each linked stylesheet with `crossorigin="anonymous"`. The header does not widen what a page can reach: its CSP still allows only its own host, and `connect-src 'none'` still forbids `fetch` and XHR. An HTML page or an image of the host is still not readable across origins.

## Out of scope

- Zoom below 100%: shrinking a frame does not blur it.
- The render window's snapshots: they are drawn at 100%.

## Test plan

- Unit (Vitest): `lib/designView.test.ts` for the frame's size, scale and zoom at a scale; `lib/designZoom.test.ts` loads `design_zoom.js` in JSDOM for breakpoints, viewport units, `style` attributes, `innerWidth`, `matchMedia`, and the messages it takes; `lib/designBridge.test.ts` for boxes and pointer positions in a zoomed page.
- Rust: `design_scheme.rs` for the script order and the CORS header on stylesheets only.
- e2e: `e2e/specs/design-zoom.e2e.ts` zooms a Phone page with an inline and a linked breakpoint and `vw` to 200%, links one more stylesheet while zoomed, goes back to 100%, and checks the layout at each step and that a pin sits on its element.
- By hand: text sharpness at 150% and 200% on the canvas and on a card's page. WebKit's own snapshot redraws the page, so an e2e shot cannot show the blur.

## Known gaps

- A `matchMedia` list's `change` events keep the zoom the list was made at. Its `matches` is right whenever it is read.
- A linked stylesheet whose `href` the page changes while zoomed shows the old one until the zoom goes back to 100%: the copy stands in for it.
- A rule the page adds with `insertRule` while zoomed is corrected only at the next zoom change or added element.
- An `@import`ed stylesheet the page cannot read (one on its host, as the page is sandboxed) is not corrected, nor are `@container` queries.
- Until the page's ask is answered, a few milliseconds after it starts, a page in a zoomed frame draws at 100%.
- After a reload the canvas scrolls the page back where it was (X65). The bridge reports the scroll as WebKit gives it, so the page comes back to another place when the zoom changed in between.
