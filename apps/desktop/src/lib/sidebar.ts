// How a workspace's sessions are grouped, filtered and sorted in the
// sidebar (X5). Pure, so it is unit-tested.

import type { AgentState, Project, Session, Workspace } from "./protocol";

export interface Group {
  key: string;
  kind: "section" | "project" | "status" | "all";
  label: string;
  projectId?: string;
  sectionId?: string;
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

export function arrange(
  ws: Workspace,
  projects: Project[],
  sessions: Session[],
  stateOf: (s: Session) => AgentState | null,
  activeAt: (s: Session) => number,
): Group[] {
  const filter = ws.view.filter.filter((id) => ws.project_ids.includes(id));
  const visible = ws.project_ids.filter((id) => filter.length === 0 || filter.includes(id));
  const byId = new Map(projects.map((p) => [p.id, p]));
  const sorted = sessions
    .filter((s) => !s.archived && visible.includes(s.project_id))
    .sort((a, b) => {
      if (ws.view.sort_by === "name") return a.name.localeCompare(b.name);
      if (ws.view.sort_by === "created") return b.created_at - a.created_at;
      return activeAt(b) - activeAt(a) || b.created_at - a.created_at;
    });

  const groups: Group[] = [];
  const sectionIds = new Set(ws.sections.map((s) => s.id));
  for (const sec of ws.sections) {
    groups.push({ key: `sec:${sec.id}`, kind: "section", label: sec.name, sectionId: sec.id, sessions: sorted.filter((s) => s.section === sec.id) });
  }
  const rest = sorted.filter((s) => !s.section || !sectionIds.has(s.section));

  if (ws.view.group_by === "project") {
    for (const id of visible) {
      const p = byId.get(id);
      if (!p) continue;
      groups.push({ key: `proj:${id}`, kind: "project", label: p.name, projectId: id, sessions: rest.filter((s) => s.project_id === id) });
    }
  } else if (ws.view.group_by === "status") {
    for (const { state, label } of STATUS_ORDER) {
      const list = rest.filter((s) => stateOf(s) === state);
      if (list.length) groups.push({ key: `status:${state}`, kind: "status", label, sessions: list });
    }
  } else {
    groups.push({ key: "all", kind: "all", label: "All sessions", sessions: rest });
  }
  return groups;
}

/** `5512` → `5.5k`, as in Conductor's sidebar. */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}
