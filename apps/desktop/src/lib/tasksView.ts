// Labels of the Tasks mode sidebar and header, and the header's filters (X45).

import { ago } from "./mobile";
import type { AppMode } from "./store";
import type { Board } from "./tasksBoard";

/** The sidebar footer: "GitHub synced 3 min ago", or "Syncing GitHub…" before the first answer. */
export function syncedLabel(tracker: string, syncedAt: number | null, now: number): string {
  return syncedAt === null ? `Syncing ${tracker}…` : `${tracker} synced ${ago(now - syncedAt)}`;
}

const COLUMN_TEXT = { todo: "Todo", in_progress: "In Progress", in_review: "In Review", done: "Done" } as const;

export interface SessionTaskLine {
  key: string;
  title: string;
  column: keyof typeof COLUMN_TEXT;
  /** "In Progress", or "In Review · out of sync". */
  text: string;
  outOfSync: boolean;
}

/** The second line of each linked session's sidebar row, by session id (X46). */
export function sessionTaskLines(board: Board): Record<string, SessionTaskLine> {
  const out: Record<string, SessionTaskLine> = {};
  for (const c of Object.values(board).flat()) {
    for (const r of c.rows) {
      out[r.session.id] = {
        key: c.task.key,
        title: c.task.title,
        column: c.column,
        text: `${c.columnName ?? COLUMN_TEXT[c.column]}${c.drift ? " · out of sync" : ""}`,
        outOfSync: !!c.drift,
      };
    }
  }
  return out;
}

/** Each sidebar mode's name, as the mode switch and Settings › Keyboard
 *  shortcuts say it. */
export const MODE_NAMES: Record<AppMode, string> = { sessions: "Sessions", tasks: "Tasks", design: "Design" };

/** The mode switch's titles, with the shortcuts as bound, the Tasks
 * button's label and dot (X45, X65), and the Design button's: an accent dot
 * while a design an agent started from a session (`/moonlet-design new`)
 * is unseen (`unseen` of them). A mode's key goes back to Sessions from it,
 * so Sessions is titled with the shown mode's key. */
export function modeSwitch(
  keys: { tasks: string; design: string },
  mode: AppMode,
  outOfSync: number,
  unseen = 0,
): { sessions: string; tasks: string; design: string; label: string; dot: boolean; designLabel: string; designDot: boolean } {
  const titled = (name: string, key: string) => (key ? `${name} ${key}` : name);
  return {
    sessions: mode === "sessions" ? MODE_NAMES.sessions : titled(MODE_NAMES.sessions, keys[mode]),
    tasks: titled(MODE_NAMES.tasks, keys.tasks),
    design: titled(MODE_NAMES.design, keys.design),
    label: outOfSync ? `Tasks, ${outOfSync} out of sync` : "Tasks",
    dot: outOfSync > 0,
    designLabel: unseen ? `Design, ${unseen} new design${unseen === 1 ? "" : "s"}` : "Design",
    designDot: unseen > 0,
  };
}

export interface BoardFilters {
  /** Assignee: me. */
  mine: boolean;
  /** Hide done tasks with no session or worktree left. */
  hideEmptyDone: boolean;
}

/** Whether the header's filters keep a card. Assignee: me keeps a task you have a session on, whoever it is assigned to. */
export const keepCard = (c: Board["todo"][number], f: BoardFilters) =>
  (!f.mine || c.task.mine !== false || c.rows.length > 0) && (!f.hideEmptyDone || c.column !== "done" || c.rows.length + c.orphans.length > 0);

/** The board with the header's filters applied (X45). */
export function filterBoard(board: Board, f: BoardFilters): Board {
  const keep = (c: Board["todo"][number]) => keepCard(c, f);
  return { todo: board.todo.filter(keep), in_progress: board.in_progress.filter(keep), in_review: board.in_review.filter(keep), done: board.done.filter(keep) };
}
