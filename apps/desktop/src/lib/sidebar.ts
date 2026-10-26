// How a section's sessions are grouped, filtered and sorted in the sidebar
// (X5, X32). Pure, so it is unit-tested.

import type { AgentState, Project, ProjectIdentity, Section, Session, Workspace } from "./protocol";
import { agentCount } from "./subagents";

export interface Group {
  key: string;
  kind: "project" | "status" | "task" | "all";
  label: string;
  projectId?: string;
  sessions: Session[];
}

/** How a group is headed: a project row (mark, settings, new session), a
 * plain label (status, task), or nothing for the ungrouped list. */
export function groupHeading(g: Pick<Group, "kind">): "project" | "label" | null {
  return g.kind === "project" ? "project" : g.kind === "all" ? null : "label";
}

const STATUS_ORDER: { state: AgentState | null; label: string }[] = [
  { state: "blocked", label: "Needs input" },
  { state: "working", label: "Working" },
  { state: "done", label: "Ready for review" },
  { state: "error", label: "Failed" },
  { state: "idle", label: "Idle" },
  { state: null, label: "No agent" },
];

/** The groups of section `sec`, showing only the sessions of `workspaceId`,
 * the workspace the section is in. */
export function arrange(
  workspaceId: string,
  sec: Section,
  projects: Project[],
  sessions: Session[],
  stateOf: (s: Session) => AgentState | null,
  activeAt: (s: Session) => number,
  /** Archived sessions whose row still plays the archive loader (X21). */
  archiving: (s: Session) => boolean = () => false,
  /** The task a session works on, for grouping by task (X46). */
  taskOf: (s: Session) => { key: string; title: string } | null = () => null,
): Group[] {
  const filter = sec.view.filter.filter((id) => sec.project_ids.includes(id));
  const visible = sec.project_ids.filter((id) => filter.length === 0 || filter.includes(id));
  const byId = new Map(projects.map((p) => [p.id, p]));
  const rest = sessions
    .filter((s) => (!s.archived || archiving(s)) && s.workspace_id === workspaceId && visible.includes(s.project_id))
    .sort((a, b) => {
      if (sec.view.sort_by === "name") return a.name.localeCompare(b.name);
      if (sec.view.sort_by === "created") return b.created_at - a.created_at;
      return activeAt(b) - activeAt(a) || b.created_at - a.created_at;
    });

  const groups: Group[] = [];
  if (sec.view.group_by === "project") {
    for (const id of visible) {
      const p = byId.get(id);
      if (!p) continue;
      groups.push({ key: `proj:${id}`, kind: "project", label: p.name, projectId: id, sessions: rest.filter((s) => s.project_id === id) });
    }
  } else if (sec.view.group_by === "task") {
    const byTask = new Map<string, Group>();
    const none: Session[] = [];
    for (const s of rest) {
      const t = taskOf(s);
      if (!t) none.push(s);
      else if (byTask.has(t.key)) byTask.get(t.key)!.sessions.push(s);
      else byTask.set(t.key, { key: `task:${t.key}`, kind: "task", label: `${t.key} ${t.title}`, sessions: [s] });
    }
    groups.push(...byTask.values());
    if (none.length) groups.push({ key: "task:none", kind: "task", label: "No task", sessions: none });
  } else if (sec.view.group_by === "status") {
    for (const { state, label } of STATUS_ORDER) {
      const list = rest.filter((s) => stateOf(s) === state);
      if (list.length) groups.push({ key: `status:${state}`, kind: "status", label, sessions: list });
    }
  } else {
    groups.push({ key: "all", kind: "all", label: "All sessions", sessions: rest });
  }
  return groups;
}

/** One member's side of a section shared by the members of an account (X68). */
export interface SectionPart {
  host: string;
  sec: Section;
  projects: Project[];
  sessions: Session[];
}

/** A group of a shared section: each session with the host it is on. */
export interface SharedGroup {
  key: string;
  kind: Group["kind"];
  label: string;
  /** The host of the project row (its mark, settings, new session). */
  host: string;
  projectId?: string;
  /** Where the project is when it is not on the first member: another
   * member's name, or "missing" when no connected member has it. */
  on: string | null;
  sessions: { host: string; session: Session }[];
}

