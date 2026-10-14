// How a section's sessions are grouped, filtered and sorted in the sidebar
// (X5, X32). Pure, so it is unit-tested.

import type { AgentState, Project, Section, Session, Workspace } from "./protocol";
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
export function groupHeading(g: Group): "project" | "label" | null {
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
