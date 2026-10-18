// Boards (X50): one view of one tracker in a workspace, with the tracker's
// own columns. `BoardConfig` mirrors `moonlet-trackers::config::Board`, as
// saved in `trackers.toml`; `tasksBoard` builds what is drawn.

import { type Column, sourceKey, type Task, type TrackerKind, trackerName, trackerOf } from "./tasks";
import type { Connection, Source, TrackersConfig } from "./tasksStore";
import { trackerLink } from "./trackerSources";

/** What a board is built from. */
export type Origin =
  | { kind: "jira_board"; board: number }
  | { kind: "jql"; query: string }
  | { kind: "linear_team"; team: string }
  | { kind: "github_project"; owner: string; number: number }
  | { kind: "github_repo"; repo: string }
  | { kind: "clickup_list"; list: string };

/** What moonlet treats a board column as; hiding a column is its `show`. */
export type Category = Exclude<Column, "hidden">;

/** What a category reads as on a column's status line and in step 3 (X50). */
export const CATEGORY_LABEL: Record<Category, string> = { todo: "To do", in_progress: "In progress", in_review: "In review", done: "Done" };

/** Each category's colour in a board's column strip (Add a board's preview, the switcher's bars). */
export const CATEGORY_BAR: Record<Category, string> = { todo: "bg-[#4a4a4a]", in_progress: "bg-[#7d7d7d]", in_review: "bg-[#b5b5b5]", done: "bg-merged" };

/** A column on the board: shown, folded to a strip, or hidden. */
export type ColumnShow = "show" | "fold" | "hide";

export interface BoardColumn {
  /** As the tracker names it. */
  name: string;
  /** Jira status ids, else state names (Linear, ClickUp; a GitHub repository's `open`, `completed`, `not_planned`). */
  statuses: string[];
  category: Category;
  /** Absent: shown. */
  show?: Exclude<ColumnShow, "show">;
  /** Jira's column limit. */
  wip?: number;
}

/** A "New sessions from this board start in" rule: `project` when `when` matches. */
export interface StartRule {
  when: "default" | { component: string } | { label: string };
  project: string;
}

export type CardField = "issue_type" | "points" | "assignee" | "parent" | "due" | "labels";

/** `boards` with board `id` pinned in the sidebar or not; pinned, the default, is not written (X50). */
export function withPinned(boards: BoardConfig[], id: string, pinned: boolean): BoardConfig[] {
  return boards.map((b) => {
    if (b.id !== id) return b;
    const { pinned: _, ...rest } = b;
    return pinned ? rest : { ...rest, pinned: false };
  });
}

/** Whose issues a board shows (X50): the user's, or anyone's with others' dimmed. */
export type Assignee = "me" | "anyone";

/** The header's Assignee picked for a board, `to`, over the board's own setting then, `over`. */
export interface AssigneePick {
  to: Assignee;
  over: Assignee;
}

/** The pick that stands for every board at me: an upgrade from X45's one switch, turned off. */
export const EVERY_BOARD = "*";

/**
 * A board's Assignee (X50 header): the user's pick for it, kept in the app,
 * while the board's own setting is still the one it was picked over (Board
 * settings changing it wins), else that own setting.
 */
export function assigneeOf(board: Pick<BoardConfig, "id" | "assignee">, picks: Record<string, AssigneePick>): Assignee {
  const own = board.assignee ?? "me";
  const pick = picks[board.id] ?? picks[EVERY_BOARD];
  return pick && pick.over === own ? pick.to : own;
}

/** The picks once the user picks `to` for `board`, forgetting those of boards no longer among `ids`. */
export function pickAssignee(picks: Record<string, AssigneePick>, board: Pick<BoardConfig, "id" | "assignee">, to: Assignee, ids: string[]): Record<string, AssigneePick> {
  const kept = Object.fromEntries(Object.entries(picks).filter(([id]) => id === EVERY_BOARD || ids.includes(id)));
  return { ...kept, [board.id]: { to, over: board.assignee ?? "me" } };
}

/** A Jira board's type as moonlet names it (X50 Add a board, board switcher). */
export const jiraBoardType = (kind: string) => ({ scrum: "Scrum", kanban: "Kanban", simple: "Team-managed" })[kind] ?? kind;

/** The card fields a tracker's boards show until the user picks (X50 Cards show). */
export const DEFAULT_CARDS: Record<TrackerKind, CardField[]> = { jira: ["issue_type", "points", "assignee"], linear: ["points", "assignee"], github: ["assignee"], clickup: ["assignee"] };

