// The workspace switcher (X32): one workspace is shown at a time, picked
// from a menu in the title bar or with ⌃⌘1–9. Pure, so it is unit-tested.

import type { Section, Session, Workspace, WorkspaceColor } from "./protocol";

/** The design's swatches, in the order the New workspace dialog shows them. */
export const WORKSPACE_COLORS: { id: WorkspaceColor; label: string; hex: string }[] = [
  { id: "clay", label: "Clay", hex: "#d97757" },
  { id: "blue", label: "Blue", hex: "#6f9fe8" },
  { id: "violet", label: "Violet", hex: "#a98be8" },
  { id: "sand", label: "Sand", hex: "#d9b779" },
  { id: "grey", label: "Grey", hex: "#8c8c8c" },
];

export const colorHex = (c: WorkspaceColor) => WORKSPACE_COLORS.find((x) => x.id === c)?.hex ?? WORKSPACE_COLORS[0].hex;

/** The letter on a workspace's colour square. */
export function workspaceInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?";
}

/** One host's data, as the switcher needs it. Hosts come local first. */
export interface HostWorkspaces {
  host: string;
  label: string;
  workspaces: Workspace[];
  sections: Section[];
  sessions: Session[];
}

export interface SwitcherRow {
  host: string;
  /** The host's name above its first row, when there are several hosts. */
  hostLabel: string | null;
  ws: Workspace;
  initial: string;
  summary: string;
  /** `⌃⌘1` to `⌃⌘9` for the first nine rows. */
  kbd: string | null;
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The switcher menu's rows, in order: hosts as given, workspaces in each. */
export function switcherRows(hosts: HostWorkspaces[]): SwitcherRow[] {
  const rows: SwitcherRow[] = [];
  for (const h of hosts) {
    h.workspaces.forEach((ws, i) => {
      const live = h.sessions.filter((s) => !s.archived && s.workspace_id === ws.id).length;
      const n = rows.length;
      rows.push({
        host: h.host,
        hostLabel: hosts.length > 1 && i === 0 ? h.label : null,
        ws,
        initial: workspaceInitial(ws.name),
        summary: `${count(ws.section_ids.length, "section")} · ${count(live, "session")}`,
        kbd: n < 9 ? `⌃⌘${n + 1}` : null,
      });
    });
  }
  return rows;
}

/** Where the sidebar is: a workspace of a host. */
export interface WorkspaceRef {
  host: string;
  id: string;
}

/** The remembered workspace while it still exists, else the first one. */
export function currentWorkspace(cur: WorkspaceRef | null, hosts: HostWorkspaces[]): WorkspaceRef | null {
  if (cur && hosts.some((h) => h.host === cur.host && h.workspaces.some((w) => w.id === cur.id))) return cur;
  const first = hosts.find((h) => h.workspaces.length);
  return first ? { host: first.host, id: first.workspaces[0].id } : null;
}

/** `host/id` of each workspace with a live session for which `needs` holds
 * (it needs input, or finished unread). */
export function workspacesNeedingYou(hosts: HostWorkspaces[], needs: (host: string, s: Session) => boolean): Set<string> {
  const out = new Set<string>();
  for (const h of hosts) {
    for (const s of h.sessions) {
      if (!s.archived && s.workspace_id && needs(h.host, s)) out.add(`${h.host}/${s.workspace_id}`);
    }
  }
  return out;
}

/** The session to reopen when switching to workspace `wsId`. */
export function sessionToRestore(last: string | undefined, sessions: Session[], wsId: string): string | null {
  const s = last ? sessions.find((x) => x.id === last) : undefined;
  return s && !s.archived && s.workspace_id === wsId ? s.id : null;
}

export interface NewWorkspaceForm {
  name: string;
  color: WorkspaceColor;
  /** Start empty, or with sections moved from the current workspace. */
  start: "empty" | "move";
  moving: string[];
}

/** `workspace.create`'s params, or null while the form cannot be sent. */
export function createRequest(f: NewWorkspaceForm): { name: string; color: WorkspaceColor; move_sections: string[] } | null {
  const name = f.name.trim();
  if (!name) return null;
  return { name, color: f.color, move_sections: f.start === "move" ? f.moving : [] };
}

/** Why Delete workspace is disabled, mirroring the daemon's refusals. */
export function deleteBlocked(ws: Workspace, workspaceCount: number): string | null {
  if (workspaceCount <= 1) return "The last workspace cannot be deleted.";
  const n = ws.section_ids.length;
  if (n) return n === 1 ? "Move or delete its section first." : `Move or delete its ${n} sections first.`;
  return null;
}

/** The projects the composer offers for a session in `ws`: those its
 * sections hold, or all of them while it holds none. */
export function composerProjects<P extends { id: string }>(ws: Workspace, sections: Section[], projects: P[]): P[] {
  const ids = ws.section_ids.flatMap((id) => sections.find((s) => s.id === id)?.project_ids ?? []);
  const held = projects.filter((p) => ids.includes(p.id)).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  return held.length ? held : projects;
}
