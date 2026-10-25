// What the design canvas does on a change (X65): which page the agent is
// writing, and when the shown page loads again. Pure: the store is
// designStore.ts.

import type { DesignChanged } from "./protocol";
import { pageOfPath, pagePath } from "./designPage";
import type { Layer } from "./designBridge";

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
 *  Comment outlines and pins elements, Edit selects and edits them. */
export type CanvasMode = "view" | "comment" | "edit";

/** The hint line's text for a mode. */
export function modeHint(mode: CanvasMode): string {
  if (mode === "edit") return "Click selects · double-click edits text · Esc selects the parent · Tab the next sibling";
  return mode === "comment" ? "Hover outlines elements · click pins a comment · ⌥-click picks the parent" : "View: the page runs as in a browser, so its links, menus and scripts work";
}

/** A key pressed on the design screen or in its page. */
export interface ModeKeyPress {
  key: string;
  /** The key's place (`KeyG`): with ⌥ held, `key` is a composed character. */
  code?: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** In a field, where the key is text. */
  typing: boolean;
}

/** What the editor does on a key in Edit mode. */
export type EditKey = "next" | "prev" | "delete" | "duplicate" | "wrap" | "unwrap" | "copy" | "paste" | "undo" | "redo";

/** What a key does on the canvas: C switches Comment on and off
 *  (`toggle`), V Edit (`toggleEdit`), Esc closes the comment box, selects
 *  the parent or leaves the mode; in Edit mode Tab, ⇧Tab, Delete, ⌘D,
 *  ⌥⌘G, ⇧⌥⌘G, ⌘C, ⌘V, ⌘Z and ⇧⌘Z are the editor's. Null for any other
 *  key, and for all but Esc while typing. */
export function keyAct(k: ModeKeyPress): "toggle" | "toggleEdit" | "escape" | EditKey | null {
  if (k.typing) return null;
  if (k.key === "Escape") return "escape";
  if (k.ctrl) return null;
  const key = k.alt && k.code?.startsWith("Key") ? k.code.slice(3).toLowerCase() : k.key.length === 1 ? k.key.toLowerCase() : k.key;
  const mods = `${k.shift ? "⇧" : ""}${k.alt ? "⌥" : ""}${k.meta ? "⌘" : ""}`;
  const acts: Record<string, "toggle" | "toggleEdit" | EditKey> = {
    c: "toggle",
    v: "toggleEdit",
    Tab: "next",
    "⇧Tab": "prev",
    Delete: "delete",
    Backspace: "delete",
    "⌘d": "duplicate",
    "⌥⌘g": "wrap",
    "⇧⌥⌘g": "unwrap",
    "⌘c": "copy",
    "⌘v": "paste",
    "⌘z": "undo",
    "⇧⌘z": "redo",
  };
  return acts[mods + key] ?? null;
}

/** Where a key is text: a field or an editable element. The bridge script
 *  (`design_bridge.js`) asks the same of an element in a page. */
export const TYPING_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/** Whether a key pressed on `el` is text, not a shortcut: in a field, an
 *  editable element, or a terminal (which a page never has). */
export function isTyping(el: Element | null): boolean {
  return !!el?.closest(`${TYPING_SELECTOR}, .xterm`);
}

/** What the design screen's canvas shows around the page: its mode, whether
 *  a comment box is open, and whether the right rail is shown. */
export interface CanvasState {
  mode: CanvasMode;
  box: boolean;
  rail: boolean;
}

/** C (`toggle`), V (`toggleEdit`), Esc, the View, Comment and Edit
 *  buttons, and `lock`: the agent started working. */
export type CanvasAct = "toggle" | "toggleEdit" | "escape" | "view" | "comment" | "edit" | "lock";

/** The canvas after `act`: entering Comment or Edit shows the rail;
 *  leaving Comment, by C or the View button, closes the box; Esc closes
 *  the box, else goes back to View. Edit is `locked` while the agent works,
 *  and left for View when it starts (`lock`); comments still work. */
export function canvasStep(s: CanvasState, act: CanvasAct, locked = false): CanvasState {
  switch (act) {
    case "toggle":
      return s.mode === "comment" ? { ...s, mode: "view", box: false } : { ...s, mode: "comment", rail: true };
    case "comment":
      return { ...s, mode: "comment", rail: true };
    case "toggleEdit":
      if (s.mode === "edit") return { ...s, mode: "view" };
      return locked ? s : { mode: "edit", box: false, rail: true };
    case "edit":
      return locked ? s : { mode: "edit", box: false, rail: true };
    case "lock":
      return s.mode === "edit" ? { ...s, mode: "view" } : s;
    case "view":
      return { ...s, mode: "view", box: false };
    case "escape":
      return s.box ? { ...s, box: false } : { ...s, mode: "view" };
  }
}
/** The right rail's tabs so far: Layers (Edit) and Comments. */
export type RailTab = "layers" | "comments";

/** What entering mode `after` from `before` does around the canvas: the
 *  rail's tab it shows (Layers for Edit, Comments for Comment), and whether
 *  the chat folds to its rail, as it does for Edit so the canvas has room. */
export function modeEntered(before: CanvasMode, after: CanvasMode): { tab: RailTab | null; foldChat: boolean } {
  if (before === after) return { tab: null, foldChat: false };
  if (after === "edit") return { tab: "layers", foldChat: true };
  return { tab: after === "comment" ? "comments" : null, foldChat: false };
}

/** The ancestors of element `mid`, from the body, and the element: the
 *  breadcrumb over the page in Edit mode (`body › main m20 › section m24`).
 *  None when the page has no such element. */
export function breadcrumb(layers: Layer[], mid: string): { mid: string; label: string }[] {
  const at = layers.findIndex((l) => l.mid === mid);
  if (at < 0) return [];
  const path: Layer[] = [layers[at]];
  for (let i = at - 1; i >= 0 && path[0].depth > 0; i--) if (layers[i].depth < path[0].depth) path.unshift(layers[i]);
  return path.map((l) => ({ mid: l.mid, label: l.tag === "body" ? "body" : `${l.tag} ${l.mid}` }));
}

/** The element selected after Esc (`parent`, none above the body), Tab
 *  (`next` sibling) or ⇧Tab (`prev`): a sibling past the ends keeps the
 *  selection. None when the page has no element `mid`. */
export function layerStep(layers: Layer[], mid: string, to: "parent" | "next" | "prev"): string | null {
  const at = layers.findIndex((l) => l.mid === mid);
  if (at < 0) return null;
  const depth = layers[at].depth;
  if (to === "parent") {
    for (let i = at - 1; i >= 0; i--) if (layers[i].depth < depth) return layers[i].mid;
    return null;
  }
  const dir = to === "next" ? 1 : -1;
  for (let i = at + dir; i >= 0 && i < layers.length && layers[i].depth >= depth; i += dir) if (layers[i].depth === depth) return layers[i].mid;
  return mid;
}
