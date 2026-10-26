// What the design canvas does on a change (X65): which page the agent is
// writing, and when the shown page loads again. Pure: the store is
// designStore.ts.

import type { DesignChanged } from "./protocol";
import { pageOfPath, pagePath } from "./designPage";
import type { DragOver, DragResult, Layer } from "./designBridge";
import type { EditOp } from "./designEdits";

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
 *  sync's own files (`_ds_sync.json`, `_ds_manifest.json`). A session
 *  design's design system is its pinned copy, its own `system/` (X65). */
export function reloadsPage(change: DesignChanged, shown: { design: string; system: string; page: string }): boolean {
  if (change.design === shown.design) return change.paths.some((p) => p === pagePath(shown.page) || p.startsWith("assets/") || (p.startsWith("system/") && linkedBySystem(p.slice("system/".length))));
  if (change.system === shown.system) return change.paths.some(linkedBySystem);
  return false;
}

/** Whether a change to a session design is to its own copy of its design
 *  system (`system/`), as **Update** writes it: its kit, the Inspector's
 *  tokens and the Palette's snippets, is read again (X65). */
export function changesOwnSystem(change: DesignChanged): boolean {
  return change.design !== null && change.paths.some((p) => p.startsWith("system/"));
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

/** What the editor does on a key in Edit mode. */
export type EditKey = "next" | "prev" | "delete" | "duplicate" | "wrap" | "unwrap" | "copy" | "paste" | "undo" | "redo";

/** What a key does on the canvas. */
export type KeyAct = "toggle" | "toggleEdit" | "escape" | EditKey;

/** The canvas's keys by their ids (runActions' keyId). Delete is both
 *  keys: a Mac keyboard's key labelled delete is Backspace. */
const KEY_ACTS: Record<string, KeyAct> = {
  c: "toggle",
  v: "toggleEdit",
  escape: "escape",
  tab: "next",
  "shift+tab": "prev",
  delete: "delete",
  backspace: "delete",
  "cmd+d": "duplicate",
  "alt+cmd+g": "wrap",
  "shift+alt+cmd+g": "unwrap",
  "cmd+c": "copy",
  "cmd+v": "paste",
  "cmd+z": "undo",
  "shift+cmd+z": "redo",
};

/** What key `id` (runActions' keyId) does on the canvas: C switches
 *  Comment on and off (`toggle`), V Edit (`toggleEdit`), Esc closes the
 *  comment box, selects the parent or leaves the mode; in Edit mode Tab,
 *  ⇧Tab, Delete, ⌘D, ⌥⌘G, ⇧⌥⌘G, ⌘C, ⌘V, ⌘Z and ⇧⌘Z are the editor's. Null
 *  for any other key, and for every key while typing: Esc in a field such
 *  as the chat's composer is that field's (it stops the agent), and the
 *  comment box's own field closes the box itself; and ⌘C while text is
 *  selected (`textSelected`), which copies the text. */
export function keyAct(id: string, typing: boolean, textSelected = false): KeyAct | null {
  // ⌘C with text selected in the app copies the text.
  if (typing || (id === "cmd+c" && textSelected)) return null;
  return KEY_ACTS[id] ?? null;
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
  /** A snapshot is previewed (History): the canvas is View only. */
  readOnly?: boolean;
}

/** C (`toggle`), V (`toggleEdit`), Esc, the View, Comment and Edit
 *  buttons, and `lock`: the agent started working. */
export type CanvasAct = "toggle" | "toggleEdit" | "escape" | "view" | "comment" | "edit" | "lock";

/** The canvas after `act`: entering Comment or Edit shows the rail;
 *  leaving Comment, by C or the View button, closes the box; Esc closes
 *  the box, else goes back to View. Edit is `locked` while the agent works,
 *  and left for View when it starts (`lock`); comments still work. */
export function canvasStep(s: CanvasState, act: CanvasAct, locked = false): CanvasState {
  // A snapshot previewed is View only: no Comment, no Edit, no box.
  if (s.readOnly) return { ...s, mode: "view", box: false };
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
/** A click on a layer in Layers: the canvas in Edit, entered if need be,
 *  where the layer is selected; null while the agent works and Edit is
 *  locked, so the click selects nothing the page would not show. */
export function layerPick(s: CanvasState, locked: boolean): CanvasState | null {
  return locked || s.readOnly ? null : canvasStep(s, "edit");
}

/** The right rail's tabs: Layers (Edit), Inspector, Palette, Comments and
 *  History. */
export type RailTab = "layers" | "inspector" | "palette" | "comments" | "history";

/** The rail's tab entering mode `after` from `before` shows: Layers for
 *  Edit, Comments for Comment; null for none. */
export function modeEntered(before: CanvasMode, after: CanvasMode): RailTab | null {
  if (before === after) return null;
  return after === "edit" ? "layers" : after === "comment" ? "comments" : null;
}

/** The chat panel, and whether entering Edit folded it. */
export interface ChatPanel {
  open: boolean;
  foldedForEdit: boolean;
}

/** The chat after the mode goes from `before` to `after`: entering Edit
 *  folds an open chat so the canvas has room, and leaving Edit opens it
 *  again when that folded it; one the user folded, or opened meanwhile,
 *  stays as they left it. */
export function chatAfter(before: CanvasMode, after: CanvasMode, chat: ChatPanel): ChatPanel {
  if (before !== "edit" && after === "edit") return chat.open ? { open: false, foldedForEdit: true } : chat;
  if (before === "edit" && after !== "edit") return { open: chat.open || chat.foldedForEdit, foldedForEdit: false };
  return chat;
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

/** What the editor has when a key comes: the mode, the selection and the
 *  page's tree, whether an element was copied, and whether the agent works. */
export interface EditorState {
  mode: CanvasMode;
  selected: string | null;
  layers: Layer[];
  copied: boolean;
  locked: boolean;
  /** A snapshot is previewed: no key is the canvas's. */
  readOnly?: boolean;
}

/** What a key does: a step of the canvas's mode, a selection, an edit of
 *  the selected element, a copy, a paste after it, undo or redo, something
 *  to say, or `none`, an editor's key taken with nothing to do (so it never
 *  reaches the app's own shortcut, as ⌘D's Split pane). Null: not the
 *  canvas's key. */
export type EditorStep =
  | { kind: "canvas"; act: CanvasAct }
  | { kind: "select"; mid: string | null }
  | { kind: "edit"; op: "delete" | "duplicate" | "wrap" | "unwrap"; mid: string }
  | { kind: "copy"; mid: string }
  | { kind: "paste"; after: string | null }
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "say"; text: string }
  | { kind: "none" };

/** The step a key (keyAct) makes: Esc selects the parent in Edit mode,
 *  nothing past the body, and with nothing selected leaves the mode; the
 *  editor's keys work on the selection in Edit mode, and are taken with
 *  nothing selected; ⌘V pastes once something was copied; ⌘Z and ⇧⌘Z wait
 *  while the agent works. */
export function editorStep(s: EditorState, act: KeyAct | null): EditorStep | null {
  if (act === null || s.readOnly) return null;
  if (act === "toggle" || act === "toggleEdit") return { kind: "canvas", act };
  if (act === "escape") return s.mode === "edit" && s.selected ? { kind: "select", mid: layerStep(s.layers, s.selected, "parent") } : { kind: "canvas", act };
  if (s.mode !== "edit") return null;
  if (act === "undo" || act === "redo") return s.locked ? { kind: "none" } : { kind: act };
  if (act === "paste") return s.copied ? { kind: "paste", after: s.selected } : { kind: "say", text: "Copy an element with ⌘C first" };
  if (!s.selected) return { kind: "none" };
  if (act === "next" || act === "prev") return { kind: "select", mid: layerStep(s.layers, s.selected, act) };
  if (act === "copy") return { kind: "copy", mid: s.selected };
  return { kind: "edit", op: act, mid: s.selected };
}

/** Whether the toolbar's undo button works: a change to undo, the agent
 *  not at work, as ⌘Z, and no snapshot previewed. */
export function undoOpen(s: { locked: boolean; changes: number; readOnly?: boolean }): boolean {
  return !s.locked && !s.readOnly && s.changes > 0;
}

/** What the canvas tells a page when the bridge reports its ids: on the
 *  first report of a load (`rev` not `reported` yet), where it was scrolled
 *  (none at the top) and, in Edit mode, which element is selected; null on
 *  the reports after, which the page's scripts set off. */
export function onReport(s: { rev: number; reported: number; scrolled: { x: number; y: number }; mode: CanvasMode; selected: string | null }): { scroll: { x: number; y: number } | null; select: string | null | undefined } | null {
  if (s.reported === s.rev) return null;
  return { scroll: s.scrolled.x || s.scrolled.y ? s.scrolled : null, select: s.mode === "edit" ? s.selected : undefined };
}

/** An element as the hint line names it: the text of its first part that
 *  has text, the first leaf of its branch in the tree, cut to 24
 *  characters; else its tag and id. */
function layerName(layers: Layer[], mid: string): string {
  const at = layers.findIndex((l) => l.mid === mid);
  if (at < 0) return mid;
  for (let i = at; i < layers.length && (i === at || layers[i].depth > layers[at].depth); i++) {
    const leaf = (layers[i + 1]?.depth ?? -1) <= layers[i].depth;
    if (leaf && layers[i].text) return [...layers[i].text].length > 24 ? `${[...layers[i].text].slice(0, 23).join("")}…` : layers[i].text;
  }
  return `${layers[at].tag} ${mid}`;
}

/** The hint line while an element (`mid`) or a Palette snippet (null) is
 *  dragged over the page: "Drop to move above General", "Drop to insert
 *  after Git"; null while it would drop nowhere. */
export function dropHint(layers: Layer[], drag: DragOver): string | null {
  const p = drag.place;
  if (!p) return null;
  const where = drag.mid === null && p.where === "below" ? "after" : p.where;
  return `Drop to ${drag.mid === null ? "insert" : "move"} ${where} ${layerName(layers, p.ref)}`;
}

/** The hint line: where a drag over the page would drop while it would
 *  ({@link dropHint}), else what the mode does. */
export function hintLine(mode: CanvasMode, layers: Layer[], drag: DragOver | null): string {
  return (drag && dropHint(layers, drag)) ?? modeHint(mode);
}

/** The edit a drag in the page makes: a move for an element dropped, a
 *  restyle for a size or a place (the live page already shows it, so one
 *  refused loads the page again), an insert of the Palette's snippet
 *  `snippet` at its drop; null for a drop of none, or nowhere. */
export function dragEdit(r: DragResult, snippet: string | null): { op: EditOp; reload: boolean } | null {
  if (r.kind === "move") return { op: { kind: "move", mid: r.mid, place: r.place }, reload: false };
  if (r.kind === "style") return { op: { kind: "restyle", mid: r.mid, set: r.set }, reload: true };
  return snippet !== null && r.place ? { op: { kind: "insert", place: r.place, html: snippet }, reload: false } : null;
}

/** The edit a snippet picked in the Palette makes: inserted after the
 *  selection, else at the end of the body. */
export function pickEdit(selected: string | null, snippet: string): EditOp {
  return { kind: "insert", place: selected ? { where: "below", ref: selected } : null, html: snippet };
}

/** What last told whether the user is in a session's Design tab: a press
 *  or a focus, in it or elsewhere (WebKit focuses no button on a click,
 *  so a press counts as much as a focus), or the tab opened: by the app
 *  itself, on `design.open` or a toast's Open, or by the user picking it,
 *  whose button is outside the canvas (X65). */
export type TabKeysEvent = { kind: "pointer" | "focus"; inside: boolean } | { kind: "opened" };

/** Whether the user is in a session's Design tab after `e`. */
export function inTabAfter(e: TabKeysEvent): boolean {
  return e.kind === "opened" || e.inside;
}

/** Whether a canvas takes its keys (C, V, Esc, the editor's, ⌘0, ⌘= and
 *  ⌘-): the design screen's whenever it is shown, a session's Design tab's
 *  while the user is in it (`inTab`), so the session's terminals and chat
 *  beside it keep theirs. */
export function canvasTakesKeys(session: boolean, inTab: boolean): boolean {
  return !session || inTab;
}
