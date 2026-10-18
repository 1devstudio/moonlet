// A new issue from a board column's + (X52): which columns have one, the
// form's defaults, and what the board does with the issue once the tracker
// has it. The requests themselves are the trackers' (tasksStore).

import { categorize } from "./boardColumns";
import type { Assignee, BoardColumn, BoardConfig } from "./boards";
import { type Task, taskId, trackerName } from "./tasks";

/**
 * Where a column's + creates its issue: the column's first status. None on
 * a folded or hidden column, one without statuses, or a GitHub repository's
 * Closed, since a new issue is open.
 */
export function createTarget(board: BoardConfig, column: BoardColumn): { status: string } | null {
  if (column.show === "fold" || column.show === "hide" || !column.statuses.length) return null;
  if (board.origin.kind === "github_repo" && !column.statuses.includes("open")) return null;
  return { status: column.statuses[0] };
}

/**
 * Why a board's + is disabled (X52), or null: its tracker needs attention
 * (X44), the host that runs gh is offline, or a GitHub Project's issues can't
 * be added without gh's `project` scope (unknown scopes don't lock it).
 */
export function createLock(board: BoardConfig, state: { attention?: string; hostOnline: boolean; scopes?: string[] }): string | null {
  if (state.attention !== undefined) return `Reconnect ${trackerName(board.connection)} to create issues: ${state.attention}`;
  const github = board.origin.kind === "github_repo" || board.origin.kind === "github_project";
  if (github && !state.hostOnline) return "The host that runs gh is offline";
  if (board.origin.kind === "github_project" && state.scopes && !state.scopes.includes("project")) return "Adding issues to a Project needs gh's project scope: run gh auth refresh -s project";
  return null;
}

/** What the form holds (X52). */
export interface NewIssue {
  title: string;
  /** Markdown. */
  description: string;
  /** `me`, `none` (Unassigned), or a person's id in the tracker. */
  assignee: string;
  labels: string[];
  /** Jira: the issue type's id. */
  issueType?: string;
  /** Where it goes when the board's issues come from several places: a Jira project key or a GitHub repository. */
  place?: string;
}

/** The form at first: assigned to the user, with the board's label filter so the issue matches it. */
export function newIssueDraft(board: BoardConfig): NewIssue {
  return { title: "", description: "", assignee: "me", labels: board.labels ?? [] };
}

/** Whether Create can be pressed: a title, and the place and issue type the board needs, while nothing is being asked. */
export function canSubmit(draft: NewIssue, state: { busy: boolean; needsPlace?: boolean; needsType?: boolean; missing?: string[]; problem?: string | null }): boolean {
  // A field Jira requires that the form lacks: the issue is created in Jira. A label it would refuse: fixed first.
  if (state.busy || !draft.title.trim() || state.missing?.length || state.problem) return false;
  return !(state.needsPlace && !draft.place) && !(state.needsType && !draft.issueType);
}

/**
 * Whether the board shows a new issue (X52), as far as moonlet can tell
 * before the next sync: not someone else's on a board at Assignee: me, not
 * outside its label filter, and not in a hidden column or none. A query the
 * issue doesn't match only shows at that sync.
 */
export function boardShows(board: BoardConfig, assignee: Assignee, columns: BoardColumn[], task: Task): boolean {
  if (assignee === "me" && task.mine === false) return false;
  const labels = new Set((board.labels ?? []).map((l) => l.toLowerCase()));
  if (labels.size && !task.labels.some((l) => labels.has(l.toLowerCase()))) return false;
  return categorize(columns, [task])[0].column !== "hidden";
}

/** An issue moonlet created, on its board, until a sync has it or shows the board doesn't (X52). */
export interface Created {
  boardId: string;
  task: Task;
  /** When the tracker answered, in ms. */
  at: number;
}

/**
 * A sync's tasks and boards with the issues moonlet created (X52). One the
 * sync has is done: the tracker's copy wins. One created after the sync
 * started is kept on its board, still `pending`. One a sync started after
 * creating lacks is `gone`: the board doesn't show it. One whose board the
 * sync didn't read stays `pending`, untouched.
 */
export function withCreated<B extends { keys: string[] }>(
  synced: { tasks: Task[]; boards?: Record<string, B> },
  created: Created[],
  syncStartedAt: number,
): { tasks: Task[]; boards?: Record<string, B>; pending: Created[]; gone: Created[] } {
  const has = new Set(synced.tasks.map(taskId));
  const read = (c: Created) => !!synced.boards?.[c.boardId];
  const kept = created.filter((c) => read(c) && !has.has(taskId(c.task)) && c.at >= syncStartedAt);
  const gone = created.filter((c) => read(c) && !has.has(taskId(c.task)) && c.at < syncStartedAt);
  const pending = [...kept, ...created.filter((c) => !read(c))];
  if (!kept.length) return { ...synced, pending, gone };
  const boards = { ...synced.boards };
  for (const c of kept) boards[c.boardId] = { ...boards[c.boardId], keys: [...boards[c.boardId].keys, taskId(c.task)] };
  return { tasks: [...synced.tasks, ...kept.map((c) => c.task)], boards, pending, gone };
}

