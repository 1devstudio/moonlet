// Sessions (X40): the current workspace's sessions on every connected host,
// in sections grouped as each section's view says, as the desktop sidebar
// draws them (X32, X118), each shared section and project once across an
// account's members (X68).

import { dropRelisted, ownerLine, sessionHost } from "./copies";
import { planOf } from "@desktop/lib/chat";
import { arrangeShared, type Group, groupCollapseKey, groupHeading, lastActive, nestedIn, sectionCollapseKey, sectionParts, sessionBadge, sessionGlyph, shownSections } from "@desktop/lib/sidebar";
import { identityAvatar } from "@desktop/lib/projectAvatar";
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
import { sessionBoards } from "./board";

export interface SessionRow {
  /** `host/session`: rows come from several hosts, whose ids may meet. */
  key: string;
  host: string;
  session: Session;
  state: AgentState;
  /** The waiting plan's chat and ask, if any. */
  plan: { terminal: number; ask: string } | null;
  /** The host's name when the session is on another member than its
   * group's project (X68), else null. */
  on: string | null;
  /** Drawn indented under the session above it (X112). */
  nested: boolean;
  /** Its setup still runs (X40's `creating`). */
  creating: boolean;
  /** How many subagents its chats run (X42). */
  subagents: number;
  /** Its project's name, which search looks in. */
  project: string;
  /** Its task's line for the row styles (X48), from the Mac's boards. */
  task: TaskLine | null;
  /** A board of its workspace is shared with the phone: rows show task columns, and Link to task… is offered. */
  sources: boolean;
}

export type TaskLine = { key: string; title: string; column: Category; outOfSync: boolean };

/** One group of a section as the desktop sidebar draws it (X118): a
 * project's, a status's or a task's, or the whole ungrouped section. */
export interface ProjectGroup {
  key: string;
  /** The section the group is in, the same on every member holding it. */
  sectionKey: string;
  kind: Group["kind"];
  /** A project row, a plain label, or nothing (`groupHeading`). */
  heading: "project" | "label" | null;
  /** The project's name, the status's or the task's. */
  label: string;
  host: string;
  /** The group's project, for a project group. */
  project: Project | null;
  /** The phone's key for folding it, the desktop's (`groupCollapseKey`). */
  foldKey: string;
  /** The member the project comes from when not the section's first (X68). */
  on: string | null;
  /** The project's GitHub owner avatar, else null for the dotted mark (X15). */
  avatar: string | null;
  rows: SessionRow[];
}

/** A section of the shown workspace with its groups (X118). */
export interface SessionSection {
  key: string;
  name: string;
  /** The member the section's settings go to: the first holding it. */
  host: string;
  /** The phone's key for folding it, the desktop's (`sectionCollapseKey`). */
  foldKey: string;
  /** The one member holding it, while the phone has several Macs (X68). */
  where: string | null;
  sec: Section;
  groups: ProjectGroup[];
}

type TaskOf = (host: string, s: Session) => { task: TaskLine | null; sources: boolean };

function waitingPlan(d: HostData, s: Session): SessionRow["plan"] {
  for (const t of Object.values(d.terminals)) {
    if (t.session_id !== s.id) continue;
    const ask = d.chats[t.id]?.pending.find((a) => planOf(a));
    if (ask) return { terminal: t.id, ask: ask.id };
  }
  return null;
}

function row(host: string, d: HostData, s: Session, on: string | null, nested: boolean, task: TaskOf): SessionRow {
  const state = sessionState(d, s);
  const plan = state === "blocked" ? waitingPlan(d, s) : null;
  const running = Object.values(d.terminals).reduce((n, t) => n + (t.session_id === s.id ? (t.subagents ?? 0) : 0), 0);
  const creating = Object.values(d.terminals).some((t) => t.session_id === s.id && t.kind === "setup" && !t.exit);
  return { host, session: s, state, plan, on, nested, creating, subagents: running, project: d.projects.find((p) => p.id === s.project_id)?.name ?? "", key: `${host}/${s.id}`, ...task(host, s) };
}

/** The shown workspace's sections, or every workspace's for null, each
 * shared section once, grouped as its view says (X32, X118), each project
 * once by identity with every member's sessions (X68). */