/** The fields a board's cards show: its own choice (none included), else its tracker's (X50 Cards show). */
export const cardFields = (board: Pick<BoardConfig, "connection" | "cards">): CardField[] => board.cards ?? DEFAULT_CARDS[trackerOf(board.connection) ?? "github"];

export interface BoardConfig {
  id: string;
  name: string;
  /** The connection id; `github:github.com` for GitHub. */
  connection: string;
  /** `host/workspaceId`. */
  workspace: string;
  origin: Origin;
  /** JQL added with AND to a Jira board's filter or query. */
  narrow?: string;
  labels?: string[];
  /** Absent: me. */
  assignee?: "anyone";
  /** Days a finished issue stays, or only the active sprint or cycle's; absent: 14 days. */
  finished?: number | "sprint";
  /** Empty until the first sync reads the tracker's statuses. */
  columns?: BoardColumn[];
  /** The state mapping a migrated source brought or the States dialog saved: it gives the board's first columns their categories. */
  states?: Record<string, Column>;
  rules?: StartRule[];
  cards?: CardField[];
  /** Absent: pinned. */
  pinned?: false;
}

const GITHUB = "github:github.com";

/** A migrated board's id: its tracker project's link (`<connection>/<key>`) in workspace `wsKey`. */
export const boardId = (connection: string, key: string, wsKey: string) => `${trackerLink(connection, key)}@${wsKey}`;

/** How `migrated` records that repository `repo` of workspace `wsKey` got its board. */
const repoSeen = (wsKey: string, repo: string) => `${wsKey} ${trackerLink(GITHUB, repo.toLowerCase())}`;

/**
 * Turns every X44 source into a pinned board in its workspace (X50), as
 * soon as `trackers.toml` loads: a board keeps its connection's state
 * mapping, a source no workspace was chosen for showed nowhere and goes, and
 * one whose board is already there is skipped. The connections keep no
 * sources or mapping. Returns `config` itself when it has no source.
 */
export function migrateSources(config: TrackersConfig): TrackersConfig {
  if (!(config.connections ?? []).some((c) => c.sources.length || (c.states && Object.keys(c.states).length))) return config;
  const have = new Set((config.boards ?? []).map((b) => b.id));
  const fromSources: BoardConfig[] = (config.connections ?? []).flatMap((c) =>
    c.sources
      .filter((s) => s.workspace && !have.has(boardId(c.id, s.key, s.workspace)))
      .map((s) => ({
        id: boardId(c.id, s.key, s.workspace),
        name: s.name,
        connection: c.id,
        workspace: s.workspace,
        origin: ORIGIN[c.kind](s.key),
        ...(c.states && Object.keys(c.states).length ? { states: c.states } : {}),
      })),
  );
  return {
    ...config,
    connections: config.connections?.map((c) => ({ ...c, sources: [], states: undefined })),
    boards: [...(config.boards ?? []), ...fromSources],
  };
}

/**
 * Gives each GitHub repository of workspace `wsKey`'s projects (`repos`,
 * `owner/name`, any case) a pinned board the first time a sync sees it
 * (X50). `migrated` remembers it, so a board the user removes stays
 * removed, while a repository whose origin could not be read this time (a
 * host offline, a remote added later) gets its board on a later sync.
 * Returns `config` itself when there is nothing to add.
 */
export function addRepoBoards(config: TrackersConfig, wsKey: string, repos: string[]): TrackersConfig {
  const done = new Set(config.migrated ?? []);
  const fresh = new Map<string, string>();
  for (const repo of repos) if (!done.has(repoSeen(wsKey, repo)) && !fresh.has(repo.toLowerCase())) fresh.set(repo.toLowerCase(), repo);
  if (!fresh.size) return config;
  const added: BoardConfig[] = [...fresh.values()].map((repo) => ({
    id: boardId(GITHUB, repo.toLowerCase(), wsKey),
    name: repo,
    connection: GITHUB,
    workspace: wsKey,
    origin: { kind: "github_repo", repo },
  }));
  return { ...config, boards: [...(config.boards ?? []), ...added], migrated: [...(config.migrated ?? []), ...[...fresh.values()].map((repo) => repoSeen(wsKey, repo))] };
}

