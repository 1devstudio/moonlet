// Undo and redo of the visual editor's changes (X65), since the design was
// opened, and the edits by hand the agent has not been told yet. Pure: the
// store is designEditor.ts.

import type { HandEdit, Untold } from "./designEdits";

/** One change of a page's source by the editor. */
export interface Step {
  /** Its number, the order changes were made in. */
  id: number;
  page: string;
  /** The page's source before and after it. */
  before: string;
  after: string;
  /** What it did, as the agent is told. */
  edit: HandEdit;
  /** The element selected before and after it. */
  selectBefore: string | null;
  selectAfter: string | null;
}

/** The changes made, latest last, and those undone, latest undone last. */
export interface Undo {
  done: Step[];
  undone: Step[];
}

export const NO_UNDO: Undo = { done: [], undone: [] };

/** A new change: it can be undone, and what was undone can no longer be redone. */
export function pushStep(u: Undo, step: Step): Undo {
  return { done: [...u.done, step], undone: [] };
}

/** The latest change undone: its page goes back to `step.before`. Null when
 *  there is none. */
export function undoStep(u: Undo): { undo: Undo; step: Step } | null {
  const step = u.done.at(-1);
  return step ? { undo: { done: u.done.slice(0, -1), undone: [...u.undone, step] }, step } : null;
}

/** The latest undone change made again: its page goes to `step.after`. */
export function redoStep(u: Undo): { undo: Undo; step: Step } | null {
  const step = u.undone.at(-1);
  return step ? { undo: { done: [...u.done, step], undone: u.undone.slice(0, -1) }, step } : null;
}

/** An edit not told to the agent yet, by its change's number. */
export type Pending = Untold & { id: number };

/** The changes less page `page`'s: its source changed on disk under them,
 *  so neither undoing nor redoing them would give the page they knew. */
export function dropPage(u: Undo, page: string): Undo {
  return { done: u.done.filter((s) => s.page !== page), undone: u.undone.filter((s) => s.page !== page) };
}

/** The edits not told yet after `step` is made (`do`), undone or redone:
 *  undoing one not told yet takes it back out, undoing one told is told as
 *  undone, and redoing reverses that. */
export function pendingAfter(pending: Pending[], step: Step, act: "do" | "undo" | "redo"): Pending[] {
  const undone = act === "undo";
  const opposite = pending.findIndex((p) => p.id === step.id && !!p.undone !== undone);
  if (act !== "do" && opposite >= 0) return pending.filter((_, i) => i !== opposite);
  return [...pending, { ...step.edit, id: step.id, ...(undone ? { undone: true } : {}) }];
}
