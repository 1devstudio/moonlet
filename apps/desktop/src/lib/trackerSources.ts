// Which Linear, Jira and ClickUp sources each workspace shows (X44).

import type { Column } from "./tasks";
import { trackerName } from "./tasks";
import type { Connection, Source } from "./tasksStore";

export interface WorkspaceConnection {
  id: string;
  /** The team keys, project keys or list ids shown in the workspace. */
  keys: string[];
  /** The project each source's sessions start in, by key (chosen ones only). */
  projects: Record<string, string>;
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

const SOURCE_WORD: Record<Connection["kind"], string> = { linear: "team", jira: "project", clickup: "list" };

/** What one source is in a tracker, for the Sources dialog: `Jira project` (X44). */
export function sourceNoun(kind: Connection["kind"]): string {
  return `${trackerName(kind)} ${SOURCE_WORD[kind]}`;
}

/** A Sources dialog row with no source picked yet. */
export const blankSource = (): Source => ({ key: "", name: "", project: "", workspace: "" });

/** The rows the Sources dialog opens with: the saved sources, or one empty row (X44). */
export function sourceRows(saved: Source[]): Source[] {
  return saved.length ? saved : [blankSource()];
}

/**
 * What the picker in row `i` offers: the visible sources no other row shows in
 * the same workspace. A saved source the account no longer sees stays in its own row.
 */
export function sourceChoices(visible: { key: string; name: string }[], rows: Source[], i: number): { key: string; name: string }[] {
  const own = rows[i];
  const taken = new Set(rows.filter((r, j) => j !== i && r.key && r.workspace === own.workspace).map((r) => r.key));
  const gone = own.key && !visible.some((c) => c.key === own.key) ? [{ key: own.key, name: own.name }] : [];
  return [...gone, ...visible.filter((c) => !taken.has(c.key))];
}

/** The Sources dialog's rows as saved: those with a source picked, once per workspace (X44). */
export function sourcesToSave(rows: Source[]): Source[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const id = `${r.workspace} ${r.key}`;
    if (!r.key || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
