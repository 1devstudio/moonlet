// Add a board (X50): the wizard's four steps as data, what each waits for,
// the tracker's defaults, and the board it makes.

import { type BoardColumn, type BoardConfig, boardId, type CardField, cardFields, type ColumnShow, DEFAULT_CARDS, type Origin, originKey, type StartRule } from "./boards";
import { type Column, mentionsKey, type Task, type TrackerKind, trackerOf } from "./tasks";

export type Step = 1 | 2 | 3 | 4;

/** What the wizard has been told so far. */
export interface Draft {
  step: Step;
  /** The connection id; `github:github.com` for GitHub. */
  connection: string | null;
  origin: Origin | null;
  /** Whether the source has sprints (a Jira board) or cycles (a Linear team); unknown until its tracker says. */
  sprints?: boolean;
  narrow: string;
  labels: string[];
  assignee: "me" | "anyone";
  finished: number | "sprint";
  columns: BoardColumn[];
  name: string;
  workspace: string;
  rules: StartRule[];
  cards: CardField[];
  pinned: boolean;
  /** An X44 source's state mapping, kept as the board carries it. */
  states?: Record<string, Column>;
}

export const STEPS: { name: string; sub: string; title: string }[] = [
  { name: "Source", sub: "Tracker and board", title: "Where does the board come from?" },
  { name: "Issues", sub: "Which issues show up", title: "Which issues should it show?" },
  { name: "Columns", sub: "Order, mapping, folding", title: "Set up the columns" },
  { name: "Finish", sub: "Name, workspace, repos", title: "Name it and choose where sessions start" },
];

/** An empty draft for workspace `wsKey`. */
export function newDraft(wsKey: string): Draft {
  return { step: 1, connection: null, origin: null, narrow: "", labels: [], assignee: "me", finished: 14, columns: [], name: "", workspace: wsKey, rules: [], cards: [], pinned: true };
}


/** The card fields a tracker has, as step 4 names them. */
const CARD_CHOICES: Record<TrackerKind, [CardField, string][]> = {
  jira: [
    ["issue_type", "Issue type"],
    ["points", "Story points"],
    ["assignee", "Assignee"],
    ["parent", "Epic"],
    ["due", "Due date"],
  ],
  linear: [
    ["points", "Estimate"],
    ["assignee", "Assignee"],
    ["parent", "Parent"],
    ["due", "Due date"],
  ],
  github: [["assignee", "Assignee"]],
  clickup: [
    ["assignee", "Assignee"],
    ["due", "Due date"],
  ],
};

/**
 * "Cards show": the fields `tracker` has, with their names. A GitHub
 * Project's first number field (`numberField`) is the estimate, by its name;
 * a board whose `cards` show it keeps the box while the name is not known.
 */
export function cardChoices(tracker: TrackerKind, numberField?: string | null, cards: CardField[] = []): [CardField, string][] {
  const estimate = numberField ?? (cards.includes("points") ? "Estimate" : null);
  return tracker === "github" && estimate ? [["points", estimate], ...CARD_CHOICES.github] : CARD_CHOICES[tracker];
}

/** Whether a Jira board of type `kind` has sprints: Scrum and team-managed (`simple`) ones do. */
export const jiraSprints = (kind: string) => kind === "scrum" || kind === "simple";

/**
 * The draft once the user picks what the board is built from: named after
 * it, following the sprint of a Scrum or team-managed board or the cycle of
 * a Linear team that uses them, with the tracker's card fields. Columns are read again for the new origin.
 */
export function pickOrigin(draft: Draft, connection: string, origin: Origin, name: string, sprints = false): Draft {
  const tracker = trackerOf(connection) ?? "github";
  return { ...draft, connection, origin, sprints, name, columns: [], finished: sprints ? "sprint" : 14, cards: DEFAULT_CARDS[tracker] };
}

/** Whether `origin` of `connection` is already a board in workspace `wsKey`: "Already added". */
export function alreadyAdded(boards: BoardConfig[] | undefined, wsKey: string, connection: string, origin: Origin): boolean {
  return (boards ?? []).some((b) => b.workspace === wsKey && b.connection === connection && b.origin.kind === origin.kind && originKey(b.origin) === originKey(origin));
}

