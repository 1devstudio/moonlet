// Boards (X50): one view of one tracker in a workspace, with the tracker's
// own columns. `BoardConfig` mirrors `moonlet-trackers::config::Board`, as
// saved in `trackers.toml`; `tasksBoard` builds what is drawn.

import type { Column, Task } from "./tasks";
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

export interface BoardColumn {
  /** As the tracker names it. */
  name: string;
  /** Status or state ids where the tracker has them (Jira, Linear), else names (ClickUp; a GitHub repository's `open`, `completed`, `not_planned`). */
  statuses: string[];
  category: Category;
  /** Absent: shown. */
  show?: "fold" | "hide";
  /** Jira's column limit. */
  wip?: number;
}

/** A "New sessions from this board start in" rule: `project` when `when` matches. */
export interface StartRule {
  when: "default" | { component: string } | { label: string };
  project: string;
}

export type CardField = "issue_type" | "points" | "assignee" | "parent" | "due" | "labels";

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
  /** A migrated source's state mapping, until its columns are read. */
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
 * Turns workspace `wsKey`'s X44 sources into pinned boards once, and each
 * GitHub repository of its projects (`repos`, `owner/name`) into one the
 * first time a sync sees it. `migrated` remembers both, so a board the user
 * removes stays removed, while a repository whose origin could not be read
 * this time gets its board on a later sync. The sources of other workspaces
 * stay until those are opened; a connection with no source left drops its
 * state mapping, which its boards carry now. Returns `config` itself when
 * there is nothing to do.
 */
export function migrateWorkspace(config: TrackersConfig, wsKey: string, repos: string[]): TrackersConfig {
  const done = new Set(config.migrated ?? []);
  const newRepos = [...new Set(repos)].filter((repo) => !done.has(repoSeen(wsKey, repo)));
  const sourcesDone = done.has(wsKey);
  if (sourcesDone && !newRepos.length) return config;
  const fromRepos: BoardConfig[] = newRepos.map((repo) => ({
    id: boardId(GITHUB, repo, wsKey),
    name: repo,
    connection: GITHUB,
    workspace: wsKey,
    origin: { kind: "github_repo", repo },
  }));
  const fromSources: BoardConfig[] = sourcesDone
    ? []
    : (config.connections ?? []).flatMap((c) =>
        c.sources
          .filter((s) => s.workspace === wsKey)
          .map((s) => ({
            id: boardId(c.id, s.key, wsKey),
            name: s.name,
            connection: c.id,
            workspace: wsKey,
            origin: ORIGIN[c.kind](s.key),
            ...(c.states && Object.keys(c.states).length ? { states: c.states } : {}),
          })),
      );
  const connections = sourcesDone
    ? config.connections
    : config.connections?.map((c) => {
        // A source no workspace was chosen for showed nowhere: it goes too.
        const sources = c.sources.filter((s) => s.workspace && s.workspace !== wsKey);
        return { ...c, sources, states: sources.length ? c.states : undefined };
      });
  return {
    ...config,
    connections,
    boards: [...(config.boards ?? []), ...fromRepos, ...fromSources],
    migrated: [...(config.migrated ?? []), ...(sourcesDone ? [] : [wsKey]), ...newRepos.map((repo) => repoSeen(wsKey, repo))],
  };
}

const ORIGIN: Record<"linear" | "jira" | "clickup", (key: string) => Origin> = {
  jira: (key) => ({ kind: "jql", query: `project = ${key}` }),
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
export type BoardIssue = Task & { statusId: string };

/** A board issue as a task: its status id goes with the tracker's state. */
export function taskFromBoardIssue({ statusId, ...task }: BoardIssue): Task {
  return { ...task, tracker: task.tracker && { ...task.tracker, statusId } };
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
  return [...kept, ...fresh.filter((f) => !used.has(f))];
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
export function sourceKeyOf(b: BoardConfig): string | null {
  if (b.origin.kind === "linear_team") return b.origin.team;
  if (b.origin.kind === "clickup_list") return b.origin.list;
  if (b.origin.kind === "jql") return /^project = ([A-Za-z0-9_]+)$/.exec(b.origin.query)?.[1] ?? null;
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
