// Several sessions picked in the sidebar (X106): ⌘-click, ⇧-click, and what
// the selection bar and its actions say. Pure, so the sidebar only wires it.

import type { Project, Section, Session, Workspace, WorkspaceColor } from "./protocol";
import { holdsProject } from "./sidebar";

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

/** A workspace Move to offers. */
export interface MoveTarget {
  id: string;
  name: string;
  color: WorkspaceColor;
  profile: string | null;
  /** Every picked session is in it already. */
  current: boolean;
  /** Why it can't be picked, or null. */
  disabled: string | null;
}

/** One host's workspaces, sections and projects, as the store has them. */
export interface HostPlaces {
  host: string;
  workspaces: Workspace[];
  sections: Section[];
  projects: Project[];
}

/**
 * The workspaces Move to lists for `picked` (X106): the account's, as the
 * first picked session's host has them. A session shows only in a workspace
 * with a section holding its project, so one without is disabled, as is the
 * whole menu while a picked session runs on another member (X72).
 */
export function moveTargets(picked: { host: string; session: Session }[], hosts: HostPlaces[]): { disabled: string | null; targets: MoveTarget[] } {
  const theirs = picked.find((p) => p.session.owner);
  if (theirs) return { disabled: `${theirs.session.name} runs on ${theirs.session.owner!.name}`, targets: [] };
  const placesOf = (host: string) => hosts.find((h) => h.host === host);
  const listed = picked.length ? (placesOf(picked[0].host)?.workspaces ?? []) : [];
  const targets = listed.map((w): MoveTarget => {
    const current = picked.every((p) => p.session.workspace_id === w.id);
    const missing = picked.find((p) => {
      const places = placesOf(p.host);
      const here = places?.workspaces.find((x) => x.id === w.id);
      return !here || !holdsProject(here, places!.sections, p.session.project_id);
    });
    const project = missing && (placesOf(missing.host)?.projects.find((x) => x.id === missing.session.project_id)?.name ?? missing.session.project_id);
    const disabled = current ? `They are in ${w.name}` : missing ? `${project} is not in ${w.name}` : null;
    return { id: w.id, name: w.name, color: w.color, profile: w.claude_profile ?? null, current, disabled };
  });
  return { disabled: null, targets };
}
