// Which Linear, Jira and ClickUp sources each workspace shows (X44).

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
