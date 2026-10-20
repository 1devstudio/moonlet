// Sessions (X40): the current workspace's sessions on every connected host,
// grouped by section and project as the desktop sidebar does (X32).

import { planOf } from "@desktop/lib/chat";
import { lastActive, workspaceSections } from "@desktop/lib/sidebar";
import { agentCount } from "@desktop/lib/subagents";
import { splitKey } from "@desktop/lib/sessionRows";
import type { AgentState, Project, PullRequest, Session } from "@desktop/lib/protocol";
import { holds } from "@desktop/lib/boardColumns";
import { type Category, syncedColumns } from "@desktop/lib/boards";
import { taskForSession, taskId } from "@desktop/lib/tasks";
import type { HostData, Screen } from "./app";
import { type InboxHost, sessionState } from "./inbox";

export interface SessionRow {
  host: string;
  session: Session;
  state: AgentState;
  /** `needs you`, `plan`, `3m` while working, `done`, `failed`, or nothing. */
  word: string;
  /** The waiting plan's chat and ask, if any. */
  plan: { terminal: number; ask: string } | null;
  /** `2 agents` while the session's chats run subagents (X42), else empty. */
  agents: string;
}

export interface ProjectGroup {
  key: string;
  host: string;
  hostLabel: string;
  remote: boolean;
  /** The section's name. */
  section: string;
  project: Project;
  letter: string;
  rows: SessionRow[];
}

function waitingPlan(d: HostData, s: Session): SessionRow["plan"] {
  for (const t of Object.values(d.terminals)) {
    if (t.session_id !== s.id) continue;
    const ask = d.chats[t.id]?.pending.find((a) => planOf(a));
    if (ask) return { terminal: t.id, ask: ask.id };
  }
  return null;
}

function workingFor(d: HostData, s: Session, now: number): string {
  const started = Object.values(d.terminals)
    .filter((t) => t.session_id === s.id)
    .map((t) => d.chats[t.id]?.turn_started_at)
    .find((x): x is number => typeof x === "number");
  if (!started) return "working";
  const m = Math.max(1, Math.floor((now - started) / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}

function row(host: string, d: HostData, s: Session, now: number): SessionRow {
  const state = sessionState(d, s);
  const plan = state === "blocked" ? waitingPlan(d, s) : null;
  const word = plan ? "plan" : { blocked: "needs you", working: workingFor(d, s, now), done: "done", error: "failed", idle: "" }[state];
  const running = Object.values(d.terminals).reduce((n, t) => n + (t.session_id === s.id ? (t.subagents ?? 0) : 0), 0);
  return { host, session: s, state, word, plan, agents: running ? agentCount(running) : "" };
}

export function sessionGroups(hosts: Record<string, InboxHost>, data: Record<string, HostData>, workspace: string | null, now: number): ProjectGroup[] {
  const groups: ProjectGroup[] = [];
  for (const h of Object.values(hosts)) {
    const d = data[h.id];
    if (h.status !== "connected" || !d) continue;
    for (const ws of d.workspaces) {
      if (workspace !== null && ws.name !== workspace) continue;
      for (const sec of workspaceSections(ws, d.sections)) {
        for (const pid of sec.project_ids) {
          const project = d.projects.find((p) => p.id === pid);
          if (!project) continue;
          const sessions = d.sessions
            .filter((s) => !s.archived && s.workspace_id === ws.id && s.project_id === pid)
            .sort((a, b) => lastActive(d.terminals, b) - lastActive(d.terminals, a) || b.created_at - a.created_at);
          if (!sessions.length) continue;
          groups.push({
            key: `${h.id}:${ws.id}:${sec.id}:${pid}`,
            host: h.id,
            hostLabel: h.label,
            remote: !!h.via,
            section: sec.name,
            project,
            letter: project.name.charAt(0).toUpperCase(),
            rows: sessions.map((s) => row(h.id, d, s, now)),
          });
        }
      }
    }
  }
  return groups;
}

export type ChipId = "all" | "needs" | "working" | "review";

const CHIP_STATES: Record<ChipId, AgentState[] | null> = { all: null, needs: ["blocked"], working: ["working"], review: ["done"] };

export function chips(groups: ProjectGroup[]): { id: ChipId; label: string; count: number }[] {
  const rows = groups.flatMap((g) => g.rows);
  const n = (id: ChipId) => rows.filter((r) => CHIP_STATES[id]?.includes(r.state) ?? true).length;
  return [
    { id: "all", label: "All", count: n("all") },
    { id: "needs", label: "Needs you", count: n("needs") },
    { id: "working", label: "Working", count: n("working") },
    { id: "review", label: "Review", count: n("review") },
  ];
}

/** The groups with only the rows of `chip` that match `query`; empty groups go. */
export function filterGroups(groups: ProjectGroup[], chip: ChipId, query: string): ProjectGroup[] {
  const q = query.trim().toLowerCase();
  const states = CHIP_STATES[chip];
  return groups
    .map((g) => ({
      ...g,
      rows: g.rows.filter(
        (r) =>
          (!states || states.includes(r.state)) &&
          (!q || [r.session.name, r.session.branch, g.project.name].some((x) => x.toLowerCase().includes(q))),
      ),
    }))
    .filter((g) => g.rows.length);
}

/** Where a tap on a row goes. */
export function rowTarget(r: SessionRow): Screen {
  if (r.plan) return { kind: "plan", host: r.host, terminal: r.plan.terminal, ask: r.plan.ask };
  return { kind: "session", host: r.host, id: r.session.id, tab: r.state === "done" ? "changes" : "chat" };
}

/** A session's stored task link (X46): a tracker's key whole, a GitHub
 * issue (`owner/repo#12`) by its number. Links derived from a branch or a
 * PR need the tracker's issues, which the phone does not load. */
export function taskChip(s: Session): { label: string; url: string } | null {
  if (!s.task) return null;
  const { prefix, number } = splitKey(s.task.key);
  return { label: prefix.endsWith("#") ? `#${number}` : s.task.key, url: s.task.url };
}

/**
 * The task a session works on (X46, X57) and where it is: its stored link,
 * or the one its branch or PR names among the tasks the Mac shared, with
 * its column on the board and the project. Without the Mac's boards, the
 * stored link alone (`taskChip`).
 */
export function sessionTask(d: HostData, s: Session, pr: PullRequest | null | undefined): { key: string; state: string | null; category: Category | null; project: string | null; url: string } | null {
  const snap = s.workspace_id ? d.tasks[s.workspace_id] : undefined;
  const task = snap ? taskForSession(s, pr, snap.repos[s.project_id] ?? null, snap.tasks, snap.link) : null;
  if (!task) {
    const chip = taskChip(s);
    return chip && { key: chip.label, state: null, category: null, project: null, url: chip.url };
  }
  const id = taskId(task);
  const board = snap!.boards.find((b) => snap!.boardData[b.id]?.keys.includes(id));
  const column = board ? syncedColumns(board, null).find((c) => holds(c, task)) : undefined;
  return { key: task.key, state: column?.name ?? null, category: column?.category ?? null, project: d.projects.find((p) => p.id === s.project_id)?.name ?? null, url: task.url };
}
