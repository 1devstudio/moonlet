# X110 — Sharp zoom

- **Status:** implemented
- **Priority / phase:** P1 · phase 4
- **PRD refs:** X65 (design canvas zoom), X64 (design system cards), X99 (Play)
- **Related ADRs:** [0013](../adr/0013-design-systems-and-designs.md)

## Summary

A design's page, a design system's card, or a played page zoomed past 100% looks blurry today. The app scales the page's frame with a CSS `transform`, and WebKit draws the frame at 100% and stretches that picture. This happens with the page in its own web process (site isolation, ADR 0013) and in the app's own process alike. Above 100%, the page now draws itself at the zoom instead, so its text and lines are as sharp as at 100%. It still lays out at its viewport: its breakpoints, viewport units and the window size its scripts read are those of the viewport, not of the bigger frame.

## User journey

1. The user opens a design and zooms the canvas in to 150% (⌘= or +).
2. The page grows to 150%, as before, and its text is sharp.
3. The page shows the same layout as at 100%: a Phone page at 200% keeps its phone layout.
4. Comment and Edit mode work as at 100%: pins sit on their elements, the hover outline and the selection follow the pointer, and a resize by a handle gives the size the user dragged it to, in the page's px.
5. Zoomed back to 100% or less, the page is drawn as today.

## Behaviour and acceptance criteria

- [ ] At 100% and below, a frame is drawn as before X110: its page lays out at the viewport and the frame is scaled down (`lib/designView.test.ts` frames a page at 100% or less by scaling the frame).
- [ ] Above 100%, the frame is the zoomed size and asks its page to zoom itself by the zoom (`lib/designView.test.ts` frames a page above 100% at the zoomed size, and the page zooms itself).
- [ ] The scheme puts a zoom script in every page it serves, after the release script. It asks the app for the zoom once it starts, and the app answers. The app also tells it every new zoom or viewport, and again when the frame loads. The script takes the zoom only from the app's window, only as a number from 1 to 4, and only with a viewport in whole px (`src-tauri/src/design_scheme.rs` every_page_a_frame_is_served_starts_with_the_release_script; `lib/designZoom.test.ts` asks the app for the zoom when it starts; takes the zoom only from the app's window, and only a number from 1 to 4).
- [ ] The page lays out at the viewport the app gives with the zoom, not at the frame's size divided by the zoom: the frame may not have its new size yet when the zoom comes (`lib/designZoom.test.ts` takes the zoom only from the app's window, and only a number from 1 to 4; sizes a style the page or the bridge sets while zoomed, and a stylesheet it adds, at the viewport, and again when the viewport changes).
- [ ] A zoomed page lays out at its viewport:
  - breakpoints in its stylesheets, inline and linked, and in a `<link>`'s or `<style>`'s `media`, match as at the viewport: a 390 px page at 200% does not match `(min-width: 600px)`, and does match `(min-width: 300px)`;
  - `vw`, `vh`, `vmin`, `vmax` (and their `s`/`l`/`d` forms) in its stylesheets and in `style` attributes are those of the viewport: `50vw` on a 390 px page is 195 px of the page;
  - `innerWidth` and `innerHeight` are the viewport's;
  - `matchMedia` called while zoomed matches as at the viewport.

  Back at 100%, every rule, `media` and `style` is as the page wrote it (`lib/designZoom.test.ts`; `e2e/specs/design-zoom.e2e.ts` keeps a Phone page's layout at 200%).
- [ ] The page's file is never changed by the zoom: the zoom script changes only the live page (`e2e/specs/design-zoom.e2e.ts` keeps a Phone page's layout at 200%).
- [ ] In a zoomed page, the bridge reports boxes and takes pointer positions in the page's px, as at 100%. Pins sit on their elements, and a resize by a handle sets the size the drag gave in the page's px (`lib/designBridge.test.ts` reports boxes in the page's px when the page is zoomed; `e2e/specs/design-zoom.e2e.ts` puts a pin on its element at 200%).
- [ ] The design screen's canvas, Play, the design system's cards and its card page all zoom this way, as they share the frame (`CardFrame`).

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
- The scheme now serves every file with `Access-Control-Allow-Origin: *`. A sandboxed page has an opaque origin, so without the header its own linked stylesheets cannot be read, and their breakpoints cannot be corrected. The zoom script loads a copy of each linked stylesheet with `crossorigin="anonymous"`. The header does not widen what a page can reach: its CSP still allows only its own host, and `connect-src 'none'` still forbids `fetch` and XHR. The app's window could already read every file of the scheme.

## Out of scope

- Zoom below 100%: shrinking a frame does not blur it.
- The render window's snapshots: they are drawn at 100%.

## Test plan

- Unit (Vitest): `lib/designView.test.ts` for the frame's size, scale and zoom at a scale; `lib/designZoom.test.ts` loads `design_zoom.js` in JSDOM for breakpoints, viewport units, `style` attributes, `innerWidth`, `matchMedia`, and the messages it takes; `lib/designBridge.test.ts` for boxes and pointer positions in a zoomed page.
- Rust: `design_scheme.rs` for the script order and the CORS header.
- e2e: `e2e/specs/design-zoom.e2e.ts` zooms a Phone page with a breakpoint and `vw` to 200%, and checks that it keeps its layout and that a pin sits on its element.
- By hand: text sharpness at 150% and 200% on the canvas, in Play and on a card. WebKit's own snapshot redraws the page, so an e2e shot cannot show the blur.

## Known gaps

- A `matchMedia` list made before the page learnt its zoom keeps matching at the frame's size. Page scripts that read `matchMedia` on start see the frame's size until they ask again.
- Stylesheets a linked stylesheet `@import`s, and `@container` queries, are not corrected.
- Until the page's ask is answered, a few milliseconds after it starts, a page in a zoomed frame draws at 100%.
- After a reload the canvas scrolls the page back where it was (X65). The bridge reports the scroll as WebKit gives it, so the page comes back to another place when the zoom changed in between.
