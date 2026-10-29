// A task on the phone (X76): its detail, as the desktop's detail shows it,
// and the moves the phone asked for until the Mac's snapshot has them.

import { agentLabel } from "@desktop/lib/agents";
import { holds } from "@desktop/lib/boardColumns";
import { boardTitle, stateChoices } from "@desktop/lib/boardScreen";
import { type BoardConfig, type Category, CATEGORY_LABEL, syncedColumns } from "@desktop/lib/boards";
import { canSubmit, jiraProjects, labelProblem, type NewIssue, needsPlace, needsType, projectRepos, withAccess } from "@desktop/lib/newIssue";
import type { TaskSnapshot } from "@desktop/lib/taskSnapshot";
import { withoutComments } from "@desktop/lib/markdown";
import type { AgentState } from "@desktop/lib/protocol";
import { clock } from "@desktop/lib/subagents";
import { type Task, type TaskStart, taskId, taskStart, trackerName, trackerOf } from "@desktop/lib/tasks";
import { startAction } from "@desktop/lib/keepInStep";
import type { HostData } from "./app";
import { type Details, type Moving, type PhoneBoard, boardScreen, since } from "./board";
import { checkCounts } from "@desktop/lib/tasksBoard";
import { initials } from "@desktop/lib/taskDetails";
import { acceptanceCriteria, linkChoices } from "@desktop/lib/taskLinking";
import type { PullRequest } from "@desktop/lib/protocol";

const PRIORITY = ["", "Low", "Medium", "High"];

export interface DetailSession {
  id: string;
  name: string;
  state: AgentState | null;
  agent: string | null;
  /** `Claude · working 2:14 · 5 subagents`. */
  word: string;
  branch: string;
  add: number;
  del: number;
  /** Set while the session waits for an answer. */
  waiting: string | null;
  /** `storefront/moonlet/add-search`. */
  where: string;
  /** What it asks: `Allow Bash?`. */
  ask: string | null;
  /** Its PR's line: `#147 open`, its checks, failing ones and review. */
  pr: { text: string; tone: "open" | "merged" | "muted"; checks: string | null; failing: string | null; review: string | null } | null;
}

const REVIEW: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", REVIEW_REQUIRED: "review required" };