const identityKey = (i: ProjectIdentity | undefined) => (i?.root ? `${i.origin ?? ""}|${i.root}` : null);

/** A project's name from its identity: the last part of its origin. */
const identityName = (i: ProjectIdentity) => i.origin?.split("/").pop() ?? i.root?.slice(0, 7) ?? "project";

/**
 * A section shared by the members of an account, as one list (X68): each
 * part is `arrange`d on its own, then a project's groups meet by identity
 * and other groups by key, with every member's sessions sorted together.
 * The first part, the shown member's, decides the order and the view.
 */
export function arrangeShared(
  workspaceId: string,
  parts: SectionPart[],
  o: {
    stateOf: (host: string, s: Session) => AgentState | null;
    activeAt: (host: string, s: Session) => number;
    archiving: (host: string, s: Session) => boolean;
    taskOf: (host: string, s: Session) => { key: string; title: string } | null;
  },
): SharedGroup[] {
  if (!parts.length) return [];
  const view = parts[0].sec.view;
  const out: SharedGroup[] = [];
  const byKey = new Map<string, SharedGroup>();
  parts.forEach((part, i) => {
    const groups = arrange(
      workspaceId,
      { ...part.sec, view: { ...view, filter: part.sec.view.filter } },
      part.projects,
      part.sessions,
      (s) => o.stateOf(part.host, s),
      (s) => o.activeAt(part.host, s),
      (s) => o.archiving(part.host, s),
      (s) => o.taskOf(part.host, s),
    );
    for (const g of groups) {
      const project = g.projectId ? part.projects.find((p) => p.id === g.projectId) : undefined;
      const key = g.kind === "project" ? (identityKey(project?.identity) ?? `${part.host}/${g.key}`) : g.key;
      let shared = byKey.get(key);
      if (!shared) {
        // The shown member's project groups keep their key, and with it
        // their collapse state.
        shared = { key: g.kind === "project" && i > 0 ? `proj:${key}` : g.key, kind: g.kind, label: g.label, host: part.host, projectId: g.projectId, on: i > 0 && g.kind === "project" ? part.host : null, sessions: [] };
        byKey.set(key, shared);
        out.push(shared);
      }
      shared.sessions.push(...g.sessions.map((session) => ({ host: part.host, session })));
    }
  });
  // The first member's projects that no connected member has, as rows of
  // their own while grouped by project.
  for (const i of view.group_by === "project" ? (parts[0].sec.missing ?? []) : []) {
    const key = identityKey(i);
    if (!key || byKey.has(key)) continue;
    const g: SharedGroup = { key: `proj:${key}`, kind: "project", label: identityName(i), host: parts[0].host, on: "missing", sessions: [] };
    byKey.set(key, g);
    out.push(g);
  }
  const rank = (e: { host: string; session: Session }) =>
    view.sort_by === "name" ? 0 : view.sort_by === "created" ? e.session.created_at : o.activeAt(e.host, e.session) || e.session.created_at;
  for (const g of out) {
    g.sessions.sort((a, b) => (view.sort_by === "name" ? a.session.name.localeCompare(b.session.name) : rank(b) - rank(a) || b.session.created_at - a.session.created_at));
  }
  if (view.group_by === "status") {
    const order = STATUS_ORDER.map((x) => x.label);
    out.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
  } else if (view.group_by === "task") {
    // Tasks by their newest session, sessions without one last.
    const newest = (g: SharedGroup) => (g.key === "task:none" ? -Infinity : Math.max(...g.sessions.map(rank)));
    out.sort((a, b) => newest(b) - newest(a));
  }
  return out;
}

/**
 * The sections the sidebar shows for workspace `shown`, each once, with the
 * hosts holding it (X68): the shown host's first, in its order, then those
 * only other members list yet.
 */
