// Boards (X50): one view of one tracker in a workspace, with the tracker's
// own columns. `BoardConfig` mirrors `moonlet-trackers::config::Board`, as
// saved in `trackers.toml`; `tasksBoard` builds what is drawn.

import type { Column } from "./tasks";
import type { TrackersConfig } from "./tasksStore";

/** What a board is built from. */
export type Origin =
  | { kind: "jira_board"; board: number }
  | { kind: "jql"; query: string }
  | { kind: "linear_team"; team: string }
  | { kind: "github_project"; owner: string; number: number }
  | { kind: "github_repo"; repo: string }
  | { kind: "clickup_list"; list: string };

export interface BoardColumn {
  /** As the tracker names it. */
  name: string;
  /** Jira status ids, else state names. */
  statuses: string[];
  category: Column;
  /** Absent: shown. */
  show?: "fold" | "hide";
  /** Jira's column limit. */
  wip?: number;
}

/** `when` of a "New sessions from this board start in" rule. */
export type When = "default" | { component: string } | { label: string };

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
  /** Days a finished issue stays, or only the active sprint, cycle or iteration's. */
  finished: number | "sprint";
  /** Empty until the first sync reads the tracker's statuses. */
  columns?: BoardColumn[];
  /** A migrated source's state mapping, until its columns are read. */
  states?: Record<string, Column>;
  rules?: { when: When; project: string }[];
  cards?: CardField[];
  /** Absent: pinned. */
  pinned?: false;
}

const GITHUB = "github:github.com";

/**
 * Turns workspace `wsKey`'s X44 sources and GitHub repositories (`repos`,
 * `owner/name`) into pinned boards, once per workspace: a board the user
 * removes later stays removed. The sources of other workspaces stay until
 * those are opened; a connection with no source left drops its state mapping,
 * which its boards carry now.
 */
export function migrateWorkspace(config: TrackersConfig, wsKey: string, repos: string[]): TrackersConfig {
  if (config.migrated?.includes(wsKey)) return config;
  const id = (connection: string, key: string) => `${connection}/${key}@${wsKey}`;
  const fromRepos: BoardConfig[] = repos.map((repo) => ({
    id: id(GITHUB, repo),
    name: repo,
    connection: GITHUB,
    workspace: wsKey,
    origin: { kind: "github_repo", repo },
    finished: 14,
  }));
  const fromSources: BoardConfig[] = (config.connections ?? []).flatMap((c) =>
    c.sources
      .filter((s) => s.workspace === wsKey)
      .map((s) => ({
        id: id(c.id, s.key),
        name: s.name,
        connection: c.id,
        workspace: wsKey,
        origin: ORIGIN[c.kind](s.key),
        finished: 14,
        ...(c.states && Object.keys(c.states).length ? { states: c.states } : {}),
      })),
  );
  const connections = config.connections?.map((c) => {
    const sources = c.sources.filter((s) => s.workspace !== wsKey);
    return { ...c, sources, states: sources.length ? c.states : undefined };
  });
  return {
    ...config,
    connections,
    boards: [...(config.boards ?? []), ...fromRepos, ...fromSources],
    migrated: [...(config.migrated ?? []), wsKey],
  };
}

const ORIGIN: Record<"linear" | "jira" | "clickup", (key: string) => Origin> = {
  jira: (key) => ({ kind: "jql", query: `project = ${key}` }),
  linear: (team) => ({ kind: "linear_team", team }),
  clickup: (list) => ({ kind: "clickup_list", list }),
};
