// Search the board (X93): Find a task in the board header lists the tasks
// that match, on the shown board and off it, without filtering the board.

import type { Category } from "./boards";
import type { ColumnView } from "./boardColumns";
import type { AgentState } from "./protocol";
import { type Column, type Task, taskId, trackerName, trackerOf } from "./tasks";
import type { BoardSession } from "./tasksBoard";

/** Text split around the first match, `mid` empty when it has none. */
export interface Hit {
  pre: string;
  mid: string;
  post: string;
}

/** A task the shown board draws, as its dropdown row (X93 On this board). */
export interface OnRow {
  id: string;
  key: Hit;
  title: Hit;
  /** The board column it is in, and that column's category. */
  column: string;
  category: Category;
  /** The session it was found by when the key and title don't match: by its name, else its branch. */
  via: { what: "session" | "branch"; text: Hit; state: AgentState | null } | null;
  /** The state of each session on the card. */
  sessions: (AgentState | null)[];
}

/** A task the shown board doesn't draw, as its dropdown row (X93 Not on this board). */
export interface OffRow {
  id: string;
  task: Task;
  key: Hit;
  title: Hit;
  /** `<board> · <column>`, or `<tracker> · [<cycle> · ]<state>`. */
  where: string;
  /** Its state's glyph, dashed for a backlog state. */
  glyph: Column;
  backlog: boolean;
  /** The workspace's other board that has it, if any. */
  board: string | null;
}

/** Another board of the workspace, drawn: its sidebar label and columns. */
export interface OtherBoard {
  id: string;
  label: string;
  views: ColumnView[];
}

/** What one connection's tracker search found, best first. */
export interface Found {
  connection: string;
  tasks: Task[];
}

export interface BoardSearch {
  on: OnRow[];
  off: OffRow[];
}

/** The most rows one tracker's search adds. */
const PER_TRACKER = 8;

/** The query as matching reads it: trimmed and lower-cased. */
const norm = (query: string) => query.trim().toLowerCase();

/** `text` around the first place it has `q` (lower-cased), ignoring case. */
function hit(text: string, q: string): Hit {
  const at = q ? text.toLowerCase().indexOf(q) : -1;
  if (at < 0) return { pre: text, mid: "", post: "" };
  return { pre: text.slice(0, at), mid: text.slice(at, at + q.length), post: text.slice(at + q.length) };
}

/** The first session whose name has `q`, else the first whose branch has it. */
function viaSession(sessions: BoardSession[], q: string): OnRow["via"] {
  for (const what of ["session", "branch"] as const) {
    for (const s of sessions) {
      const text = hit(what === "session" ? s.name : s.branch, q);
      if (text.mid) return { what, text, state: s.state };
    }
  }
  return null;
}

/** What Find a task finds for `query` on the board drawn as `views`. */
export function searchBoard(query: string, views: ColumnView[], others: OtherBoard[] = [], found: Found[] = []): BoardSearch {
  const q = norm(query);
  if (!q) return { on: [], off: [] };
  const on: OnRow[] = [];
  for (const v of views) {
    for (const c of v.cards) {
      const key = hit(c.task.key, q);
      const title = hit(c.task.title, q);
      const via = key.mid || title.mid ? null : viaSession(c.rows.map((r) => r.session), q);
      if (key.mid || title.mid || via) on.push({ id: taskId(c.task), key, title, column: v.name, category: v.category, via, sessions: c.rows.map((r) => r.session.state) });
    }
  }
  // Every task listed so far, and the shown board's, which is never off it.
  const seen = new Set(views.flatMap((v) => v.cards.map((c) => taskId(c.task))));
  const elsewhere = new Map<string, { board: OtherBoard; column: string }>();
  for (const b of others) for (const v of b.views) for (const c of v.cards) if (!elsewhere.has(taskId(c.task))) elsewhere.set(taskId(c.task), { board: b, column: v.name });
  const off: OffRow[] = [];
  const add = (task: Task) => {
    const id = taskId(task);
    if (seen.has(id)) return false;
    seen.add(id);
    const on = elsewhere.get(id);
    const glyph: Column = task.column === "open" ? "todo" : task.column;
    const state = stateOf(task);
    off.push({
      id,
      task,
      key: hit(task.key, q),
      title: hit(task.title, q),
      where: on ? `${on.board.label} · ${on.column}` : [trackerName(task.connection), ...(trackerOf(task.connection) === "linear" ? [task.cycle ? `Cycle ${task.cycle}` : "no cycle"] : []), state].join(" · "),
      glyph,
      backlog: /^backlog$/i.test(state),
      board: on?.board.id ?? null,
    });
    return true;
  };
  for (const b of others) for (const v of b.views) for (const c of v.cards) if (matches(c.task, q)) add(c.task);
  for (const f of found) {
    let n = 0;
    for (const task of f.tasks) if (n < PER_TRACKER && add(task)) n++;
  }
  return { on, off };
}

/** Whether a task off the board matches: by key, title or description. */
const matches = (t: Task, q: string) => [t.key, t.title, t.description].some((x) => x.toLowerCase().includes(q));

/** A task's state as its tracker names it; Open or Closed for a GitHub issue. */
const stateOf = (t: Task) => t.tracker?.state ?? (t.column === "open" ? "Open" : "Closed");

/**
 * The dropdown's count (`7 results`), and with nothing found, where Find a
 * task looked: this board, the other boards and each tracker searched.
 */
export function searchFooter(result: BoardSearch, trackers: string[]): { count: string; none: string | null } {
  const n = result.on.length + result.off.length;
  const places = ["this board", "your other boards", ...trackers];
  const list = `${places.slice(0, -1).join(", ")} and ${places[places.length - 1]}`;
  return { count: `${n} ${n === 1 ? "result" : "results"}`, none: n ? null : `Searched ${list}.` };
}

/** The board's columns with the folded one that holds the found task open for the moment, saying so. */
export function revealFound(views: ColumnView[], found: string | null): (ColumnView & { note?: string })[] {
  return views.map((v) => {
    const card = v.folded && found ? v.cards.find((c) => taskId(c.task) === found) : undefined;
    return card ? { ...v, folded: false, note: `unfolded to show ${card.task.key}` } : v;
  });
}
