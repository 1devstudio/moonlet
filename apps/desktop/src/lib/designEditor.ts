// The visual editor's state (X65): each page's source as the editor edits
// it, saved with `design.write_page` over the version it was read at; the
// changes since the design was opened, for undo and redo; the edits by hand
// not told to the agent yet; the element copied; and the edit a save lost
// to a change on disk, for the yellow bar. What an edit does is designEdits.ts.

import { create } from "zustand";
import { DaemonError, rpc } from "./daemon";
import { ownPages, reloadPage } from "./designStore";
import { errorToast } from "./store";
import { M, type DesignPageText } from "./protocol";
import type { ChatImage } from "./attachments";
import { wsKey } from "./workspaces";
import { applyEdit, copyElement, EditRefused, editLine, editsMessage, highestMid, type Edit, type EditOp } from "./designEdits";
import { NO_UNDO, dropPage, pendingAfter, pushStep, redoStep, undoStep, type Pending, type Step, type Undo } from "./designUndo";

interface EditorState {
  /** Each page's source (`wsKey/slug/page`) and the version on disk it was
   *  read or last saved at. */
  sources: Record<string, DesignPageText>;
  /** Each design's (`wsKey/slug`) changes since it was opened. */
  undo: Record<string, Undo>;
  /** Each design's edits by hand not told to its agent yet. */
  pending: Record<string, Pending[]>;
  /** The edit by hand a save lost to a change on disk, per design, as its
   *  line says it; null once dismissed. */
  unsaved: Record<string, string | null>;
}

const EMPTY: EditorState = { sources: {}, undo: {}, pending: {}, unsaved: {} };

export const useEditor = create<EditorState>(() => EMPTY);

const itemKey = (host: string, workspace: string, slug: string) => `${wsKey(host, workspace)}/${slug}`;
const pageKey = (host: string, workspace: string, slug: string, page: string) => `${itemKey(host, workspace, slug)}/${page}`;

/** A page's saves: the one on its way, and whether the source changed since
 *  it was sent, so one more follows with the latest. */
interface Saving {
  busy: Promise<void> | null;
  again: boolean;
}
const saving: Record<string, Saving> = {};
/** The highest id number each page has had since it was first read: a new
 *  element never takes the id of one deleted since. */
const highest: Record<string, number> = {};
/** The latest change of each page that a save took. */
const savedStep: Record<string, number> = {};
let nextStep = 1;

/** Forgets every page, change and edit (tests). */
export function resetEditor() {
  useEditor.setState(EMPTY, true);
  for (const k of Object.keys(saving)) delete saving[k];
  for (const k of Object.keys(savedStep)) delete savedStep[k];
  for (const k of Object.keys(highest)) delete highest[k];
  for (const k of Object.keys(clips)) delete clips[k];
}

/** Reads a page's source and version (`design.page`), as the canvas loads
 *  it; not while a save of it is on its way, which has edits the text read
 *  may not and decides what is there. */
export async function loadPageSource(host: string, workspace: string, slug: string, page: string): Promise<void> {
  const key = pageKey(host, workspace, slug, page);
  if (saving[key]?.busy) return;
  const text = await rpc<DesignPageText>(host, M.designPage, { workspace, slug, page });
  if (!saving[key]?.busy) setSource(key, text);
}

function setSource(key: string, text: DesignPageText) {
  highest[key] = Math.max(highest[key] ?? 0, highestMid(text.html));
  useEditor.setState((s) => ({ sources: { ...s.sources, [key]: text } }));
}

/** `op` made on a page's source, which is saved: the change can be undone,
 *  and its edit by hand goes with the next message. `selected` is the
 *  element selected before it. {@link EditRefused} when it cannot be made. */
export function editPage(host: string, workspace: string, slug: string, page: string, op: EditOp, selected: string | null): Edit {
  const key = pageKey(host, workspace, slug, page);
  const source = useEditor.getState().sources[key];
  if (!source) throw new EditRefused("The page is still loading");
  const edit = applyEdit(source.html, op, highest[key] ?? 0);
  highest[key] = Math.max(highest[key] ?? 0, highestMid(edit.html));
  const step: Step = { id: nextStep++, page, before: source.html, after: edit.html, edit: { page, ...edit.change }, selectBefore: selected, selectAfter: edit.select };
  const design = itemKey(host, workspace, slug);
  useEditor.setState((s) => ({
    sources: { ...s.sources, [key]: { ...source, html: edit.html } },
    undo: { ...s.undo, [design]: pushStep(s.undo[design] ?? NO_UNDO, step) },
    pending: { ...s.pending, [design]: pendingAfter(s.pending[design] ?? [], step, "do") },
  }));
  void save(host, workspace, slug, page).catch(errorToast);
  return edit;
}

