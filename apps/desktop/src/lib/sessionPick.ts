// Several sessions picked in the sidebar (X106): ⌘-click, ⇧-click, and what
// the selection bar and its actions say. Pure, so the sidebar only wires it.

import type { ClaudeProfile, ProfileInfo, Project, Section, Session, TerminalInfo, Workspace, WorkspaceColor } from "./protocol";
import { runningClaudeAgents, switchConfirm } from "./profiles";
import { parseSesKey } from "./sesKey";
import { holdsProject } from "./sidebar";

/** A picked session and the host listing it: what every bulk action takes. */
export interface PickedSession {
  host: string;
  ws: Session;
}

/** The picked sessions as `host/session` keys, in the sidebar's order, and
 * the row the last click was on, where a ⇧-click range starts. */
export interface SessionPick {
  keys: string[];
  anchor: string | null;
}

export const NO_PICK: SessionPick = { keys: [], anchor: null };

/** A click on row `key`, with ⌘ or ⇧ held. */
export interface PickClick {
  key: string;
  cmd: boolean;
  shift: boolean;
}

/** What a click on a row does: the picks after it, and whether it opens the
 * session. `rows` are the sidebar's rows top to bottom. */
export function clickPick(p: SessionPick, c: PickClick, rows: string[]): { pick: SessionPick; open: boolean } {
  if (c.shift) {
    // Each session once: one in two sections shows twice in `rows`.
    const order = [...new Set(rows)];
    const from = p.anchor ? order.indexOf(p.anchor) : -1;
    const to = order.indexOf(c.key);
    if (from < 0 || to < 0) return { pick: { keys: inOrder([...p.keys, c.key], rows), anchor: c.key }, open: false };
    const range = order.slice(Math.min(from, to), Math.max(from, to) + 1);
    return { pick: { keys: inOrder([...p.keys, ...range], rows), anchor: p.anchor }, open: false };
  }
  if (c.cmd) {
    const on = !p.keys.includes(c.key);
    const keys = on ? inOrder([...p.keys, c.key], rows) : p.keys.filter((k) => k !== c.key);
    return { pick: { keys, anchor: c.key }, open: false };
  }
  return { pick: { keys: [], anchor: c.key }, open: true };
}

/** `keys` once each, in the order of `rows`. */
function inOrder(keys: string[], rows: string[]): string[] {
  const want = new Set(keys);
  return [...new Set(rows)].filter((k) => want.has(k));
}

/** The picks of sessions the sidebar still shows: one archived or moved to
 * another workspace leaves them. `p` itself when nothing left. */
export function shownPick(p: SessionPick, rows: string[]): SessionPick {
  const shown = new Set(rows);
  if (p.keys.every((k) => shown.has(k)) && (!p.anchor || shown.has(p.anchor))) return p;
  return { keys: p.keys.filter((k) => shown.has(k)), anchor: p.anchor && shown.has(p.anchor) ? p.anchor : null };
}

/** The selection bar's words: "3 selected", and "in 2 projects" when the
 * picked sessions are in more than one. `projects` has one entry per pick. */
export function pickLine(projects: string[]): { count: string; where: string | null } {
  const n = new Set(projects).size;
  return { count: `${projects.length} selected`, where: n > 1 ? `in ${n} projects` : null };
}

/** The picked sessions the hosts still list, in the picks' order. */
export function pickedSessions(p: SessionPick, sessions: Record<string, Session[]>): PickedSession[] {
  return p.keys.flatMap((k) => {
    const { host, id } = parseSesKey(k);
    const ws = (sessions[host] ?? []).find((x) => x.id === id);
    return ws ? [{ host, ws }] : [];
  });
}

/** Whether Esc on `target` clears the picks: not while it is for a text
 * field, a terminal (xterm's own textarea) or a code editor. */
export function escClearsPick(target: Element | null): boolean {
  return !target?.closest("input, textarea, select, [contenteditable='true'], .xterm, .monaco-editor");
}

/** A workspace Move to offers. */
export interface MoveTarget {
  id: string;
  name: string;
  color: WorkspaceColor;
  profile: string | null;
  /** The Claude profile's name when it is another than the picks' workspace's (X33). */
  note: string | null;
  /** Every picked session is in it already. */
  current: boolean;
  /** Why it can't be picked, or null. */
  disabled: string | null;
}

/** One host's workspaces, sections, projects and Claude profiles, as the store has them. */
export interface HostPlaces {
  host: string;
  workspaces: Workspace[];
  sections: Section[];
  projects: Project[];
  profiles: ClaudeProfile[];
}

const projectName = (places: HostPlaces | undefined, s: Session) => places?.projects.find((x) => x.id === s.project_id)?.name ?? s.project_id;

/**
 * The workspaces Move to lists for `picked` (X106): the account's, as the
 * first picked session's host has them. The picks are all in the workspace
 * the sidebar shows, one account's, whose workspaces keep their ids on every
 * member (X68), so a workspace is the same id on each picked session's host.
 * A session shows only in a workspace with a section holding its project, so
 * one without is disabled, as is the whole menu while a picked session runs
 * on another member (X72).
 */
export function moveTargets(picked: PickedSession[], hosts: HostPlaces[]): { disabled: string | null; targets: MoveTarget[] } {
  const theirs = picked.find((p) => p.ws.owner);
  if (theirs) return { disabled: `${theirs.ws.name} runs on ${theirs.ws.owner!.name}`, targets: [] };
  const placesOf = (host: string) => hosts.find((h) => h.host === host);
  const first = picked.length ? placesOf(picked[0].host) : undefined;
  const fromProfile = first?.workspaces.find((w) => w.id === picked[0].ws.workspace_id)?.claude_profile ?? null;
  const targets = (first?.workspaces ?? []).map((w): MoveTarget => {
    const current = picked.every((p) => p.ws.workspace_id === w.id);
    const missing = picked.find((p) => {
      const places = placesOf(p.host);
      const here = places?.workspaces.find((x) => x.id === w.id);
      return !here || !holdsProject(here, places!.sections, p.ws.project_id);
    });
    const disabled = current ? `They are in ${w.name}` : missing ? `${projectName(placesOf(missing.host), missing.ws)} is not in ${w.name}` : null;
    const profile = w.claude_profile ?? null;
    const note = profile === fromProfile ? null : profile ? (first?.profiles.find((x) => x.id === profile)?.name ?? null) : "Default";
    return { id: w.id, name: w.name, color: w.color, profile, note, current, disabled };
  });
  return { disabled: null, targets };
}

/** One host's sessions and terminals, for what moving would switch. */
export interface HostRunning {
  host: string;
  workspaces: Workspace[];
  profiles: ProfileInfo[];
  sessions: Session[];
  terminals: TerminalInfo[];
}

/** The question before moving `picked` to `to` (X106): asked when Claude
 * agents running in them would switch profiles, as moving a section asks
 * (X33); null when nothing switches. */
export function moveConfirm(picked: PickedSession[], to: MoveTarget, hosts: HostRunning[]): string | null {
  for (const h of hosts) {
    const mine = picked.filter((p) => p.host === h.host);
    if (!mine.length) continue;
    const from = h.workspaces.find((w) => w.id === mine[0].ws.workspace_id)?.claude_profile ?? null;
    const agents = runningClaudeAgents(h.sessions, h.terminals, mine.map((p) => p.ws.id));
    const message = switchConfirm(from, to.profile, agents, h.profiles);
    if (message) return message;
  }
  return null;
}
