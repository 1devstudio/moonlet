// A task on the phone (X57): its detail, as the desktop's detail shows it,
// and the moves the phone asked for until the Mac's snapshot has them.

import { agentLabel } from "@desktop/lib/agents";
import { holds } from "@desktop/lib/boardColumns";
import { stateChoices } from "@desktop/lib/boardScreen";
import { type BoardConfig, syncedColumns } from "@desktop/lib/boards";
import { canSubmit, jiraProjects, type NewIssue, needsPlace, needsType, projectRepos, withAccess } from "@desktop/lib/newIssue";
import type { TaskSnapshot } from "@desktop/lib/taskSnapshot";
import { withoutComments } from "@desktop/lib/markdown";
import type { AgentState } from "@desktop/lib/protocol";
import { clock } from "@desktop/lib/subagents";
import { type Task, type TaskStart, taskId, taskStart, trackerName, trackerOf } from "@desktop/lib/tasks";
import { startAction } from "@desktop/lib/keepInStep";
import type { HostData } from "./app";
import { type Details, type Moving, type PhoneBoard, boardScreen } from "./board";

const PRIORITY = ["", "Low", "Medium", "High"];

export interface DetailSession {
  id: string;
  name: string;
  state: AgentState | null;
  agent: string;
  /** `Claude · working 2:14 · 5 subagents`. */
  word: string;
  branch: string;
  add: number;
  del: number;
  /** Set while the session waits for an answer. */
  waiting: string | null;
}

