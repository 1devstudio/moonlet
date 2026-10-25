// What the design canvas does on a change (X65): which page the agent is
// writing, and when the shown page loads again. Pure: the store is
// designStore.ts.

import type { DesignChanged } from "./protocol";
import { pageOfPath, pagePath } from "./designPage";

/** The pages (`index` for `pages/index.html`) a change to design `slug` wrote. */
export function changedPages(change: DesignChanged, slug: string): string[] {
  if (change.design !== slug) return [];
  return change.paths.flatMap((p) => {
    const page = pageOfPath(p);
    return page === null ? [] : [page];
  });
}

/** The page tab with the writing dot: one the latest change to the design
 *  wrote, while its agent works. */
export function writingPage(latest: string[], working: boolean): string | null {
  return working ? (latest[0] ?? null) : null;
}

/** Whether a change loads the shown page again: the shown page, or a file
 *  it links. Those are the design's `assets/`, and of its design system any
 *  `.css` file (`styles.css` and what it imports) and what is in `tokens/`
 *  and `fonts/`; not its cards, `README.md`, `.prompt.md` files or the
 *  sync's own files (`_ds_sync.json`, `_ds_manifest.json`). */
export function reloadsPage(change: DesignChanged, shown: { design: string; system: string; page: string }): boolean {
  if (change.design === shown.design) return change.paths.some((p) => p === pagePath(shown.page) || p.startsWith("assets/"));
  if (change.system === shown.system) return change.paths.some(linkedBySystem);
  return false;
}

/** A design system's file a page may link: a stylesheet, a token or a font. */
function linkedBySystem(path: string): boolean {
  return path.endsWith(".css") || path.startsWith("tokens/") || path.startsWith("fonts/");
}

/** The page the canvas shows: the one picked (null for Overview); once the
 *  picked page is gone, the first page, and before any page, index, which
 *  the agent is writing. */
export function canvasPage(picked: string | null, pages: string[]): string | null {
  if (picked === null) return null;
  return pages.includes(picked) ? picked : (pages[0] ?? "index");
}

/** What the canvas does with the pointer: View lets the page have it,
 *  Comment outlines and pins elements (Edit comes with the editor). */
export type CanvasMode = "view" | "comment";

/** The hint line's text for a mode. */
export function modeHint(mode: CanvasMode): string {
  return mode === "comment" ? "Hover outlines elements · click pins a comment · ⌥-click picks the parent" : "View: the page runs as in a browser, so its links, menus and scripts work";
}

/** A key pressed on the design screen, outside the app's ⌘ shortcuts. */
export interface ModeKeyPress {
  key: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** In a field, where the key is text. */
  typing: boolean;
}

/** What a key does to the canvas's mode: C switches Comment on and off, Esc
 *  closes the comment box or leaves Comment; null for any other key, and
 *  for C while typing or with a modifier. */
export function modeKey(k: ModeKeyPress): "comment" | "escape" | null {
  if (k.key === "Escape") return "escape";
  if (k.meta || k.ctrl || k.alt || k.shift || k.typing) return null;
  return k.key === "c" ? "comment" : null;
}

/** Where a key is text: a field or an editable element. The bridge script
 *  (`design_bridge.js`) asks the same of an element in a page. */
export const TYPING_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/** Whether a key pressed on `el` is text, not a shortcut: in a field, an
 *  editable element, or a terminal (which a page never has). */
export function isTyping(el: Element | null): boolean {
  return !!el?.closest(`${TYPING_SELECTOR}, .xterm`);
}