/** A Jira project's board query, and the project back from it (X50: a migrated Jira source). */
export const jqlOfProject = (key: string) => `project = ${key}`;
export const projectOfJql = (query: string) => /^project = ([A-Za-z0-9_]+)$/.exec(query)?.[1] ?? null;

const ORIGIN: Record<"linear" | "jira" | "clickup", (key: string) => Origin> = {
  jira: (key) => ({ kind: "jql", query: jqlOfProject(key) }),
  linear: (team) => ({ kind: "linear_team", team }),
  clickup: (list) => ({ kind: "clickup_list", list }),
};

/**
 * The projects a new session from `task` starts in (X50): the first rule
 * whose component or label the task has, else the board's By default row
 * (each with all its projects),
 * else `linked`, the projects whose `.moonlet/config.toml` links the task's
 * tracker project (X44).
 */
export function startProjects(rules: StartRule[] | undefined, task: Task, linked: string[]): string[] {
  const all = rules ?? [];
  const matches = ({ when }: StartRule) => when !== "default" && ("component" in when ? (task.components ?? []).includes(when.component) : task.labels.includes(when.label));
  // The first rule that matches, or else the By default row, and every other
  // rule with the same condition (a row of several projects).
  const first = all.find(matches) ?? all.find((r) => r.when === "default");
  if (!first) return linked;
  const same = JSON.stringify(first.when);
  return [...new Set(all.filter((r) => JSON.stringify(r.when) === same).map((r) => r.project))];
}

/** Each kind of origin: what the switcher calls it before a sync says more, and the key its search matches. */
const ORIGIN_KINDS: { [K in Origin["kind"]]: { label: string; key: (o: Extract<Origin, { kind: K }>) => string } } = {
  jira_board: { label: "Board", key: (o) => String(o.board) },
  jql: { label: "Query", key: (o) => o.query },
  linear_team: { label: "Team", key: (o) => o.team },
  github_project: { label: "Project", key: (o) => `${o.owner}/${o.number}` },
  github_repo: { label: "Repository", key: (o) => o.repo },
  clickup_list: { label: "List", key: (o) => o.list },
};

export const originLabel = (o: Origin) => ORIGIN_KINDS[o.kind].label;
export const originKey = (o: Origin) => (ORIGIN_KINDS[o.kind].key as (o: Origin) => string)(o);

/** A Jira board's issue as `tracker_board_tasks` sends it. */
export type BoardIssue = Task & { statusId: string; /** A due date given as a time (ClickUp's). */ dueMs?: number };