export function sessionSections(hosts: Record<string, InboxHost>, data: Record<string, HostData>, shown: WorkspaceRef | null): SessionSection[] {
  const live = Object.fromEntries(Object.values(hosts).flatMap((h) => (h.status === "connected" && data[h.id] ? [[h.id, h]] : [])));
  const list = hostWorkspaces(live, data);
  const of = {
    sections: Object.fromEntries(list.map((h) => [h.host, h.sections])),
    projects: Object.fromEntries(list.map((h) => [h.host, data[h.host].projects])),
    // A session the phone gets from its member and from the central host
    // shows once (X72).
    sessions: dropRelisted(Object.fromEntries(list.map((h) => [h.host, h.sessions]))),
  };
  // Each session's task from its host's boards and those its account shares (X48, X76), once.
  const tasks = new Map<string, { task: TaskLine | null; sources: boolean }>();
  const taskOf: TaskOf = (h, s) => {
    const k = `${h}/${s.id}`;
    let t = tasks.get(k);
    if (!t) {
      const boards = data[h] ? sessionBoards(hosts, data, h, s) : [];
      t = { task: data[h] ? taskLine(data[h], s, boards.map((b) => b.snapshot)) : null, sources: boards.length > 0 };
      tasks.set(k, t);
    }
    return t;
  };
  const out: SessionSection[] = [];
  for (const ref of shown ? [shown] : workspaceChoices(list).map((c) => c.ref)) {
    for (const { ws, sec, hosts: holding } of shownSections(ref, list)) {
      const sectionKey = `${ref.account ?? ref.host}:${ws.id}:${sec.id}`;
      const shared = arrangeShared(ws.id, sectionParts(holding, sec, of), {
        stateOf: (h, s) => sessionState(data[h], s),
        activeAt: (h, s) => lastActive(Object.values(data[h].terminals).filter((t) => t.session_id === s.id), s),
        archiving: () => false,
        taskOf: (h, s) => taskOf(h, s).task,
      });
      const groups: ProjectGroup[] = [];
      for (const g of shared) {
        // A project no connected member has (X70) is the Mac's to get.
        if (g.on && "missing" in g.on) continue;
        const project = g.kind === "project" ? (data[g.host].projects.find((p) => p.id === g.projectId) ?? null) : null;
        if (g.kind === "project" && !project) continue;
        if (g.kind !== "project" && !g.sessions.length) continue;
        const nested = nestedIn(g.sessions, (e) => e.session);
        groups.push({
          key: `${sectionKey}:${g.key}`,
          sectionKey,
          kind: g.kind,
          heading: groupHeading(g),
          label: g.label,
          host: g.host,
          project,
          foldKey: groupCollapseKey(holding[0], sec.id, g.key),
          on: g.on && "host" in g.on ? hosts[g.on.host].label : null,
          avatar: identityAvatar(project?.identity?.origin ?? null),
          rows: g.sessions.map((e) => row(e.host, data[e.host], e.session, ownerLine(e.session) ?? (e.host === g.host ? null : hosts[e.host].label), nested(e.session), taskOf)),
        });
      }
      out.push({ key: sectionKey, name: sec.name, host: holding[0], foldKey: sectionCollapseKey(holding[0], sec.id), where: list.length > 1 && holding.length === 1 ? hosts[holding[0]].label : null, sec, groups });
    }
  }
  return out;
}

/** The groups of `sessionSections`, one after another. */
export function sessionGroups(hosts: Record<string, InboxHost>, data: Record<string, HostData>, shown: WorkspaceRef | null): ProjectGroup[] {
  return sessionSections(hosts, data, shown).flatMap((s) => s.groups);
}

/** A row's leading glyph, as the desktop's (`sessionGlyph`): the agent's
 * state, or the branch at rest, tinted by its PR. */
export function rowGlyph(r: SessionRow, prState: string | undefined): ReturnType<typeof sessionGlyph> {
  return sessionGlyph(r.state, prState?.toLowerCase());
}

/** The row starts with the desktop's pin: the session is pinned to the top (X112, X119). */
export function rowPinned(r: SessionRow): boolean {
  return !!r.session.pinned_top;
}