/** ⌘Z: the design's latest change undone, its page saved as it was
 *  before and loaded again on the canvas; the page and the element to
 *  select, or null when there is nothing to undo. */
export function undoEdit(host: string, workspace: string, slug: string): Promise<{ page: string; select: string | null } | null> {
  return travel(host, workspace, slug, "undo");
}

/** ⇧⌘Z: the latest change undone made again. */
export function redoEdit(host: string, workspace: string, slug: string): Promise<{ page: string; select: string | null } | null> {
  return travel(host, workspace, slug, "redo");
}

async function travel(host: string, workspace: string, slug: string, act: "undo" | "redo"): Promise<{ page: string; select: string | null } | null> {
  const design = itemKey(host, workspace, slug);
  const moved = (act === "undo" ? undoStep : redoStep)(useEditor.getState().undo[design] ?? NO_UNDO);
  if (!moved) return null;
  const { step } = moved;
  const key = pageKey(host, workspace, slug, step.page);
  const source = useEditor.getState().sources[key];
  if (!source) return null;
  useEditor.setState((s) => ({
    sources: { ...s.sources, [key]: { ...source, html: act === "undo" ? step.before : step.after } },
    undo: { ...s.undo, [design]: moved.undo },
    pending: { ...s.pending, [design]: pendingAfter(s.pending[design] ?? [], step, act) },
  }));
  await save(host, workspace, slug, step.page);
  // The live page cannot take an edit back: it loads again, as saved.
  if (useEditor.getState().sources[key]?.html === (act === "undo" ? step.before : step.after)) reloadPage(host, workspace, slug, step.page);
  return { page: step.page, select: act === "undo" ? step.selectBefore : step.selectAfter };
}

/** Saves a page's latest source over the version it was read at: at once
 *  when no save of it is on its way, else once that one is back, with
 *  every change made meanwhile, so saves keep their order. */
function save(host: string, workspace: string, slug: string, page: string): Promise<void> {
  const key = pageKey(host, workspace, slug, page);
  const s = (saving[key] ??= { busy: null, again: false });
  if (s.busy) {
    s.again = true;
    return s.busy;
  }
  const run = async () => {
    do {
      s.again = false;
      const source = useEditor.getState().sources[key];
      if (!source) return;
      const html = source.html;
      const step = nextStep - 1;
      let version: string;
      try {
        ({ version } = await rpc<{ version: string }>(host, M.designWritePage, { workspace, slug, page, html, base_version: source.version }));
      } catch (e) {
        if (e instanceof DaemonError && e.code === "stale") return lost(host, workspace, slug, page);
        throw e;
      }
      savedStep[key] = step;
      useEditor.setState((st) => ({ sources: { ...st.sources, [key]: { html: st.sources[key]?.html ?? html, version } } }));
    } while (s.again);
  };
  s.busy = run().finally(() => {
    s.busy = null;
  });
  return s.busy;
}

/** The user's message to a design's agent, with the edits by hand not told
 *  yet before it; once it is sent, those are told. */
export async function sendWithEdits(host: string, workspace: string, slug: string, agent: number, text: string, images: ChatImage[]): Promise<void> {
  const design = itemKey(host, workspace, slug);
  const told = useEditor.getState().pending[design] ?? [];
  await rpc(host, M.chatSend, { id: agent, text: editsMessage(told, text), images });
  useEditor.setState((s) => ({ pending: { ...s.pending, [design]: (s.pending[design] ?? []).filter((p) => !told.includes(p)) } }));
}

/** The element copied with ⌘C in each design, as its source: ⌘V pastes
 *  it into any page of the same design. */
const clips: Record<string, string> = {};

/** ⌘C: copies element `mid` of a page; false when the page has none. */
export function copyElementOf(host: string, workspace: string, slug: string, page: string, mid: string): boolean {
  const source = useEditor.getState().sources[pageKey(host, workspace, slug, page)];
  const copied = source ? copyElement(source.html, mid) : null;
  if (copied === null) return false;
  clips[itemKey(host, workspace, slug)] = copied;
  return true;
}

/** ⌘V: the design's copied element pasted into a page after element
 *  `after`, or at the end of its body; null when nothing was copied. */
