// Which Linear, Jira and ClickUp sources each workspace shows (X44).

import { type BoardConfig, sourceKeyOf } from "./boards";
import type { Column } from "./tasks";
import { trackerName, trackerOf } from "./tasks";
import type { Connection, Source } from "./tasksStore";

export interface SourceEntry {
  /** The board's id, for its settings (X50). */
  id: string;
  tracker: string;
  name: string;
  /** Why its connection needs attention, if it does (X44). */
  attention: string | undefined;
}

/** A workspace's boards, by tracker and name, with why a board's connection needs attention (X44, X50). */
export function sourceList(wsKey: string, boards: BoardConfig[] | undefined, attention: Record<string, string>): SourceEntry[] {
  return (boards ?? []).filter((b) => b.workspace === wsKey).map((b) => ({ id: b.id, tracker: trackerName(b.connection), name: b.name, attention: attention[b.connection] }));
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
 * handles, named, and the other tracker projects its workspaces' boards show
 * (X50) that it can add.
 */
export function projectTrackers(boards: BoardConfig[] | undefined, linked: string[]): { linked: TrackerLink[]; choices: TrackerLink[] } {
  const known = new Map<string, TrackerLink>();
  for (const b of boards ?? []) {
    const key = sourceKeyOf(b);
    const kind = trackerOf(b.connection);
    if (!key || !kind || kind === "github") continue;
    const id = trackerLink(b.connection, key);
    if (!known.has(id)) known.set(id, { id, label: `${sourceNoun(kind)} ${b.name} (${key})` });
  }
  return {
    linked: linked.map((id) => known.get(id) ?? { id, label: id }),
    choices: [...known.values()].filter((l) => !linked.includes(l.id)),
  };
}

/** The Disconnect confirm (X44, X50): the boards that go with connection `id`, by name. */
export function disconnectText(id: string, site: string, boards: BoardConfig[] | undefined): string {
  const names = (boards ?? []).filter((b) => b.connection === id).map((b) => b.name);
  const listed = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  const what = names.length === 0 ? "stops showing its issues" : names.length === 1 ? `removes its board ${listed}` : `removes its ${names.length} boards, ${listed}`;
  return `moonlet forgets the token for ${site} and ${what}. Sessions keep their links.`;
}

const SEEN: Record<"linear" | "jira" | "clickup", [string, string, string]> = {
  linear: ["team", "teams", "one of its teams"],
  jira: ["project", "projects", "one of its Jira boards or a JQL query"],
  clickup: ["list", "lists", "one of its lists"],
};

/** The Connect dialog's end (X50): who signed in and what the account sees, then what its first board can be built from. */
export function connectedText(kind: "linear" | "jira" | "clickup", account: string, visible: number): { line: string; hint: string } {
  const [one, many, from] = SEEN[kind];
  return { line: `Signed in as ${account} · ${visible} ${visible === 1 ? one : many} visible`, hint: `Make the first board from ${from}.` };
}
