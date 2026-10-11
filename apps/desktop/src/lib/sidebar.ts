// How a section's sessions are grouped, filtered and sorted in the sidebar
// (X5, X32). Pure, so it is unit-tested.

import type { AgentState, Project, Section, Session, Workspace } from "./protocol";

export interface Group {
  key: string;
  kind: "project" | "status" | "all";
  label: string;
  projectId?: string;
  sessions: Session[];
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

/**
 * The project row's "Remove from <section>" item. `section.remove_project`
 * drops a project no other section holds, so that case asks first.
 */
export function projectRemoval(sections: Section[], secId: string, project: Project): { label: string; confirm: string | null } {
  const sec = sections.find((w) => w.id === secId);
  const elsewhere = sections.some((w) => w.id !== secId && w.project_ids.includes(project.id));
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
