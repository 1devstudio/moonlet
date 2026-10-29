// Sessions (X40): the current workspace's sessions on every connected host,
// grouped by section and project as the desktop sidebar does (X32), each
// shared section and project once across an account's members (X68).

import { planOf } from "@desktop/lib/chat";
import { arrangeShared, lastActive, sectionParts, shownSections } from "@desktop/lib/sidebar";
import { agentCount } from "@desktop/lib/subagents";
import { splitKey } from "@desktop/lib/sessionRows";
import type { AgentState, Project, PullRequest, Section, Session } from "@desktop/lib/protocol";
import type { WorkspaceRef } from "@desktop/lib/workspaces";
import { holds } from "@desktop/lib/boardColumns";
import { type Category, syncedColumns } from "@desktop/lib/boards";
import { githubRepo, type Task, taskForSession, taskId } from "@desktop/lib/tasks";
import { linkChoices } from "@desktop/lib/taskLinking";
import type { TaskSnapshot } from "@desktop/lib/taskSnapshot";
import type { HostData, Screen } from "./app";
import { type InboxHost, sessionState } from "./inbox";
import { hostWorkspaces, workspaceChoices } from "./workspaceChoices";

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
  /** The host's name when the session is on another member than its
   * group's project (X68), else null. */
  on: string | null;
}

export interface ProjectGroup {
  key: string;
  /** The section the group is in, the same on every member holding it. */
  sectionKey: string;
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

function row(host: string, d: HostData, s: Session, now: number, on: string | null = null): SessionRow {
  const state = sessionState(d, s);
  const plan = state === "blocked" ? waitingPlan(d, s) : null;
  const word = plan ? "plan" : { blocked: "needs you", working: workingFor(d, s, now), done: "done", error: "failed", idle: "" }[state];
  const running = Object.values(d.terminals).reduce((n, t) => n + (t.session_id === s.id ? (t.subagents ?? 0) : 0), 0);
  return { host, session: s, state, word, plan, agents: running ? agentCount(running) : "", on };
}

/** The phone groups every section by project, most recently active first,
 * whatever view the desktop gives it. */
const BY_PROJECT: Section["view"] = { group_by: "project", sort_by: "recent", filter: [] };

/** The shown workspace's groups, or every workspace's for null: each shared
 * section once, each project once by identity with every member's sessions. */
export function sessionGroups(hosts: Record<string, InboxHost>, data: Record<string, HostData>, shown: WorkspaceRef | null, now: number): ProjectGroup[] {
  const live = Object.fromEntries(Object.values(hosts).flatMap((h) => (h.status === "connected" && data[h.id] ? [[h.id, h]] : [])));
  const list = hostWorkspaces(live, data);
  const of = {
    sections: Object.fromEntries(list.map((h) => [h.host, h.sections])),
    projects: Object.fromEntries(list.map((h) => [h.host, data[h.host].projects])),
    sessions: Object.fromEntries(list.map((h) => [h.host, h.sessions])),
  };
  const groups: ProjectGroup[] = [];
  for (const ref of shown ? [shown] : workspaceChoices(list).map((c) => c.ref)) {
    for (const { ws, sec, hosts: holding } of shownSections(ref, list)) {
      const sectionKey = `${ref.account ?? ref.host}:${ws.id}:${sec.id}`;
      const shared = arrangeShared(ws.id, sectionParts(holding, { ...sec, view: BY_PROJECT }, of), {
        stateOf: () => null,
        activeAt: (h, s) => lastActive(data[h].terminals, s),
        archiving: () => false,
        taskOf: () => null,
      });
      for (const g of shared) {
        const project = data[g.host].projects.find((p) => p.id === g.projectId);
        if (!project || !g.sessions.length) continue;
        const h = hosts[g.host];
        groups.push({
          key: `${sectionKey}:${g.key}`,
          sectionKey,
          host: g.host,
          hostLabel: h.label,
          remote: !!h.via,
          section: sec.name,
          project,
          letter: project.name.charAt(0).toUpperCase(),
          rows: g.sessions.map((e) => row(e.host, data[e.host], e.session, now, e.host === g.host ? null : hosts[e.host].label)),
        });
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
 * The task a session works on (X46, X76) and where it is: its stored link,
 * or the one its branch or PR names among the tasks the Mac shared, with
 * its column on the board and the project. Without the Mac's boards, the
 * stored link alone (`taskChip`).
 */
export function sessionTask(d: HostData, s: Session, pr: PullRequest | null | undefined, shared: TaskSnapshot[] = []): { key: string; state: string | null; category: Category | null; project: string | null; url: string } | null {
  let snap: TaskSnapshot | undefined;
  let task: Task | null = null;
  // Its host's boards first, then those another member of its account shares (X68).
  // The session's repository from its own host: another member's snapshot keys repositories by that member's project ids.
  const project = d.projects.find((p) => p.id === s.project_id);
  const ownRepo = (s.workspace_id ? d.tasks[s.workspace_id]?.repos[s.project_id] : null) ?? githubRepo(project?.identity?.origin ?? null);
  for (const sn of snapshotsOf(d, s, shared)) {
    task = taskForSession(s, pr, ownRepo ?? sn.repos[s.project_id] ?? null, sn.tasks, sn.link);
    if (task) {
      snap = sn;
      break;
    }
  }
  if (!task) {
    const chip = taskChip(s);
    return chip && { key: chip.label, state: null, category: null, project: null, url: chip.url };
  }
  const id = taskId(task);
  const board = snap!.boards.find((b) => snap!.boardData[b.id]?.keys.includes(id));
  const column = board ? syncedColumns(board, null).find((c) => holds(c, task)) : undefined;
  const { prefix, number } = splitKey(task.key);
  return { key: prefix.endsWith("#") ? `#${number}` : task.key, state: column?.name ?? null, category: column?.category ?? null, project: d.projects.find((p) => p.id === s.project_id)?.name ?? null, url: task.url };
}

/**
 * The task a session without one may be about (X76): one of its workspace's
 * board tasks whose title is the session's name. Rows show its key with "?",
 * opening Link to a task; never once the user unlinked the session's task.
 */
export function suggestedTask(d: HostData, s: Session, shared: TaskSnapshot[] = []): { key: string; id: string } | null {
  if (s.task || s.task_unlinked) return null;
  const tasks = snapshotsOf(d, s, shared).flatMap((sn) => sn.tasks);
  const t = linkChoices({ name: s.name, branch: "" }, tasks, "").suggested[0]?.task;
  return t ? { key: t.key, id: taskId(t) } : null;
}

/** The snapshots a session's task may be in: its host's for its workspace, then `shared` ones. */
function snapshotsOf(d: HostData, s: Session, shared: TaskSnapshot[]): TaskSnapshot[] {
  const own = s.workspace_id ? d.tasks[s.workspace_id] : undefined;
  return [...(own ? [own] : []), ...shared.filter((x) => x !== own)];
}