const CRITERIA_HEADING = /^\s*(#{1,6}\s*)?acceptance criteria:?\s*$/i;

/** A description without what shows as its acceptance criteria: its checklist items, and an "Acceptance criteria" section's heading and bullets. */
function withoutChecklist(md: string): string {
  const out: string[] = [];
  let inSection = false;
  for (const l of md.split("\n")) {
    if (CRITERIA_HEADING.test(l)) {
      inSection = true;
      continue;
    }
    // The section ends at the next heading, as `acceptanceCriteria` reads it.
    if (inSection && /^\s*#{1,6}\s/.test(l)) inSection = false;
    if (inSection && /^\s*[-*]\s+/.test(l)) continue;
    if (/^\s*[-*]\s+\[[ xX]\]\s/.test(l)) continue;
    out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** A session's PR line in the task detail. */
function prLine(pr: PullRequest | null | undefined): DetailSession["pr"] {
  if (!pr) return null;
  const { failing, passed } = checkCounts(pr.checks);
  return {
    text: `#${pr.number} ${pr.draft ? "draft" : pr.state}`,
    tone: pr.state === "merged" ? "merged" : pr.state === "open" && !pr.draft ? "open" : "muted",
    checks: pr.checks.length ? `${passed}/${pr.checks.length} checks` : null,
    failing: failing ? `${failing} failing` : null,
    review: pr.review_decision ? (REVIEW[pr.review_decision] ?? null) : null,
  };
}

const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** Why a card is out of sync, in a sentence (X45's chip, said in full). */
function driftWhy(kind: string, text: string, state: string): string {
  const pr = /#(\d+)/.exec(text)?.[1];
  if (kind === "pr_open") return `PR #${pr} is open and not a draft, but the issue is still ${state}.`;
  if (kind === "merged") return `Every session's PR is merged, the last #${pr}, but the issue is still ${state}.`;
  if (kind === "started") return `A session works on it, but the issue is still ${state}.`;
  return `The issue is done, but ${text} ${/^1 \w+$/.test(text) ? "is" : "are"} left.`;
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
  const screen = boardScreen(b, d, details, moving);
  const card = screen.columns.flatMap((c) => c.cards).find((c) => c.id === id);
  const task = card?.task ?? b.snapshot.tasks.find((t) => taskId(t) === id);
  if (!task) return null;
  const column = screen.columns.find((c) => c.cards.some((x) => x.id === id));
  const { choices, current } = stateChoices(syncedColumns(b.board, null), task);
  const sprint = b.board.finished === "sprint" ? b.snapshot.boardData[b.board.id]?.sprint?.name : undefined;
  const sessions: DetailSession[] = (card?.card.rows ?? []).map(({ session: s }) => {
    const terminals = Object.values(d.terminals).filter((t) => t.session_id === s.id);
    const own = d.sessions.find((x) => x.id === s.id)?.agent;
    const agent = (own && own !== "none" ? own : null) ?? terminals.find((t) => t.agent)?.agent ?? null;
    const asks = terminals.flatMap((t) => d.chats[t.id]?.pending ?? []);
    const started = terminals.map((t) => d.chats[t.id]?.turn_started_at).find((x): x is number => typeof x === "number");
    // Zero when it has said nothing yet: then plain "idle".
    const last = Math.max(0, ...terminals.map((t) => t.last_output_at ?? 0));
    const state =
      s.state === "blocked" ? "needs you" : s.state === "working" ? (started ? `working ${clock(now - started)}` : "working") : s.state === "done" ? "done" : s.state === "error" ? "failed" : (last ? `idle for ${idleFor(now - last)}` : "idle");
    const ask = asks[0];
    return {
      id: s.id,
      name: s.name,
      state: s.state,
      where: `${s.project ?? ""}/${s.branch}`,
      ask: ask ? `Allow ${ask.tool}?` : null,
      pr: prLine(s.pr),
      agent,
      word: [agent ? agentLabel(agent) : "No agent", state, s.subagents ? `${s.subagents} subagents` : ""].filter(Boolean).join(" · "),
      branch: s.branch,
      add: s.additions,
      del: s.deletions ?? 0,
      waiting: s.state !== "blocked" ? null : asks.some((a) => a.agent) ? "A subagent is waiting for your approval" : "Waiting for your approval",
    };
  });
  const data = b.snapshot.boardData[b.board.id];
  const dates = data?.sprint && data.sprint.startMs ? ` · ${day(data.sprint.startMs)} – ${day(data.sprint.endMs)}` : "";
  const criteria = acceptanceCriteria(withoutComments(task.description));
  const activity = b.snapshot.activity[id] ?? [];
  const drift = card?.drift ?? null;
  const stateName = column?.name ?? choices[current]?.label ?? "";
  return {
    id,
    task,
    key: task.key,
    kind: [task.issueType, task.points !== undefined ? `${task.points} pt` : ""].filter(Boolean).join(" · ") || null,
    priority: PRIORITY[task.priority] || null,
    assignee: task.assignees[0] ? { initials: initials(task.assignees[0]), name: task.assignees[0] } : null,
    sprint: data?.sprint ? `${data.sprint.name}${dates}` : null,
    labels: task.labels,
    outOfSync: drift && card?.card.drift ? { why: driftWhy(drift.kind, card.card.drift.text, stateName), fix: drift.fix, to: drift.to, key: card.driftKey ?? "" } : null,
    card: card ?? null,
    criteria: criteria.length ? { heading: `Acceptance criteria · ${criteria.filter((c) => c.done).length} of ${criteria.length}`, items: criteria } : null,
    latest: activity[0] ? `${activity[0].text} · ${now - activity[0].at < 60_000 ? "just now" : `${since(now - activity[0].at)} ago`}` : null,
    url: task.url,
    title: task.title,
    mark: trackerName(task.connection).charAt(0).toUpperCase(),
    meta: [PRIORITY[task.priority] ?? "", sprint ?? ""].filter(Boolean).join(" · "),
    state: column?.name ?? choices[current]?.label ?? null,
    choices: choices.map((c, i) => ({ label: c.label, status: c.status, current: i === current })),
    // Its checklist shows as the acceptance criteria instead.
    description: criteria.length ? withoutChecklist(withoutComments(task.description)) : withoutComments(task.description).trim(),
    sessions,
    worktrees: (card?.card.orphans ?? []).map((w) => ({ path: w.path, branch: w.branch ?? "", ...(w.project && { project: w.project }) })),
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

/** `moving` less the moves the snapshot's tasks show done, and those older than two minutes but waiting for the Mac. */
export function pruneMoves<M extends { status: string; at: number; waiting?: boolean }>(moving: Record<string, M>, tasks: Task[], now: number): Record<string, M> {
  const byId = new Map(tasks.map((t) => [taskId(t), t]));
  return Object.fromEntries(
    Object.entries(moving).filter(([id, m]) => {
      const t = byId.get(id);
      const there = !!t && holds({ name: "", category: "todo", statuses: [m.status] }, t);
      return !there && (!!m.waiting || now - m.at < MOVE_WAIT);
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

/** The New issue form on `board` (X76, as the desktop's X52 form): where it may go, what it asks, and whether Create can be pressed. */
export function issueForm(board: BoardConfig, snapshot: Pick<TaskSnapshot, "tasks" | "repos" | "boardData">, draft: NewIssue, options: IssueOptions | null) {
  const keys = snapshot.boardData[board.id]?.keys ?? [];
  const places = !needsPlace(board) ? [] : board.origin.kind === "github_project" ? projectRepos(snapshot.repos, snapshot.tasks, keys) : jiraProjects(snapshot.tasks, keys);
  // A Jira board of one project puts it there without asking.
  const placed = needsPlace(board) && !draft.place && places.length === 1 && board.origin.kind !== "github_project" ? { ...draft, place: places[0] } : draft;
  const access = withAccess(placed, { canSet: options?.canSet ?? true, fields: options?.fields });
  // Jira refuses a label with a space (X52).
  const problem = access.labels ? labelProblem(board, access.draft.labels) : null;
  return {
    places,
    askPlace: needsPlace(board) && (board.origin.kind === "github_project" || places.length !== 1),
    askType: needsType(board),
    assignee: access.assignee,
    labels: access.labels,
    draft: access.draft,
    problem,
    // Not before the Mac's lists: a field Jira requires shows only in them.
    ready: options !== null && canSubmit(access.draft, { busy: false, needsPlace: needsPlace(board), needsType: needsType(board), missing: options.missing, problem }),
  };
}

/** New session's preset for `task` (X76), as the Mac's composer makes it (X46's `composerTask`). */
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

type Detail = NonNullable<ReturnType<typeof taskDetail>>;

/** Why the Move sheet suggests a column: the out-of-sync chip's reason. */
function suggestion(why: string): string {
  const pr = /PR #(\d+) is open/.exec(why) ?? /the last #(\d+)/.exec(why);
  if (!pr) return "a session works on it";
  return why.includes("merged") ? `PR #${pr[1]} is merged` : `PR #${pr[1]} is open`;
}

/**
 * The Move sheet (X76): the board's columns in its order, each with its
 * category, the current one "now", the out-of-sync fix's "suggested", and
 * what the Mac does. The suggested column starts picked, else the current.
 */
export function moveSheet(b: PhoneBoard, t: Detail) {
  const tracker = trackerName(b.board.connection);
  const columns = syncedColumns(b.board, null);
  const suggested = t.outOfSync?.to ?? null;
  const current = t.choices.find((c) => c.current)?.label ?? null;
  const rows = t.choices.map((c) => {
    const category = columns.find((x) => x.name === c.label)?.category ?? "todo";
    const tail = c.label === suggested && t.outOfSync ? `suggested, ${suggestion(t.outOfSync.why)}` : c.current ? "now" : category === "done" ? "Keep in step suggests clean-up after" : "";
    return { name: c.label, status: c.status, category, line: [CATEGORY_LABEL[category], tail].filter(Boolean).join(" · "), tone: c.label === suggested ? ("accent" as const) : ("muted" as const) };
  });
  return {
    title: `Move ${t.key}`,
    sub: `${boardTitle(b.board, b.snapshot.boardData[b.board.id]?.sprint?.name)} · the board's columns, in its order`,
    rows,
    picked: suggested ?? current,
    note: `moonlet on ${b.snapshot.from} moves it in ${tracker} to the column's first status and notes it in the task's Activity. If ${tracker} refuses, it goes back with ${tracker}'s message.`,
  };
}

/** The key in a pasted URL: `…/issue/MOON-142/remote-hosts` finds MOON-142, `github.com/acme/web/issues/12` acme/web#12. */
function pastedKey(query: string): string {
  const q = query.trim();
  if (!/^https?:\/\//.test(q)) return query;
  const gh = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)/.exec(q);
  if (gh) return `${gh[1]}#${gh[2]}`;
  return /([A-Z][A-Z0-9]+-\d+)(?!.*[A-Z][A-Z0-9]+-\d+)/.exec(q)?.[1] ?? query;
}

export interface LinkRow {
  id: string;
  key: string;
  title: string;
  category: Category;
  /** `Todo · no sessions · updated 1 h ago`, or the reason it is suggested. */
  line: string;
  task: Task;
}

/**
 * Link a session to a task (X76, the desktop's X46 dialog): the tasks of the
 * session's workspace's boards, suggested ones first (its name is a task's
 * title, or its branch carries the key), then the rest by last update.
 */
export function linkSheet(boards: PhoneBoard[], d: HostData, session: { name: string; branch: string }, query: string, now: number) {
  const tasks = new Map<string, { task: Task; board: PhoneBoard }>();
  for (const b of boards) for (const t of b.snapshot.tasks) if (!tasks.has(taskId(t))) tasks.set(taskId(t), { task: t, board: b });
  const sessionsOf = (t: Task) => d.sessions.filter((s) => !s.archived && s.task?.connection === t.connection && s.task.key === t.key).length;
  const placed = (t: Task) => {
    const b = tasks.get(taskId(t))!.board;
    return syncedColumns(b.board, null).find((c) => holds(c, t)) ?? null;
  };
  const choices = linkChoices(session, [...tasks.values()].map((x) => x.task), pastedKey(query));
  const row = (t: Task, lead: string | null): LinkRow => {
    const n = sessionsOf(t);
    const column = placed(t);
    const parts = [lead, column?.name ?? "", n ? `${n} session${n === 1 ? "" : "s"}` : "no sessions", lead ? "" : `updated ${now - t.updatedMs < 60_000 ? "just now" : `${since(now - t.updatedMs)} ago`}`];
    return { id: taskId(t), key: t.key, title: t.title, category: column?.category ?? "todo", line: parts.filter(Boolean).join(" · "), task: t };
  };
  return {
    title: `Link “${session.name}” to a task`,
    suggested: choices.suggested.map((s) => row(s.task, s.reason)),
    recent: choices.recent.map((t) => row(t, null)),
    note: "Links live in moonlet; the tracker hears of a PR only through Keep in step.",
  };
}