/** Whether the board's tracker is one moonlet creates issues in (X52): every board's. */
export const createsIn = (board: BoardConfig) => ["linear_team", "clickup_list", "github_repo", "github_project", "jira_board", "jql"].includes(board.origin.kind);

/** Whether the issue needs a place the form picks (X52): a GitHub Project's repository, a Jira board's project. */
export const needsPlace = (board: BoardConfig) => board.origin.kind === "github_project" || isJira(board);

/** Whether the form asks for an issue type (X52): Jira's. */
export const needsType = (board: BoardConfig) => isJira(board);

/**
 * The projects a Jira board's new issue can go in (X52): those of the
 * board's issues (the tasks whose keys it lists), the most common first.
 */
export function jiraProjects(tasks: Task[], keys: string[]): string[] {
  const onBoard = new Set(keys);
  const counts = new Map<string, number>();
  for (const t of tasks) if (onBoard.has(taskId(t))) counts.set(t.key.split("-")[0], (counts.get(t.key.split("-")[0]) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([project]) => project);
}

/**
 * The repositories a GitHub Project's new issue can go in (X52): the
 * workspace's (its projects' origins, `repos`), then those of the board's
 * items (the tasks whose keys the board lists), each once whatever its case.
 */
export function projectRepos(repos: Record<string, string | null> | undefined, tasks: Task[], keys: string[]): string[] {
  const onBoard = new Set(keys);
  const items = tasks.flatMap((t) => (onBoard.has(taskId(t)) && t.github ? [t.github.repo] : []));
  const seen = new Set<string>();
  return [...Object.values(repos ?? {}).filter((r): r is string => !!r), ...items].filter((r) => !seen.has(r.toLowerCase()) && !!seen.add(r.toLowerCase()));
}

/** The GitHub repository a board's new issue goes in (X52): a repository board's own, a Project's picked one; none for other trackers. */
export function githubRepoOf(board: BoardConfig, place?: string): string | undefined {
  if (board.origin.kind === "github_repo") return board.origin.repo;
  return board.origin.kind === "github_project" ? place : undefined;
}

/**
 * The form once the lists for its place arrive (X52): what the user chose
 * stays, but an assignee the place doesn't have (a person of the repository
 * picked before) goes back to the user.
 */
export function fitDraft(draft: NewIssue, people: string[]): NewIssue {
  return draft.assignee === "me" || draft.assignee === "none" || people.includes(draft.assignee) ? draft : { ...draft, assignee: "me" };
}

/**
 * The form's Assignee and Labels where they can't be set (X52): GitHub drops
 * them without gh's user's access (`canSet`), and a Jira create screen may
 * lack them (`fields`, its field ids). Those not offered are not sent.
 */
export function withAccess(draft: NewIssue, access: { canSet: boolean; fields?: string[] }): { draft: NewIssue; assignee: boolean; labels: boolean } {
  const on = (field: string) => access.canSet && (!access.fields || access.fields.includes(field));
  const assignee = on("assignee");
  const labels = on("labels");
  return { draft: { ...draft, ...(!assignee && { assignee: "none" }), ...(!labels && { labels: [] }) }, assignee, labels };
}

/** Whether a board is Jira's: a Jira board or a JQL query. */
export const isJira = (board: BoardConfig) => board.origin.kind === "jira_board" || board.origin.kind === "jql";

/** Why the labels can't be sent (X52): Jira refuses a label with a space. */
export function labelProblem(board: BoardConfig, labels: string[]): string | null {
  const spaced = isJira(board) ? labels.filter((l) => /\s/.test(l)) : [];
  return spaced.length ? `Jira labels can't have spaces: ${spaced.join(", ")}` : null;
}

/** A Jira project's page, where an issue the form can't create is made (X52); `connection` is `jira:<site>`. */
export const jiraProjectUrl = (connection: string, project: string) => `https://${connection.replace(/^jira:/, "")}/browse/${encodeURIComponent(project)}`;

/**
 * Why a board's + is disabled, from the app's state (X52): the connection's
 * attention (X44), the status of the workspace's `host`, and gh's scopes on it.
 */
export function createLockOn(
  board: BoardConfig,
  host: string,
  state: { attention: Record<string, string>; hosts: Record<string, { status: string } | undefined>; scopes: Record<string, string[] | undefined> },
): string | null {
  return createLock(board, { attention: state.attention[board.connection], hostOnline: state.hosts[host]?.status === "connected", scopes: state.scopes[host] });
}