export function shownSections(
  shown: { host: string; id: string } | null,
  hosts: { host: string; workspaces: Workspace[]; sections: Section[] }[],
): { ws: Workspace; sec: Section; hosts: string[] }[] {
  if (!shown) return [];
  const listing = hosts.filter((h) => h.workspaces.some((w) => w.id === shown.id));
  listing.sort((a, b) => Number(b.host === shown.host) - Number(a.host === shown.host));
  const out: { ws: Workspace; sec: Section; hosts: string[] }[] = [];
  for (const h of listing) {
    const ws = h.workspaces.find((w) => w.id === shown.id)!;
    for (const sec of workspaceSections(ws, h.sections)) {
      const seen = out.find((x) => x.sec.id === sec.id);
      if (seen) seen.hosts.push(h.host);
      else out.push({ ws, sec, hosts: [h.host] });
    }
  }
  return out;
}

/** A workspace's sections in its order (X32). */
export function workspaceSections(ws: Workspace, sections: Section[]): Section[] {
  const byId = new Map(sections.map((s) => [s.id, s]));
  return ws.section_ids.flatMap((id) => byId.get(id) ?? []);
}

/** A host's sections in sidebar order, each with its workspace and the label
 * pickers show ("Workspace › Section" once there are several workspaces). */
export function hostSections(workspaces: Workspace[], sections: Section[]): { ws: Workspace; sec: Section; label: string }[] {
  return workspaces.flatMap((ws) => workspaceSections(ws, sections).map((sec) => ({ ws, sec, label: workspaces.length > 1 ? `${ws.name} › ${sec.name}` : sec.name })));
}

/** Whether a section of `ws` holds `projectId`: its sessions may live there. */
export function holdsProject(ws: Workspace, sections: Section[], projectId: string): boolean {
  return workspaceSections(ws, sections).some((s) => s.project_ids.includes(projectId));
}

/** `5512` → `5.5k`, as in Conductor's sidebar. */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}

/** The chip at the end of a session row, most urgent first; running
 *  subagents (X42) come after needs input. */
export function sessionBadge(o: {
  creating: boolean;
  state: AgentState | null;
  merged: boolean;
  git?: { additions: number; deletions: number };
  agents: number;
}): { text: string; tone: "muted" | "blocked" | "agents" | "merged" | "diff" } | null {
  if (o.creating) return { text: "creating", tone: "muted" };
  if (o.state === "blocked") return { text: "needs input", tone: "blocked" };
  if (o.agents) return { text: agentCount(o.agents), tone: "agents" };
  if (o.merged) return { text: "merged", tone: "merged" };
  if (o.git && (o.git.additions || o.git.deletions)) {
    return { text: `+${compact(o.git.additions)}${o.git.deletions ? ` -${compact(o.git.deletions)}` : ""}`, tone: "diff" };
  }
  return null;
}

/**
 * The project row's "Remove from <section>" item. `section.remove_project`
 * drops a project no other section holds, so that case asks first.
 */
export function projectRemoval(sections: Section[], secId: string, project: Project): { label: string; confirm: string | null } {
  const sec = sections.find((s) => s.id === secId);
  const elsewhere = sections.some((s) => s.id !== secId && s.project_ids.includes(project.id));
  return {
    label: `Remove from ${sec?.name ?? "section"}`,
    confirm: elsewhere ? null : `${project.name} is in no other section, so it will be removed from moonlet. The folder on disk is not touched.`,
  };
}

/** Latest output of a session's terminals (its "recent" sort key). */
export function lastActive(terminals: Record<number, { session_id?: string; last_output_at: number }>, s: Session): number {
  return Object.values(terminals)
    .filter((t) => t.session_id === s.id)
    .reduce((m, t) => Math.max(m, t.last_output_at), s.created_at);
}

/**
 * A session row's right-click menu. Link to task… is there for a session
 * without a task in a workspace with a task source (X46).
 */
export function sessionMenu(s: { linked: boolean; sources: boolean; sync?: boolean }): ("open" | "link-task" | "keep-sync" | "archive")[] {
  return ["open", ...(!s.linked && s.sources ? (["link-task"] as const) : []), ...(s.sync ? (["keep-sync"] as const) : []), "archive"];
}