/** `idle for 1h`: how long since `since`. */
function idleFor(ms: number): string {
  const m = Math.max(1, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / (24 * 60))}d`;
}

/** The task with id `id` on board `b`, for its detail; null once the board has it no more. */
export function taskDetail(b: PhoneBoard, id: string, d: HostData, details: Details, moving: Moving, now: number) {
  const screen = boardScreen(b, d, details, moving, now);
  const card = screen.columns.flatMap((c) => c.cards).find((c) => c.id === id);
  const task = card?.task ?? b.snapshot.tasks.find((t) => taskId(t) === id);
  if (!task) return null;
  const column = screen.columns.find((c) => c.cards.some((x) => x.id === id));
  const { choices, current } = stateChoices(syncedColumns(b.board, null), task);
  const sprint = b.board.finished === "sprint" ? b.snapshot.boardData[b.board.id]?.sprint?.name : undefined;
  const sessions: DetailSession[] = (card?.card.rows ?? []).map(({ session: s }) => {
    const terminals = Object.values(d.terminals).filter((t) => t.session_id === s.id);
    const agent = d.sessions.find((x) => x.id === s.id)?.agent ?? terminals.find((t) => t.agent)?.agent ?? "claude";
    const asks = terminals.flatMap((t) => d.chats[t.id]?.pending ?? []);
    const started = terminals.map((t) => d.chats[t.id]?.turn_started_at).find((x): x is number => typeof x === "number");
    const last = Math.max(0, ...terminals.map((t) => t.last_output_at ?? 0));
    const state =
      s.state === "blocked" ? "needs you" : s.state === "working" ? (started ? `working ${clock(now - started)}` : "working") : s.state === "done" ? "done" : s.state === "error" ? "failed" : `idle for ${idleFor(now - last)}`;
    return {
      id: s.id,
      name: s.name,
      state: s.state,
      agent,
      word: [agentLabel(agent), state, s.subagents ? `${s.subagents} subagents` : ""].filter(Boolean).join(" · "),
      branch: s.branch,
      add: s.additions,
      del: s.deletions ?? 0,
      waiting: s.state !== "blocked" ? null : asks.some((a) => a.agent) ? "A subagent is waiting for your approval" : "Waiting for your approval",
    };
  });
  return {
    id,
    task,
    key: task.key,
    url: task.url,
    title: task.title,
    mark: trackerName(task.connection).charAt(0).toUpperCase(),
    meta: [PRIORITY[task.priority] ?? "", sprint ?? ""].filter(Boolean).join(" · "),
    state: column?.name ?? choices[current]?.label ?? null,
    choices: choices.map((c, i) => ({ label: c.label, status: c.status, current: i === current })),
    description: withoutComments(task.description).trim(),
    sessions,
    worktrees: (card?.card.orphans ?? []).map((w) => ({ path: w.path, branch: w.branch ?? "" })),
    activity: (b.snapshot.activity[id] ?? []).map((e) => ({ when: activityTime(e.at, now), text: e.text })),
    drift: card?.drift ?? null,
  };
}

/** An activity line's time: `4:12 PM` today, `Yesterday`, else `Oct 12`. */
export function activityTime(at: number, now: number): string {
  const day = (t: number) => new Date(t).toDateString();
  if (day(at) === day(now)) return new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (day(at) === day(now - 24 * 3_600_000)) return "Yesterday";
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** How long a move may wait for the Mac's snapshot before it is shown no more. */
const MOVE_WAIT = 2 * 60_000;

/** `moving` less the moves the snapshot's tasks show done, and those older than two minutes. */
export function pruneMoves<M extends { status: string; at: number }>(moving: Record<string, M>, tasks: Task[], now: number): Record<string, M> {
  const byId = new Map(tasks.map((t) => [taskId(t), t]));
  return Object.fromEntries(
    Object.entries(moving).filter(([id, m]) => {
      const t = byId.get(id);
      const there = !!t && holds({ name: "", category: "todo", statuses: [m.status] }, t);
      return !there && now - m.at < MOVE_WAIT;
    }),
  );
}

/** The Mac's lists for the New issue form (X52's `createOptions`). */
export interface IssueOptions {
  me: string;
  people: { id: string; name: string }[];
  labels: { id: string; name: string }[];
  canSet: boolean;
  issueTypes?: { id: string; name: string }[];
  missing?: string[];
  fields?: string[];
}

/** The New issue form on `board` (X57, as the desktop's X52 form): where it may go, what it asks, and whether Create can be pressed. */
export function issueForm(board: BoardConfig, snapshot: Pick<TaskSnapshot, "tasks" | "repos" | "boardData">, draft: NewIssue, options: IssueOptions | null) {
  const keys = snapshot.boardData[board.id]?.keys ?? [];
  const places = !needsPlace(board) ? [] : board.origin.kind === "github_project" ? projectRepos(snapshot.repos, snapshot.tasks, keys) : jiraProjects(snapshot.tasks, keys);
  // A Jira board of one project puts it there without asking.
  const placed = needsPlace(board) && !draft.place && places.length === 1 && board.origin.kind !== "github_project" ? { ...draft, place: places[0] } : draft;
  const access = withAccess(placed, { canSet: options?.canSet ?? true, fields: options?.fields });
  return {
    places,
    askPlace: needsPlace(board) && (board.origin.kind === "github_project" || places.length !== 1),
    askType: needsType(board),
    assignee: access.assignee,
    labels: access.labels,
    draft: access.draft,
    // Not before the Mac's lists: a field Jira requires shows only in them.
    ready: options !== null && canSubmit(access.draft, { busy: false, needsPlace: needsPlace(board), needsType: needsType(board), missing: options.missing }),
  };
}

/** New session's preset for `task` (X57), as the Mac's composer makes it (X46's `composerTask`). */
export function taskPreset(b: PhoneBoard, task: Task): TaskStart {
  const trackers = b.snapshot.trackers as Record<string, TaskSnapshot["trackers"]["github"] | undefined>;
  const settings = trackers[trackerOf(task.connection) ?? "github"] ?? b.snapshot.trackers.github;
  return {
    ...taskStart(task, b.snapshot.repos, b.snapshot.sourceProjects),
    assign: startAction(task, settings.rules.session_starts),
    template: settings.branch_template || undefined,
    maxLen: settings.max_length,
  };
}
