// The visual editor's state (X65): each page's source as the editor edits
// it, saved with `design.write_page` over the version it was read at; the
// changes since the design was opened, for undo and redo; the edits by hand
// not told to the agent yet; the element copied; and the edit a save lost
// to a change on disk, for the yellow bar. What an edit does is designEdits.ts.

import { create } from "zustand";
import { DaemonError, rpc } from "./daemon";
import { itemKey, pageKey, registerPageOwner, reloadPage, sendComments } from "./designStore";
import { latestSends } from "./latestSend";
import { errorToast } from "./store";
import { latestPerKey } from "./prPoll";
import { M, type DesignComment, type DesignKit, type DesignPageText, type DesignPageWritten, type DesignSnapshot } from "./protocol";
import type { ChatImage } from "./attachments";
import { applyEdit, copyElement, EditRefused, editLine, editSaid, editsMessage, highestMid, type Edit, type EditOp } from "./designEdits";
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
  /** Each design's kit: its design system's tokens and snippet cards. */
  kits: Record<string, DesignKit>;
}

const EMPTY: EditorState = { sources: {}, undo: {}, pending: {}, unsaved: {}, kits: {} };

export const useEditor = create<EditorState>(() => EMPTY);


/** Each page's saves, one at a time, the latest source last. */
let saves = latestSends();
/** The highest id number each page has had since it was first read: a new
 *  element never takes the id of one deleted since. */
const highest: Record<string, number> = {};
/** The number of the next change, any page's: a change's identity. */
let nextStep = 1;
/** Each page's generation: one more at every change of its source in the
 *  editor, an edit's, an undo's, a save's or a read's. A read takes its
 *  answer only while the page is at the generation it started at, and a
 *  save takes the changes made up to the generation it sent. */
const gens: Record<string, number> = {};
/** A page's source changed in the editor. */
const touch = (key: string) => void (gens[key] = (gens[key] ?? 0) + 1);
/** Each page's changes, made, undone or redone, that no save took yet, with
 *  the page's generation after each, and what it did (editSaid), which its
 *  save tells the daemon for the snapshot of edits by hand. */
const notSaved: Record<string, { step: number; gen: number; said: string }[]> = {};
/** Change `step` made, undone or redone on a page's source: `said` is what it did. */
function changed(key: string, step: number, said: string) {
  touch(key);
  (notSaved[key] ??= []).push({ step, gen: gens[key], said });
}

/** Forgets every page, change and edit (tests). */
export function resetEditor() {
  useEditor.setState(EMPTY, true);
  saves = latestSends();
  for (const k of Object.keys(notSaved)) delete notSaved[k];
  for (const k of Object.keys(gens)) delete gens[k];
  for (const k of Object.keys(highest)) delete highest[k];
  for (const k of Object.keys(clips)) delete clips[k];
}

/** Reads a page's source and version (`design.page`), as the canvas loads
 *  it; not while a save of it is on its way, which has edits the text read
 *  may not and decides what is there. */
export async function loadPageSource(host: string, workspace: string, slug: string, page: string): Promise<void> {
  const text = await readPage(host, workspace, slug, page);
  if (text) setSource(pageKey(host, workspace, slug, page), text);
}

/** The latest read of each page, so an older answer never lands last. */
const reads = latestPerKey();

/** A page's source and version on disk, as the editor may take it: null
 *  when a save of the page is on its way, as it starts or as it comes
 *  back, when a newer read started meanwhile, or when the page changed in
 *  the editor since it started (an edit made meanwhile is newer than the
 *  text read). */
async function readPage(host: string, workspace: string, slug: string, page: string): Promise<DesignPageText | null> {
  const key = pageKey(host, workspace, slug, page);
  if (saves.busy(key)) return null;
  const latest = reads.start(key);
  const at = gens[key] ?? 0;
  const text = await rpc<DesignPageText>(host, M.designPage, { workspace, slug, page });
  return latest() && !saves.busy(key) && (gens[key] ?? 0) === at ? text : null;
}

