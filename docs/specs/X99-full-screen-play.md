# X99 — Play a design full screen

- **Status:** draft
- **Priority / phase:** P1 · phase 4
- **PRD refs:** X65 (Design mode: the canvas, View mode), X64 (design systems)
- **Related ADRs:** [0013](../adr/0013-design-systems-and-designs.md)

## Summary

The canvas ([X65](X65-design-mode.md)) shows a design's page at a chosen viewport, scaled to fit beside the chat, with the toolbar and the page tabs around it. That is right for commenting and editing, but checking how a page really feels needs it at full size: scrolled, resized, clicked through. X99 adds **Play**: the page takes over the whole app window, live, at the window's real size (**Fill**) or at the canvas's viewport scaled to fit (**Fit**). ←/→ go through the design's pages. **Download** saves the page as one standalone `.html` file, its design system's styles, fonts, images and scripts inlined, to open in any browser or hand to someone. Esc or the back arrow return to the canvas.

## User journey

1. On a design's screen, the canvas shows `index` at Desktop 1440×900, 62%. The user clicks **Play** in the canvas toolbar (or presses P).
2. The page fills the app window under a thin bar: a back arrow, "Settings page · index", `1 / 3`, Download, and a Fill | Fit switch with Fill on. The page is laid out at the window's size, at 100%, and scrolls with the wheel and the trackpad; its links, menus and scripts run as in View mode.
3. The user resizes the window: the page reflows to the new size.
4. Fit shows the page at the canvas's viewport, 1440×900, scaled down to fit the window whole and centred.
5. → shows the next page, `settings`; ← goes back. The counter follows.
6. The agent writes `settings.html` again while it shows: it loads again, as on the canvas.
7. Download opens a save dialog named `settings.html`. The saved file opens in Safari looking as it does in moonlet, with no moonlet running.
8. Esc, or the back arrow, returns to the canvas, which now shows `settings`, the page last played.

## Behaviour and acceptance criteria

- [ ] The canvas toolbar has **Play** (title "Play full screen (P)") wherever a page shows: a workspace design, a session design's Design tab, a project design and a snapshot previewed. P outside a text field does the same. In Overview it plays the first page.
- [ ] Play covers the whole app window, above the sidebar, columns and dialogs, until Esc or the back arrow; nothing behind it takes the pointer or keys. The window's traffic lights stay usable, and the bar drags the window.
- [ ] The bar shows the design's name and the page, the page's place among the design's pages (`2 / 3`), Download, and Fill | Fit.
- [ ] **Fill** (the default) lays the page out at the area under the bar, at 100%, and again whenever the window's size changes. **Fit** shows it at the canvas's viewport, scaled to fit that area, never above 100%, centred.
- [ ] The page is live as in View mode: its scripts, links and menus run, and it scrolls, with no outlines, pins or editing. It is framed like the canvas's page (sandboxed, on the page's own host, under the no-network CSP), so a page that never stops running freezes neither the window nor the bar (X64, site isolation).
- [ ] ←/→ (outside the page) show the previous and next page of the design, stopping at the first and the last. A snapshot previewed goes through the snapshot's pages.
- [ ] The page loads again when its file or its design system changes, as on the canvas; a page that is gone shows the next page there is, or returns to the canvas when none is left.
- [ ] Esc, or the back arrow, returns to the canvas showing the page last played, at the canvas's viewport and zoom as they were.
- [ ] **Download** saves the page shown as one `.html` file through a save dialog, named after the page (`settings.html`). The file holds everything the page loads from its design's folder and its design system: stylesheets (with their `@import`s) inlined as `<style>`, scripts as inline `<script>`, and images, fonts and other `url()`s as `data:` URLs. An address outside the design's files (`https:`, `data:`, `#…`) is left as it is. A snapshot previewed downloads the snapshot's page.
- [ ] Download says where it saved (`Saved settings.html`), and says why when it could not (a file it could not read is left as its address, and listed).

## UI

```
┌───────────────────────────────────────────────────────────────────────────┐
│ ●●●  ←  Settings page · settings   2 / 3              ⤓   [ Fill | Fit ] │  36 px bar, panel colour
├───────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│              the page, live, at the area's size (Fill)                    │
│              or the viewport scaled to fit, centred (Fit)                 │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

- Play is an icon-and-label button ("▷ Play") in the canvas toolbar, before the Canvas mode switch.
- The bar leaves room for the traffic lights on the left, as the app's top bar does. Back has the title "Back (Esc)"; Download "Download as HTML".
- Fit's empty space around the page is the app's background.

## Protocol and RPCs

- `design.standalone` ([`DesignFile`] → `{ html: String, missing: [String] }`): the page at `path` in a workspace's, a session's or a project's design folder (as `design.file` names it, a snapshot's page included), with everything it loads from the design's files inlined. `missing` lists the addresses it could not read. Read through the same checks as `design.file`: nothing outside the design's folder and its design system.
- App command `design_download(host, place, path, name)`: asks the daemon of the host for `design.standalone`, shows the save dialog, and writes the file the user picked. The webview never writes a file itself.

## Data and config

None: Fill or Fit is not kept; every Play starts with Fill.

## Security considerations

- The played page is untrusted HTML, framed as on the canvas: `sandbox="allow-scripts"`, its own host, the no-network CSP, site isolation (X64, ADR 0013).
- `design.standalone` resolves every address against the page's folder and reads only through `design.file`'s rules, so a page cannot pull a file from outside its design and design system into the download. The download is written only where the user picked, by the app's Rust side.
- The downloaded file runs the page's own scripts when opened in a browser, as any HTML file does; moonlet's scripts (release, bridge) are never in it.

## Out of scope

- Playing a design system's card full screen.
- Recording, presenting to another screen, or a device frame around the page.
- Downloading a whole design (every page) or a zip; Download saves the page shown.

## Test plan

- `moonlet-core` unit tests for the inliner, with a page, a stylesheet with an `@import` and a font, an image and a script: inlined as written above; external, `data:` and fragment addresses untouched; an address leaving the folder refused and listed in `missing`.
- `moonletd` test: `design.standalone` on a workspace design's page and on a snapshot's page.
- Vitest (`lib/`): the page list's previous and next and the counter; Fill's and Fit's frame size and scale for a given area and viewport; the page the canvas returns to.
- e2e `design-play.e2e.ts`: Play opens the page over the window with the bar; Fill sizes it to the area and Fit to the viewport; ←/→ change page; the page loads again when written; Esc returns to the canvas on the last page; P opens it. Download is checked through `design.standalone` and the save path by a stubbed dialog.
- By hand: wheel and trackpad scrolling in Fill; the downloaded file in Safari.

## Open questions

- None.