/** A row's badge, as the desktop's (`sessionBadge`): `creating`, `needs
 * input`, its subagents, or the diff stat once loaded. */
export function rowBadge(r: SessionRow, git: { additions: number; deletions: number } | undefined, prState: string | undefined): ReturnType<typeof sessionBadge> {
  return sessionBadge({ creating: r.creating, state: r.state, merged: prState?.toLowerCase() === "merged", git, agents: r.subagents });
}

/** The phone's folds after a tap on what `key` folds: folded, or open again (X118). */
export function foldsAfterTap(folds: Record<string, true>, key: string): Record<string, true> {
  if (!folds[key]) return { ...folds, [key]: true };
  const { [key]: _, ...rest } = folds;
  return rest;
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

/** The groups with only the rows of `chip` that match `query`; groups left
 * empty go, but a project without sessions stays under All with nothing
 * searched, as the desktop sidebar shows it (X118). */
export function filterGroups(groups: ProjectGroup[], chip: ChipId, query: string): ProjectGroup[] {
  const q = query.trim().toLowerCase();
  const states = CHIP_STATES[chip];
  return groups
    .map((g) => ({
      ...g,
      rows: g.rows.filter(
        (r) =>
          (!states || states.includes(r.state)) &&
          (!q || [r.session.name, r.session.branch, r.project].some((x) => x.toLowerCase().includes(q))),
      ),
    }))
    .filter((g) => g.rows.length || (chip === "all" && !q));
}

/** Where a tap on a row goes: a waiting plan's sheet, else the session's Chat, whatever the agent's state. */
export function rowTarget(r: SessionRow): Screen {
  if (r.plan) return { kind: "plan", host: r.host, terminal: r.plan.terminal, ask: r.plan.ask };
  // Another member's session goes through the central host (X72).
  return { kind: "session", host: sessionHost(r.host, r.session), id: r.session.id, tab: "chat" };
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
  const found = boardTask(d, s, pr, shared);
  if (!found) {
    const chip = taskChip(s);
    return chip && { key: chip.label, state: null, category: null, project: null, url: chip.url };
  }
  const { task, column } = found;
  const { prefix, number } = splitKey(task.key);
  return { key: prefix.endsWith("#") ? `#${number}` : task.key, state: column?.name ?? null, category: column?.category ?? null, project: d.projects.find((p) => p.id === s.project_id)?.name ?? null, url: task.url };
}

/** The task of `s` among the boards' tasks, and its column there. */
function boardTask(d: HostData, s: Session, pr: PullRequest | null | undefined, shared: TaskSnapshot[]): { task: Task; column: ReturnType<typeof syncedColumns>[number] | undefined } | null {
  // Its host's boards first, then those another member of its account shares (X68).
  // The session's repository from its own host: another member's snapshot keys repositories by that member's project ids.
  const project = d.projects.find((p) => p.id === s.project_id);
  const ownRepo = (s.workspace_id ? d.tasks[s.workspace_id]?.repos[s.project_id] : null) ?? githubRepo(project?.identity?.origin ?? null);
  for (const snap of snapshotsOf(d, s, shared)) {
    const task = taskForSession(s, pr, ownRepo ?? snap.repos[s.project_id] ?? null, snap.tasks, snap.link);
    if (!task) continue;
    const id = taskId(task);
    const board = snap.boards.find((b) => snap.boardData[b.id]?.keys.includes(id));
    return { task, column: board ? syncedColumns(board, null).find((c) => holds(c, task)) : undefined };
  }
  return null;
}

/** The line a session row's style shows for its task (X48, X118): its
 * whole key, title and state, from the boards the Mac shares only, as the
 * desktop's come from its board. The phone does not know when a task is
 * out of sync. */
export function taskLine(d: HostData, s: Session, shared: TaskSnapshot[] = []): TaskLine | null {
  const found = boardTask(d, s, undefined, shared);
  if (!found) return null;
  const own = found.task.column;
  const column: Category = found.column?.category ?? (own === "in_progress" || own === "in_review" || own === "done" ? own : "todo");
  return { key: found.task.key, title: found.task.title, column, outOfSync: false };
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