function setSource(key: string, text: DesignPageText) {
  touch(key);
  // The page is as on disk: nothing in it is left to save.
  delete notSaved[key];
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
  changed(key, step.id, editSaid(step.edit));
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
  changed(key, step.id, editSaid({ ...step.edit, undone: act === "undo" }));
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
  return saves.send(key, async () => {
    const source = useEditor.getState().sources[key];
    if (!source) return "stop";
    const html = source.html;
    // The page's changes up to now are in `html`.
    const at = gens[key] ?? 0;
    const edits = (notSaved[key] ?? []).filter((c) => c.gen <= at).map((c) => c.said);
    let written: DesignPageWritten;
    try {
      written = await rpc<DesignPageWritten>(host, M.designWritePage, { workspace, slug, page, html, base_version: source.version, edits });
    } catch (e) {
      if (e instanceof DaemonError && e.code === "stale") {
        await lost(host, workspace, slug, page);
        return "stop";
      }
      throw e;
    }
    notSaved[key] = (notSaved[key] ?? []).filter((c) => c.gen > at);
    touch(key);
    useEditor.setState((st) => ({ sources: { ...st.sources, [key]: { html: st.sources[key]?.html ?? html, version: written.version } } }));
  });
}

/** The user's message to a design's agent, with the edits by hand not told
 *  yet before it, once their pages' saves on their way are back: only the
 *  edits a save took are told. One a save refused as stale was taken back
 *  meanwhile; one whose save failed waits for a save that takes it. Once
 *  the message is sent, those are told. */
export async function sendWithEdits(host: string, workspace: string, slug: string, agent: number, text: string, images: ChatImage[]): Promise<void> {
  const design = itemKey(host, workspace, slug);
  const keyOf = (p: Pending) => pageKey(host, workspace, slug, p.page);
  for (;;) {
    const busy = [...new Set((useEditor.getState().pending[design] ?? []).map(keyOf))].filter((k) => saves.busy(k));
    if (!busy.length) break;
    await Promise.all(busy.map((k) => saves.idle(k)));
  }
  const told = (useEditor.getState().pending[design] ?? []).filter((p) => !notSaved[keyOf(p)]?.some((c) => c.step === p.id));
  await rpc(host, M.chatSend, { id: agent, text: editsMessage(told, text), images });
  useEditor.setState((s) => ({ pending: { ...s.pending, [design]: (s.pending[design] ?? []).filter((p) => !told.includes(p)) } }));
}

/** **Send** and **Send all** of comments, the edits by hand not told yet
 *  before their lines. */
export function sendCommentsWithEdits(host: string, workspace: string, slug: string, agent: number, pins: DesignComment[]): Promise<void> {
  return sendComments(host, workspace, slug, agent, pins, (text) => sendWithEdits(host, workspace, slug, agent, text, []));
}

/** A message the app sends the design's agent, such as **Ask the agent to
 *  fix**, the edits by hand not told yet before it. */