export function pasteInto(host: string, workspace: string, slug: string, page: string, after: string | null): Edit | null {
  const copied = clips[itemKey(host, workspace, slug)];
  return copied === undefined ? null : editPage(host, workspace, slug, page, { kind: "paste", after, html: copied }, after);
}

/** A save refused because the page changed on disk since it was read:
 *  the page is read and loaded again, its changes forgotten (undoing them
 *  would undo the other writer's), the edits by hand the save lost taken
 *  back, and the yellow bar names the last of them. */
async function lost(host: string, workspace: string, slug: string, page: string): Promise<void> {
  const key = pageKey(host, workspace, slug, page);
  const design = itemKey(host, workspace, slug);
  const saved = savedStep[key] ?? 0;
  const st = useEditor.getState();
  const gone = (st.undo[design] ?? NO_UNDO).done.filter((step) => step.page === page && step.id > saved);
  const ids = new Set(gone.map((step) => step.id));
  const last = gone.at(-1);
  useEditor.setState((s) => ({
    undo: { ...s.undo, [design]: dropPage(s.undo[design] ?? NO_UNDO, page) },
    pending: { ...s.pending, [design]: (s.pending[design] ?? []).filter((p) => !ids.has(p.id)) },
    unsaved: { ...s.unsaved, [design]: last ? editLine(last.edit) : (s.unsaved[design] ?? null) },
  }));
  setSource(key, await rpc<DesignPageText>(host, M.designPage, { workspace, slug, page }));
  reloadPage(host, workspace, slug, page);
}

/** Puts the yellow bar away. */
export function dismissUnsaved(host: string, workspace: string, slug: string) {
  const design = itemKey(host, workspace, slug);
  useEditor.setState((s) => ({ unsaved: { ...s.unsaved, [design]: null } }));
}

/** A page's source as the editor has it, and its version; undefined until read. */
export function sourceOf(s: EditorState, host: string, workspace: string, slug: string, page: string): DesignPageText | undefined {
  return s.sources[pageKey(host, workspace, slug, page)];
}

const NONE_PENDING: Pending[] = [];

/** A design's edits by hand not told to its agent yet. */
export function pendingOf(s: EditorState, host: string, workspace: string, slug: string): Pending[] {
  return s.pending[itemKey(host, workspace, slug)] ?? NONE_PENDING;
}

/** The edit a save lost to a change on disk, for the yellow bar; or null. */
export function unsavedOf(s: EditorState, host: string, workspace: string, slug: string): string | null {
  return s.unsaved[itemKey(host, workspace, slug)] ?? null;
}

/** Checks of pages changed on disk, on their way. */
const checking = new Set<Promise<void>>();

/** A page the editor has read changed on disk: read again, it loads on
 *  the canvas again unless it is the version the editor has, its own save.
 *  While a save is on its way that save decides: refused, it loads the
 *  page; else the change was that save. Another writer's page makes the
 *  page's changes forgotten, as undoing them would undo that writer's. */
async function changedOnDisk(host: string, workspace: string, slug: string, page: string): Promise<void> {
  const key = pageKey(host, workspace, slug, page);
  if (saving[key]?.busy) return;
  const text = await rpc<DesignPageText>(host, M.designPage, { workspace, slug, page });
  const now = useEditor.getState().sources[key];
  if (saving[key]?.busy || !now || text.version === now.version) return;
  const design = itemKey(host, workspace, slug);
  setSource(key, text);
  useEditor.setState((s) => ({ undo: { ...s.undo, [design]: dropPage(s.undo[design] ?? NO_UNDO, page) } }));
  reloadPage(host, workspace, slug, page);
}

ownPages((host, workspace, slug, page) => {
  if (!useEditor.getState().sources[pageKey(host, workspace, slug, page)]) return false;
  const check: Promise<void> = changedOnDisk(host, workspace, slug, page)
    .catch(() => reloadPage(host, workspace, slug, page))
    .finally(() => checking.delete(check));
  checking.add(check);
  return true;
});

/** Waits for the checks of pages changed on disk (tests). */
export async function settleChecks(): Promise<void> {
  while (checking.size) await Promise.all(checking);
}

/** Waits for every save on its way. */
export async function settleSaves(): Promise<void> {
  while (Object.values(saving).some((s) => s.busy)) await Promise.all(Object.values(saving).map((s) => s.busy?.catch(() => {})));
}

/** The changes of a design that can be undone and redone. */
export function undoOf(s: EditorState, host: string, workspace: string, slug: string): Undo {
  return s.undo[itemKey(host, workspace, slug)] ?? NO_UNDO;
}
