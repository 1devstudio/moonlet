// How the Sessions sidebar shows each session's task (X48): A, a column with
// the issue number; B, sessions under a line for their task. Pure, so it is
// unit-tested.

import type { SessionTaskLine } from "./tasksView";

/** A key's prefix and number: `MOON-142` → `MOON-` and `142`; a GitHub `owner/repo#12` → `owner/repo#` and `12`. */
export function splitKey(key: string): { prefix: string; number: string } {
  const hash = key.lastIndexOf("#");
  if (hash >= 0) return { prefix: key.slice(0, hash + 1), number: key.slice(hash + 1) };
  const dash = key.lastIndexOf("-");
  return { prefix: key.slice(0, dash + 1), number: key.slice(dash + 1) };
}

export interface NumberCell {
  text: string;
  outOfSync: boolean;
}

/**
 * Style A's column for one heading's sessions (`ids`, in row order): the
 * prefix a project heading shows when every linked session shares it (`#`
 * for one GitHub repository), each row's number (the whole key when prefixes
 * differ or there is no project heading to show the prefix, blank without a
 * task), and the column's width in characters, 0 when no session has a task.
 */
export function numberColumn(ids: string[], lines: Record<string, { key: string; outOfSync: boolean } | undefined>, o: { heading: boolean }): { prefix: string | null; cells: Record<string, NumberCell>; width: number } {
  const prefixes = new Set(ids.flatMap((id) => (lines[id] ? [splitKey(lines[id].key).prefix] : [])));
  const shared = o.heading && prefixes.size === 1 ? [...prefixes][0] : null;
  const cells: Record<string, NumberCell> = {};
  for (const id of ids) {
    const l = lines[id];
    cells[id] = { text: !l ? "" : shared !== null ? splitKey(l.key).number : l.key, outOfSync: !!l?.outOfSync };
  }
  const width = Math.max(0, ...Object.values(cells).map((c) => c.text.length));
  return { prefix: shared?.endsWith("#") ? "#" : shared, cells, width };
}

export interface TaskGroup {
  /** The task's key; `""` for the sessions without a task. */
  key: string;
  title: string;
  column: SessionTaskLine["column"] | null;
  outOfSync: boolean;
  ids: string[];
}

/**
 * Style B's task lines for one heading's sessions (`ids`, in row order):
 * each task in the order of its first session, then `No task`. Null when the
 * section is already grouped by task or the workspace has no task source.
 */
export function taskGroups(ids: string[], lines: Record<string, Omit<SessionTaskLine, "text"> | undefined>, o: { sources: boolean; groupedByTask: boolean }): TaskGroup[] | null {
  if (o.groupedByTask || !o.sources) return null;
  const groups = new Map<string, TaskGroup>();
  const none: string[] = [];
  for (const id of ids) {
    const l = lines[id];
    if (!l) none.push(id);
    else if (groups.has(l.key)) groups.get(l.key)!.ids.push(id);
    else groups.set(l.key, { key: l.key, title: l.title, column: l.column, outOfSync: l.outOfSync, ids: [id] });
  }
  return [...groups.values(), ...(none.length ? [{ key: "", title: "No task", column: null, outOfSync: false, ids: none }] : [])];
}

/** A · issue number column, or B · task as a sub-header. */
export type RowStyle = "number" | "task";

/** The two styles as Settings › Appearance names them. */
export const ROW_STYLES: { id: RowStyle; label: string; hint: string }[] = [
  { id: "number", label: "A · Issue number column", hint: "One line per session, with the issue number in a narrow column." },
  { id: "task", label: "B · Task as a sub-header", hint: "Sessions sit under a quiet line for their task; a task's key shows once." },
];

/** The saved choice; A on a new install or for anything unknown. */
export function rowStyle(saved: string | undefined): RowStyle {
  return saved === "task" ? "task" : "number";
}