export function askWithEdits(host: string, workspace: string, slug: string, agent: number, text: string): Promise<void> {
  return sendWithEdits(host, workspace, slug, agent, text, []);
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

/** Whether an element of the design was copied, for ⌘V. */
export function hasCopy(host: string, workspace: string, slug: string): boolean {
  return itemKey(host, workspace, slug) in clips;
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
  const text = await rpc<DesignPageText>(host, M.designPage, { workspace, slug, page });
  // The page's changes no save took, made, undone or redone since, those
  // made while it was read again too: they were made on the page refused.
  const ids = new Set((notSaved[key] ?? []).map((c) => c.step));
  const st = useEditor.getState();
  const last = (st.undo[design] ?? NO_UNDO).done.filter((step) => step.page === page && ids.has(step.id)).at(-1);
  useEditor.setState((s) => ({
    undo: { ...s.undo, [design]: dropPage(s.undo[design] ?? NO_UNDO, page) },
    pending: { ...s.pending, [design]: (s.pending[design] ?? []).filter((p) => !ids.has(p.id)) },
    unsaved: { ...s.unsaved, [design]: last ? editLine(last.edit) : (s.unsaved[design] ?? null) },
  }));
  setSource(key, text);
  reloadPage(host, workspace, slug, page);
}

/** A design closed, or another opened: its changes can no longer be
 *  undone or redone ("since the design was opened"); its edits by hand not
 *  told yet still go with the next message. */
export function closeDesign(host: string, workspace: string, slug: string) {
  const design = itemKey(host, workspace, slug);
  useEditor.setState((s) => ({ undo: { ...s.undo, [design]: NO_UNDO } }));
}

/** **Restore** (X65): snapshot `n` made the design's current pages, after
 *  the saves on their way. The design's changes, and its edits by hand not
 *  told yet, were made on pages that are gone, so they are forgotten, as on
 *  a stale save; each page the editor has read is read again (one the
 *  snapshot has not is dropped) and loads again on the canvas. */
export async function restoreSnapshot(host: string, workspace: string, slug: string, n: number): Promise<DesignSnapshot> {
  await saves.settle();
  const restored = await rpc<DesignSnapshot>(host, M.designSnapshotRestore, { workspace, slug, n });
  const design = itemKey(host, workspace, slug);
  useEditor.setState((s) => ({ undo: { ...s.undo, [design]: NO_UNDO }, pending: { ...s.pending, [design]: [] }, unsaved: { ...s.unsaved, [design]: null } }));
  const prefix = `${design}/`;
  const read = Object.keys(useEditor.getState().sources).filter((k) => k.startsWith(prefix));
  await Promise.all(
    read.map(async (key) => {
      const page = key.slice(prefix.length);
      const text = await rpc<DesignPageText>(host, M.designPage, { workspace, slug, page }).catch(() => null);
      if (text) setSource(key, text);
      else {
        delete notSaved[key];
        useEditor.setState((s) => ({ sources: Object.fromEntries(Object.entries(s.sources).filter(([k]) => k !== key)) }));
      }
      reloadPage(host, workspace, slug, page);
    }),
  );
  return restored;
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

/** A page the editor has read changed on disk: read again, the latest
 *  check's answer only, it loads on the canvas again unless it is the
 *  version the editor has, its own save.
 *  While a save is on its way that save decides: refused, it loads the
 *  page; else the change was that save. Another writer's page makes the
 *  page's changes forgotten, as undoing them would undo that writer's. */
async function changedOnDisk(host: string, workspace: string, slug: string, page: string): Promise<void> {
  const key = pageKey(host, workspace, slug, page);
  // Read as the canvas reads it: an older check's answer coming back after
  // a newer one's, or after an edit, is dropped.
  const text = await readPage(host, workspace, slug, page);
  const now = useEditor.getState().sources[key];
  if (!text || !now || text.version === now.version) return;
  const design = itemKey(host, workspace, slug);
  setSource(key, text);
  useEditor.setState((s) => ({ undo: { ...s.undo, [design]: dropPage(s.undo[design] ?? NO_UNDO, page) } }));
  reloadPage(host, workspace, slug, page);
}

/** Starts the editor: it takes the changes on disk of the pages it has
 *  read (changedOnDisk). */
export function startEditor() {
  registerPageOwner((host, workspace, slug, page) => {
    if (!useEditor.getState().sources[pageKey(host, workspace, slug, page)]) return false;
    const check: Promise<void> = changedOnDisk(host, workspace, slug, page)
      .catch(() => reloadPage(host, workspace, slug, page))
      .finally(() => checking.delete(check));
    checking.add(check);
    return true;
  });
}

/** Waits for the checks of pages changed on disk (tests). */
export async function settleChecks(): Promise<void> {
  while (checking.size) await Promise.all(checking);
}

/** Waits for every save on its way. */
export function settleSaves(): Promise<void> {
  return saves.settle();
}

/** The latest read of each design's kit. */
const kitReads = latestPerKey();

/** Reads what the Inspector and the Palette build a design with from its
 *  own design system (`design.kit`); an older read coming back after a
 *  newer one is dropped. */
export async function loadKit(host: string, workspace: string, slug: string): Promise<void> {
  const design = itemKey(host, workspace, slug);
  const latest = kitReads.start(design);
  const kit = await rpc<DesignKit>(host, M.designKit, { workspace, slug });
  if (latest()) useEditor.setState((s) => ({ kits: { ...s.kits, [design]: kit } }));
}

/** A design's kit; undefined until read. */
export function kitOf(s: EditorState, host: string, workspace: string, slug: string): DesignKit | undefined {
  return s.kits[itemKey(host, workspace, slug)];
}

/** The changes of a design that can be undone and redone. */
export function undoOf(s: EditorState, host: string, workspace: string, slug: string): Undo {
  return s.undo[itemKey(host, workspace, slug)] ?? NO_UNDO;
}