/** Unix milliseconds as the day they fall on where the user is, `offsetMinutes` behind UTC as `Date.getTimezoneOffset` gives it. */
export function localDay(ms: number, offsetMinutes: number): string {
  return new Date(ms - offsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** A board issue as a task: its status id goes with the tracker's state, and a due time becomes the user's day. */
export function taskFromBoardIssue({ statusId, dueMs, ...task }: BoardIssue, offsetMinutes = new Date(dueMs ?? 0).getTimezoneOffset()): Task {
  return { ...task, ...(dueMs !== undefined && !task.due && { due: localDay(dueMs, offsetMinutes) }), tracker: task.tracker && { ...task.tracker, statusId } };
}

/**
 * A board's saved columns matched to the tracker's on a sync (X50), by
 * status id: a saved column keeps its place, folding and category and takes
 * the tracker's name, statuses and WIP; a tracker column no saved one shares
 * a status with is added at the end with its defaults; a saved column whose
 * statuses are all gone is dropped.
 */
export function matchColumns(saved: BoardColumn[] | undefined, fresh: BoardColumn[]): BoardColumn[] {
  if (!saved?.length) return fresh;
  const used = new Set<BoardColumn>();
  const kept = saved.flatMap((s) => {
    const match = fresh.find((f) => !used.has(f) && f.statuses.some((id) => s.statuses.includes(id)));
    if (!match) return [];
    used.add(match);
    const { show: _, ...tracker } = match;
    return [{ ...tracker, category: s.category, ...(s.show && { show: s.show }) }];
  });
  // A column new in the tracker goes where the tracker has it: before the next column the board had.
  const out = [...kept];
  fresh.forEach((f, i) => {
    if (used.has(f)) return;
    const next = fresh.slice(i + 1).find((n) => used.has(n));
    const at = next ? out.findIndex((c) => c.statuses.some((id) => next.statuses.includes(id))) : -1;
    out.splice(at < 0 ? out.length : at, 0, f);
  });
  return out;
}

/**
 * A migrated board's first columns (X50): the tracker's, each in the
 * category the old state mapping gave its state (by name), a state mapped
 * to Not shown hidden and one mapped to a column shown.
 */
export function firstColumns(fresh: BoardColumn[], states: Record<string, Column> | undefined): BoardColumn[] {
  if (!states || !Object.keys(states).length) return fresh;
  return fresh.map((c) => {
    const mapped = states[c.name] ?? c.statuses.map((s) => states[s]).find(Boolean);
    if (!mapped) return c;
    const { show, ...rest } = c;
    if (mapped === "hidden") return { ...rest, show: "hide" };
    return { ...rest, category: mapped, ...(show === "fold" && { show }) };
  });
}

/** A GitHub repository board's columns: GitHub's own two (X50). */
export const GITHUB_REPO_COLUMNS: BoardColumn[] = [
  { name: "Open", statuses: ["open"], category: "todo" },
  { name: "Closed", statuses: ["completed", "not_planned"], category: "done", show: "fold" },
];

/** The boards a sync of workspace `wsKey` reads: its pinned ones and the one shown. */
export function workspaceBoards(boards: BoardConfig[] | undefined, wsKey: string, shown: string | null): BoardConfig[] {
  return (boards ?? []).filter((b) => b.workspace === wsKey && (b.pinned !== false || b.id === shown));
}

/** The team, project or list a board built from a source shows: `MOON`, `OPS`, a list id; null for other boards. */
export function sourceKeyOf(b: Pick<BoardConfig, "origin">): string | null {
  if (b.origin.kind === "linear_team") return b.origin.team;
  if (b.origin.kind === "clickup_list") return b.origin.list;
  if (b.origin.kind === "jql") return projectOfJql(b.origin.query);
  return null;
}

/** The Sources dialog's rows: the connection's boards built from a team, project or list, or one empty row. */
export function boardRows(connection: Connection, boards: BoardConfig[] | undefined): Source[] {
  const rows = (boards ?? []).flatMap((b) => {
    const key = b.connection === connection.id ? sourceKeyOf(b) : null;
    return key ? [{ key, name: b.name, workspace: b.workspace }] : [];
  });
  return rows.length ? rows : [{ key: "", name: "", workspace: "" }];
}

/**
 * The boards after the Sources dialog saves `rows` for `connection`: a board
 * whose row stays keeps its columns and settings, a new row becomes a board
 * as a migrated source does, and a board whose row went is removed. Other
 * boards stay as they are.
 */
export function rowsToBoards(connection: Connection, rows: Source[], boards: BoardConfig[] | undefined): BoardConfig[] {
  const wanted = rows.filter((r) => r.key && r.workspace);
  const has = (ws: string, key: string) => wanted.some((r) => r.workspace === ws && r.key === key);
  const kept = (boards ?? []).filter((b) => {
    const key = b.connection === connection.id ? sourceKeyOf(b) : null;
    return !key || has(b.workspace, key);
  });
  const added = wanted
    .filter((r) => !kept.some((b) => b.connection === connection.id && b.workspace === r.workspace && sourceKeyOf(b) === r.key))
    .filter((r, i, all) => all.findIndex((x) => x.workspace === r.workspace && x.key === r.key) === i)
    .map((r) => ({ id: boardId(connection.id, r.key, r.workspace), name: r.name, connection: connection.id, workspace: r.workspace, origin: ORIGIN[connection.kind](r.key) }));
  return [...kept, ...added];
}

/**
 * The States dialog's mapping saved on a board (X44, X50): kept for the
 * board's first columns, and applied at once to the columns it has.
 */
export function withStates(board: BoardConfig, states: Record<string, Column>): BoardConfig {
  return { ...board, states, ...(board.columns?.length && { columns: firstColumns(board.columns, states) }) };
}

/**
 * A board's columns after a sync brought the tracker's (`fresh`, or null
 * when it brought none): a board without columns starts from the tracker's
 * with its state mapping; a JQL board's only grow, since they come from the
 * statuses its issues happen to be in; any other board's are matched to
 * the tracker's (`matchColumns`). A GitHub repository board has GitHub's two.
 */
export function syncedColumns(board: BoardConfig, fresh: BoardColumn[] | null): BoardColumn[] {
  const saved = board.columns ?? [];
  if (!fresh) return saved.length || board.origin.kind !== "github_repo" ? saved : GITHUB_REPO_COLUMNS;
  if (!saved.length) return firstColumns(fresh, board.states);
  if (board.origin.kind === "jql") return [...saved, ...fresh.filter((f) => !f.statuses.some((id) => saved.some((c) => c.statuses.includes(id))))];
  return matchColumns(board.origin.kind === "github_project" ? withOptionIds(saved, fresh) : saved, fresh);
}

/**
 * A Project board saved when its columns held option names (before X50 kept
 * option ids): each name becomes the id of the fresh column of that name, so
 * the user's order, folding and categories carry over.
 */
function withOptionIds(saved: BoardColumn[], fresh: BoardColumn[]): BoardColumn[] {
  const ids = new Set(fresh.flatMap((f) => f.statuses));
  // A saved name is an option's, never No Status's `""`, even when a team named an option "No Status".
  const idOf = (s: string) => (ids.has(s) ? s : (fresh.find((f) => f.name === s && !f.statuses.includes(""))?.statuses[0] ?? s));
  return saved.map((c) => ({ ...c, statuses: c.statuses.map(idOf) }));
}

/** Board `board` with column `name` shown, folded or hidden (X50); moonlet-only, the tracker is not told. */
export function withColumnShow(board: BoardConfig, name: string, show: ColumnShow): BoardConfig {
  return {
    ...board,
    columns: syncedColumns(board, null).map((c) => {
      if (c.name !== name) return c;
      const { show: _, ...rest } = c;
      return show === "show" ? rest : { ...rest, show };
    }),
  };
}

/**
 * The projects whose committed `.moonlet/config.toml` links the board's
 * tracker project (X44), which its sessions start in by default (X50 By
 * default); for a Jira board, whose issues can be of any of the site's
 * projects, those linking any of its connection's.
 */
export function linkedProjects(board: Pick<BoardConfig, "connection" | "origin">, sourceProjects: Record<string, string[]>): string[] {
  const key = sourceKeyOf(board);
  const sources = Object.keys(sourceProjects).filter((s) => (key ? s === sourceKey(board.connection, key) : s.startsWith(sourceKey(board.connection, ""))));
  return [...new Set(sources.flatMap((s) => sourceProjects[s]))];
}

/** The sidebar footer's tracker (X50): the shown board's, else GitHub, whose repositories every workspace syncs. */
export const footerTracker = (shown: Pick<BoardConfig, "connection"> | null): string => (shown ? trackerName(shown.connection) : "GitHub");

/** Add a board's By default hint: the projects that link the tracker project (`linked`, ids), by name where known. */
export function byDefaultHint(linked: string[], projects: { id: string; name: string }[]): string {
  return `The projects that link it: ${linked.length ? linked.map((id) => projects.find((p) => p.id === id)?.name ?? id).join(", ") : "none yet"}`;
}

/** The column of a GitHub Project's items with no Status (X50), as GitHub names it; its status is `""`. */
export const NO_STATUS = "No Status";

/** A GitHub Project as moves need it (X50): its id, its Status field and the field's options. */
export interface ProjectMeta {
  id: string;
  field: string | null;
  options: { id: string; name: string }[];
  /** Its first number field's name, the estimate Cards show offers. */
  numberField?: string | null;
}

/**
 * The `gh.project_move` that sets `item`'s Status to the option whose id is
 * `status`, a column's status (or whose name it is, on a board still saved
 * with names), or clears it for `""`, the status of No Status; null when the
 * Project has no such option.
 */
export function projectMove(project: ProjectMeta, item: string, status: string): { project: string; item: string; field: string; option: string | null } | null {
  if (!project.field) return null;
  if (status === "") return { project: project.id, item, field: project.field, option: null };
  // By id; a board still saved with option names, by the name.
  const option = project.options.find((o) => o.id === status) ?? project.options.find((o) => o.name === status);
  return option ? { project: project.id, item, field: project.field, option: option.id } : null;
}

/**
 * Why a task's State menu is locked (X50): a GitHub Project's item moves only
 * with gh's `project` scope. Null while the scopes are not known yet, and for
 * any other task.
 */
export function projectMoveLock(task: Pick<Task, "github">, scopes: string[] | undefined): string | null {
  if (!task.github?.project || scopes === undefined || scopes.includes("project")) return null;
  return "Moving needs gh's project scope: run gh auth refresh -s project";
}
