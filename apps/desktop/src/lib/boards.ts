// Boards (X50): one view of one tracker in a workspace, with the tracker's
// own columns. `BoardConfig` mirrors `moonlet-trackers::config::Board`, as
// saved in `trackers.toml`; `tasksBoard` builds what is drawn.

import type { Column } from "./tasks";
import type { TrackersConfig } from "./tasksStore";
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

/**
 * Turns workspace `wsKey`'s X44 sources and GitHub repositories (`repos`,
 * `owner/name`) into pinned boards, once per workspace: a board the user
 * removes later stays removed. The sources of other workspaces stay until
 * those are opened; a connection with no source left drops its state mapping,
 * which its boards carry now.
 */
export function migrateWorkspace(config: TrackersConfig, wsKey: string, repos: string[]): TrackersConfig {
  if (config.migrated?.includes(wsKey)) return config;
  const fromRepos: BoardConfig[] = [...new Set(repos)].map((repo) => ({
    id: boardId(GITHUB, repo, wsKey),
    name: repo,
    connection: GITHUB,
    workspace: wsKey,
    origin: { kind: "github_repo", repo },
  }));
  const fromSources: BoardConfig[] = (config.connections ?? []).flatMap((c) =>
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
  const connections = config.connections?.map((c) => {
    // A source no workspace was chosen for showed nowhere: it goes too.
    const sources = c.sources.filter((s) => s.workspace && s.workspace !== wsKey);
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
