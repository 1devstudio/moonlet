// Which Linear, Jira and ClickUp sources each workspace shows (X44).

import type { Column } from "./tasks";
import { trackerName } from "./tasks";
import type { Connection } from "./tasksStore";

export interface WorkspaceConnection {
  id: string;
  /** The team keys, project keys or list ids shown in the workspace. */
  keys: string[];
  /** The project each source's sessions start in, by key (chosen ones only). */
  projects: Record<string, string>;
  /** Sources that show all open issues, not only the account's (X44 Shows). */
  all: string[];
  /** Who the connection is signed in as, to tell the account's issues. */
  account: string;
}

/** The connections with a source in workspace `wsKey` (`host/workspaceId`). */
export function workspaceConnections(connections: Connection[] | undefined, wsKey: string): WorkspaceConnection[] {
  return (connections ?? []).flatMap((c) => {
    const here = c.sources.filter((s) => s.workspace === wsKey);
    if (!here.length) return [];
    return [
      {
        id: c.id,
        keys: here.map((s) => s.key),
        projects: Object.fromEntries(here.filter((s) => s.project).map((s) => [s.key, s.project])),
        all: here.filter((s) => s.all).map((s) => s.key),
        account: c.account,
      },
    ];
  });
}

export interface SourceEntry {
  tracker: string;
  name: string;
  /** Why its connection needs attention, if it does (X44). */
  attention: string | undefined;
}

/**
 * A workspace's task sources: its projects' GitHub repositories, then each
 * connection's teams, projects or lists shown there.
 */
export function sourceList(wsKey: string, repos: string[], connections: Connection[] | undefined, attention: Record<string, string>): SourceEntry[] {
  const github = repos.map((name) => ({ tracker: "GitHub", name, attention: undefined }));
  const others = (connections ?? []).flatMap((c) =>
    c.sources.filter((s) => s.workspace === wsKey).map((s) => ({ tracker: trackerName(c.kind), name: s.name, attention: attention[c.id] })),
  );
  return [...github, ...others];
}

/** The States dialog's mapping as saved: only states moved off their default column (X44). */
export function changedStates(states: { name: string; column: Column }[], mapping: Record<string, Column>): Record<string, Column> {
  const defaults = Object.fromEntries(states.map((s) => [s.name, s.column]));
  return Object.fromEntries(Object.entries(mapping).filter(([name, column]) => defaults[name] !== column));
}