/** "Finished issues": 14 days, or the sprint or cycle where the board has one, or already follows it. */
export function finishedChoices(tracker: TrackerKind, sprints?: boolean, current?: number | "sprint"): { value: number | "sprint"; label: string }[] {
  const days = { value: 14, label: "Hide after 14 days" };
  if (!sprints && current !== "sprint") return [days];
  if (tracker === "jira") return [days, { value: "sprint", label: "Follow the active sprint" }];
  if (tracker === "linear") return [days, { value: "sprint", label: "Follow the active cycle" }];
  return [days];
}

/**
 * Whether Continue (or Create board, or Save) can go on: a board picked or a
 * query, a query the tracker checked (`check`, null until it answers) and
 * accepted, a shown column, a name.
 */
export function canContinue(d: Draft, check: { error: string | null } | null): boolean {
  if (!d.origin || !d.connection) return false;
  if (d.origin.kind === "jql" && !d.origin.query.trim()) return false;
  if (d.step === 1) return true;
  if (d.step === 2) return !!check && !check.error;
  if (check?.error) return false;
  const shown = d.columns.some((c) => c.show !== "hide");
  if (d.step === 3) return shown;
  return shown && !!d.name.trim() && !!d.workspace;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Step 2's preview: `17 issues match · 5 assigned to you · 2 already have a branch with their key`. */
export function previewLine(issues: Task[], branches: string[], connection: string): string {
  const mine = issues.filter((t) => t.mine).length;
  const branched = issues.filter((t) => branches.some((b) => mentionsKey(b, t.key))).length;
  const noun = trackerOf(connection) === "clickup" ? ["task", "tasks"] : ["issue", "issues"];
  const matches = issues.length === 1 ? `${count(1, noun[0], noun[1])} matches` : `${count(issues.length, noun[0], noun[1])} match`;
  const branch = branched === 0 ? "none has a branch with its key" : `${branched} already ${branched === 1 ? "has a branch with its key" : "have a branch with their key"}`;
  return `${matches} · ${mine} assigned to you · ${branch}`;
}

/** What the board is built from, as the summary card names it. */
export function originText(o: Origin): string {
  switch (o.kind) {
    case "jira_board":
      return `Jira board ${o.board}`;
    case "jql":
      return "JQL query";
    case "linear_team":
      return `Linear team ${o.team}`;
    case "github_project":
      return `GitHub project ${o.owner}/${o.number}`;
    case "github_repo":
      return `GitHub ${o.repo}`;
    case "clickup_list":
      return `ClickUp list ${o.list}`;
  }
}

/** Step 4's summary card: `Jira board 41 · 5 columns shown, 1 folded, 1 hidden · 17 issues · Acme`. */
export function summaryLine(d: Draft, issues: number, workspaceName: string): string {
  const shown = d.columns.filter((c) => !c.show).length;
  const folded = d.columns.filter((c) => c.show === "fold").length;
  const hidden = d.columns.filter((c) => c.show === "hide").length;
  const columns = `${count(shown, "column", "columns")} shown, ${folded} folded, ${hidden} hidden`;
  return [d.origin ? originText(d.origin) : "", columns, count(issues, "issue", "issues"), workspaceName].filter(Boolean).join(" · ");
}

const sameFields = (a: CardField[], b: CardField[]) => a.length === b.length && a.every((f) => b.includes(f));

/** The board Create board saves, with what is at its default left out. */
export function toBoard(d: Draft): BoardConfig {
  if (!d.origin || !d.connection) throw new Error("Pick what the board is built from first");
  return {
    id: boardId(d.connection, originKey(d.origin), d.workspace),
    name: d.name.trim(),
    connection: d.connection,
    workspace: d.workspace,
    origin: d.origin,
    ...(d.narrow.trim() && { narrow: d.narrow.trim() }),
    ...(d.labels.length && { labels: d.labels }),
    ...(d.assignee === "anyone" && { assignee: "anyone" as const }),
    ...(d.finished !== 14 && { finished: d.finished }),
    columns: d.columns,
    ...(d.rules.length && { rules: d.rules }),
    // Cards at the tracker's own fields are left out; none at all is kept.
    ...(!sameFields(d.cards, DEFAULT_CARDS[trackerOf(d.connection) ?? "github"]) && { cards: d.cards }),
    ...(!d.pinned && { pinned: false as const }),
    ...(d.states && { states: d.states }),
  };
}

/** Board settings (X50): the wizard on an existing board, its values as saved. */
export function draftFromBoard(b: BoardConfig): Draft {
  return {
    step: 1,
    connection: b.connection,
    origin: b.origin,
    narrow: b.narrow ?? "",
    labels: b.labels ?? [],
    assignee: b.assignee ?? "me",
    finished: b.finished ?? 14,
    columns: b.columns ?? [],
    name: b.name,
    workspace: b.workspace,
    rules: b.rules ?? [],
    cards: cardFields(b),
    pinned: b.pinned !== false,
    ...(b.states && { states: b.states }),
  };
}

/** Step 3's up and down: `columns` with column `i` moved `by` places, unchanged at an end. */
export function moveColumn(columns: BoardColumn[], i: number, by: number): BoardColumn[] {
  const j = i + by;
  if (j < 0 || j >= columns.length) return columns;
  const next = [...columns];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** `columns` with column `i`'s category or Show / Fold / Hide changed; shown is written as no `show`. */
export function columnAt(columns: BoardColumn[], i: number, patch: { category?: BoardColumn["category"]; show?: ColumnShow }): BoardColumn[] {
  return columns.map((c, j) => {
    if (j !== i) return c;
    const { show, ...rest } = { ...c, ...patch };
    return show && show !== "show" ? { ...rest, show } : rest;
  });
}

/** Why `board` cannot be saved: its workspace already has a board from the same origin. `replacing` is the board Board settings saves over. */
export function clash(boards: BoardConfig[] | undefined, board: BoardConfig, replacing?: string): string | null {
  const other = (boards ?? []).find((b) => b.id !== replacing && b.workspace === board.workspace && b.connection === board.connection && b.origin.kind === board.origin.kind && originKey(b.origin) === originKey(board.origin));
  return other ? `This workspace already has a board from ${originText(board.origin)}.` : null;
}

/** The boards with `board` saved: a new one last, one saved from Board settings where `replacing` was. */
export function putBoard(boards: BoardConfig[] | undefined, board: BoardConfig, replacing?: string): BoardConfig[] {
  const list = boards ?? [];
  const at = list.findIndex((b) => b.id === (replacing ?? board.id));
  return at < 0 ? [...list, board] : list.map((b, i) => (i === at ? board : b));
}

/** Step 1's rows under their group (a ClickUp list's space and folder), groups in the order they first came; null for a tracker without groups. */
export function byGroup<T extends { group?: string }>(rows: T[]): { group: string | null; rows: T[] }[] {
  const groups = new Map<string | null, T[]>();
  for (const r of rows) groups.set(r.group ?? null, [...(groups.get(r.group ?? null) ?? []), r]);
  return [...groups].map(([group, list]) => ({ group, rows: list }));
}

/** Step 3's drag and drop: `columns` with column `from` dropped at place `to`. */
export function dropColumn(columns: BoardColumn[], from: number, to: number): BoardColumn[] {
  if (from === to) return columns;
  const next = columns.filter((_, i) => i !== from);
  next.splice(to, 0, columns[from]);
  return next;
}

/** The columns whose category the user changed from the one suggested (`suggested`, by name), which step 3 outlines. */
export function changedCategories(columns: BoardColumn[], suggested: Partial<Record<string, BoardColumn["category"]>>): string[] {
  return columns.filter((c) => suggested[c.name] !== undefined && suggested[c.name] !== c.category).map((c) => c.name);
}

/**
 * Each column's category as suggested (X50 step 3): taken from the columns
 * when they first come (the tracker's for a new board, the saved ones in
 * Board settings), kept while the user changes them, cleared with them.
 */
export function suggestedOf(prev: Partial<Record<string, BoardColumn["category"]>>, columns: BoardColumn[]): Partial<Record<string, BoardColumn["category"]>> {
  if (!columns.length) return {};
  return Object.keys(prev).length ? prev : Object.fromEntries(columns.map((c) => [c.name, c.category]));
}

/** Where a Jira board's filter is edited (X50 Edit in Jira). */
export const jiraFilterUrl = (site: string, filterId: string) => `https://${site}/issues/?filter=${encodeURIComponent(filterId)}`;

/**
 * Status names by id (X50 step 3): a Jira board's setup's first, then the
 * previewed issues' (a JQL board's), then the `site`'s statuses (for a status
 * no issue is in today), then those `known` from an earlier preview of the
 * same source.
 */
export function statusNames(from: { setup?: Record<string, string>; issues?: Task[]; site?: Record<string, string>; known?: Record<string, string> }): Record<string, string> {
  const fromIssues = Object.fromEntries((from.issues ?? []).flatMap((t) => (t.tracker?.statusId ? [[t.tracker.statusId, t.tracker.state]] : [])));
  return { ...from.known, ...from.site, ...fromIssues, ...from.setup };
}

/** A column's statuses as step 3 lists them, by name where known: `Open · In Progress`. */
export function statusText(column: BoardColumn, names: Record<string, string>): string {
  return column.statuses.length ? column.statuses.map((s) => names[s] ?? s).join(" · ") : "no status";
}

/** The gh scope a daemon error says is missing (X50 GitHub Projects), or null. */
export function scopeNeeded(message: string): "read:project" | "project" | null {
  const m = /gh auth refresh -s (read:project|project)\b/.exec(message);
  return m ? (m[1] as "read:project" | "project") : null;
}

/** A GitHub Project as a row of step 1, under its owner: its Status options counted as columns. */
export function projectChoice(p: { owner: string; number: number; title: string; options: unknown[] }): { key: string; name: string; kind: string; group: string; origin: Origin } {
  return { key: `#${p.number}`, name: p.title, kind: `${p.options.length} ${p.options.length === 1 ? "column" : "columns"}`, group: p.owner, origin: { kind: "github_project", owner: p.owner, number: p.number } };
}

/** Whose GitHub Projects step 1 lists besides the user's (X50): the owners of the workspace's repositories, each once. */
export function projectOwners(repos: (string | null)[]): string[] {
  return [...new Set(repos.flatMap((r) => (r ? [r.split("/")[0]] : [])))];
}

/**
 * Step 2's preview (X50): the tracker is asked `wait` ms after the last
 * change, and only the latest change's answer is shown, so typing a query
 * asks once. `stop` drops a pending ask and any answer still to come, for
 * leaving the step. `ask` turns its own failures into an answer.
 */
export function pausedPreview<T>(show: (answer: T) => void, wait = 500) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest = 0;
  const stop = () => {
    clearTimeout(timer);
    latest++;
  };
  return {
    change(ask: () => Promise<T>) {
      stop();
      const mine = latest;
      timer = setTimeout(() => void ask().then((answer) => mine === latest && show(answer)), wait);
    },
    stop,
  };
}

/**
 * A JQL board's status dragged onto the column at `to` (X50 step 3): it
 * joins that column's statuses, and a column it leaves without any goes.
 */
export function groupStatus(columns: BoardColumn[], status: string, to: number): BoardColumn[] {
  const target = columns[to];
  if (!target || target.statuses.includes(status)) return columns;
  return columns.flatMap((c) => {
    if (c === target) return [{ ...c, statuses: [...c.statuses, status] }];
    if (!c.statuses.includes(status)) return [c];
    const statuses = c.statuses.filter((s) => s !== status);
    return statuses.length ? [{ ...c, statuses }] : [];
  });
}

/**
 * A grouped status given its own column again (X50 step 3), beside the
 * column it leaves, in that column's category and showing as it does. The
 * status the column is named after keeps the name; the rest take their first
 * status's. A name another column has gets the status's id after it.
 */
export function splitStatus(columns: BoardColumn[], status: string, names: Record<string, string>): BoardColumn[] {
  const from = columns.find((c) => c.statuses.includes(status));
  if (!from || from.statuses.length < 2) return columns;
  const nameOf = (id: string) => names[id] ?? id;
  const free = (name: string, id: string) => (columns.some((c) => c !== from && c.name === name) ? `${name} (${id})` : name);
  const rest = from.statuses.filter((s) => s !== status);
  const own: BoardColumn = { ...from, name: free(nameOf(status), status), statuses: [status] };
  const left: BoardColumn = from.name === nameOf(status) ? { ...from, name: free(nameOf(rest[0]), rest[0]), statuses: rest } : { ...from, statuses: rest };
  return columns.flatMap((c) => (c !== from ? [c] : from.name === nameOf(status) ? [own, left] : [left, own]));
}

/**
 * Whether step 3 groups a board's statuses (X50): only a JQL board's, whose
 * columns moonlet makes from its issues' statuses. A Jira board's, a Linear
 * team's or a ClickUp list's columns come back on each sync as the tracker
 * has them, which would undo a group.
 */
export const groupsStatuses = (origin: Origin | null) => origin?.kind === "jql";
