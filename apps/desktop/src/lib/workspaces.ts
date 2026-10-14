// The workspace switcher (X32): one workspace is shown at a time, picked
// from a menu in the title bar or with ⌃⌘1–9. Pure, so it is unit-tested.

import type { ProfileInfo, Section, Session, Workspace, WorkspaceColor } from "./protocol";
import { profileName } from "./profiles";
import { workspaceSections } from "./sidebar";

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
  /** Claude profiles (X33), named at the end of each summary. */
  profiles: ProfileInfo[];
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

/** `1 section`, `2 sections`. */
export const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

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
        summary: `${count(ws.section_ids.length, "section")} · ${count(live, "session")} · ${profileName(ws, h.profiles)}`,
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

/** The key of a workspace in per-workspace records (`lastSession`, attention). */
export const wsKey = (host: string, id: string) => `${host}/${id}`;

/** Whether workspace `id` of `host` is the one shown. */
export const isShown = (shown: WorkspaceRef | null, host: string, id: string) => shown?.host === host && shown.id === id;

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
      if (!s.archived && s.workspace_id && needs(h.host, s)) out.add(wsKey(h.host, s.workspace_id));
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

/** One host as the composer sees it. */
export interface ComposerHost<P extends { id: string }> {
  connected: boolean;
  workspaces: Workspace[];
  sections: Section[];
  projects: P[];
}

/** The composer's project picker (X32): the target workspace's projects, in
 * section order and labelled with the section holding them; without a
 * target, every connected host's projects. */
export function composerOptions<P extends { id: string }>(hosts: Record<string, ComposerHost<P>>, target: WorkspaceRef | null): { host: string; project: P; section: string | null }[] {
  const out: { host: string; project: P; section: string | null }[] = [];
  for (const [host, h] of Object.entries(hosts)) {
    if (!h.connected) continue;
    const ws = target ? h.workspaces.find((w) => isShown(target, host, w.id)) : undefined;
    if (target && !ws) continue;
    const secs = ws ? ws.section_ids.flatMap((id) => h.sections.find((s) => s.id === id) ?? []) : h.sections;
    for (const sec of secs) {
      for (const id of sec.project_ids) {
        const project = h.projects.find((p) => p.id === id);
        if (project && !out.some((o) => o.host === host && o.project.id === id)) out.push({ host, project, section: sec.name });
      }
    }
    if (!ws) for (const project of h.projects) if (!out.some((o) => o.host === host && o.project.id === project.id)) out.push({ host, project, section: null });
  }
  return out;
}

/** Where the composer creates the session: the workspace it was opened for
 * (`host` defaults to the shown one's), else the shown workspace. */
export function composerTarget(host: string | undefined, workspace: string | undefined, shown: WorkspaceRef | null): WorkspaceRef | null {
  if (workspace) {
    const h = host ?? shown?.host;
    return h ? { host: h, id: workspace } : null;
  }
  return shown;
}

/** The workspace "New section" adds to: the shown one on `host`, else the host's first. */
export function newSectionWorkspace(shown: WorkspaceRef | null, host: string, workspaces: Workspace[]): string | null {
  return shown?.host === host ? shown.id : (workspaces[0]?.id ?? null);
}

/** Under a workspace page's name (X43): "Workspace on this Mac · 2 sections ·
 * 9 sessions". `remote`: the host's name, null for this Mac. */
export function workspaceSummary(ws: Workspace, remote: string | null, sessions: Session[]): string {
  const open = sessions.filter((s) => s.workspace_id === ws.id && !s.archived).length;
  return `Workspace on ${remote ?? "this Mac"} · ${count(ws.section_ids.length, "section")} · ${count(open, "session")}`;
}

/** A workspace's sections in sidebar order, with their project counts. */
export function sectionRows(ws: Workspace, sections: Section[]): { id: string; name: string; projects: string }[] {
  return workspaceSections(ws, sections).map((sec) => ({ id: sec.id, name: sec.name, projects: count(sec.project_ids.length, "project") }));
}

/** The workspace page's fields; `profile` is "" for the default profile. */
export interface WorkspaceForm {
  name: string;
  color: WorkspaceColor;
  profile: string;
}

export function workspaceDirty(ws: Workspace, f: WorkspaceForm): boolean {
  return f.name.trim() !== ws.name || f.color !== ws.color || f.profile !== (ws.claude_profile ?? "");
}
