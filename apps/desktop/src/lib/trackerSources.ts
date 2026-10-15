// Which Linear, Jira and ClickUp sources each workspace shows (X44).

import type { Column } from "./tasks";
import { trackerName } from "./tasks";
import type { Connection, Source } from "./tasksStore";

export interface WorkspaceConnection {
  id: string;
  /** The team keys, project keys or list ids shown in the workspace. */
  keys: string[];
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
export const blankSource = (): Source => ({ key: "", name: "", workspace: "" });

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

/** A project's link to a tracker source in `.moonlet/config.toml`: `jira:acme.atlassian.net/ABC` (X44). */
export const trackerLink = (connection: string, key: string) => `${connection}/${key}`;

/** The connection and key of a link, or null when it is not `<connection>/<key>`. */
export function parseTrackerLink(link: string): { connection: string; key: string } | null {
  const at = link.indexOf("/");
  const connection = link.slice(0, at);
  const key = link.slice(at + 1);
  return at > 0 && connection.includes(":") && key ? { connection, key } : null;
}

export interface TrackerLink {
  /** `<connection>/<key>`, as `.moonlet/config.toml` keeps it. */
  id: string;
  label: string;
}

/**
 * Project settings › Task trackers (X44): the tracker projects a project
 * handles, named, and the connections' other sources it can add.
 */
export function projectTrackers(connections: Connection[] | undefined, linked: string[]): { linked: TrackerLink[]; choices: TrackerLink[] } {
  const known = new Map<string, TrackerLink>();
  for (const c of connections ?? [])
    for (const s of c.sources) {
      const id = trackerLink(c.id, s.key);
      if (!known.has(id)) known.set(id, { id, label: `${sourceNoun(c.kind)} ${s.name} (${s.key})` });
    }
  return {
    linked: linked.map((id) => known.get(id) ?? { id, label: id }),
    choices: [...known.values()].filter((l) => !linked.includes(l.id)),
  };
}
