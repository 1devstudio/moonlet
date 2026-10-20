import { describe, expect, it } from "vitest";
import type { BoardColumn, BoardConfig } from "@desktop/lib/boards";
import { DEFAULT_RULES } from "@desktop/lib/keepInStep";
import type { Task } from "@desktop/lib/tasks";
import type { TaskSnapshot } from "@desktop/lib/taskSnapshot";
import { phoneBoards } from "./board";
import { activityTime, issueForm, pruneMoves, taskDetail, taskPreset } from "./taskView";
import { MIN, NOW, data, project, session, terminal, workspace } from "./fixtures";

const LINEAR = "linear:acme";
const COLUMNS: BoardColumn[] = [
  { name: "Todo", statuses: ["s-todo"], category: "todo" },
  { name: "In Progress", statuses: ["s-progress"], category: "in_progress" },
  { name: "In Review", statuses: ["s-review"], category: "in_review" },
  { name: "Done", statuses: ["s-done"], category: "done", show: "fold" },
];
const MOONLET: BoardConfig = { id: "moon", name: "Moonlet", connection: LINEAR, workspace: "local/personal", origin: { kind: "linear_team", team: "MOON" }, columns: COLUMNS, finished: "sprint" };
const MOON142: Task = {
  connection: LINEAR,
  key: "MOON-142",
  title: "Remote hosts sidebar",
  url: "https://linear.app/acme/issue/MOON-142",
  column: "in_progress",
  priority: 3,
  assignees: ["Sam Rivera"],
  labels: [],
  description: "Add a Hosts section listing every machine running moonletd.\n\n<!-- moonlet: keep -->\n- Group sessions by host",
  updatedMs: 0,
  tracker: { id: "id-142", state: "s-progress", source: "MOON" },
};
const snapshot: TaskSnapshot = {
  version: 1,
  syncedAt: NOW - MIN,
  from: "studio",
  boards: [MOONLET],
  shownBoard: "moon",
  tasks: [MOON142],
  boardData: { moon: { keys: [`${LINEAR} MOON-142`], sprint: { id: 14, name: "Cycle 14", startMs: 0, endMs: 0 } } },
  worktrees: [{ path: "/wt/ssh", branch: "moon-142-ssh-test", originRepo: null }],
  repos: {},
  sourceProjects: {},
  error: null,
  activity: { [`${LINEAR} MOON-142`]: [{ at: NOW - 20 * MIN, text: "Claude launched 5 subagents in Remote hosts sidebar" }] },
  attention: {},
  trackers: { github: { branch_template: "", max_length: 48, rules: DEFAULT_RULES } },
  link: { branch: true, pr: true, title: true },
};
const mac = () =>
  data({
    workspaces: [workspace("personal", "Personal")],
    projects: [project("moonlet", "moonlet")],
    sessions: [
      session("remote", "Remote hosts sidebar", { branch: "moon-142-remote-hosts", project_id: "moonlet" }),
      session("spike", "Hosts section spike", { branch: "moon-142-hosts-spike", project_id: "moonlet", agent: "codex" }),
    ],
    terminals: {
      1: terminal(1, "remote", { agent_state: "blocked", subagents: 5 }),
      2: terminal(2, "spike", { agent: "codex", agent_state: "idle", last_output_at: NOW - 60 * MIN }),
    },
    chats: { 1: { pending: [{ id: "a1", tool: "Bash", summary: "pnpm add", input: {}, can_always: true, agent: "a9" }], status: "blocked", cost_usd: 0, input_tokens: 0, output_tokens: 0, slash_commands: [], queued: [], turn_started_at: NOW - 134_000 } },
    tasks: { personal: snapshot },
  });
const hosts = { mac: { id: "mac", label: "studio", status: "connected" as const, via: null } };
const details = { prs: {}, git: { remote: { additions: 412, deletions: 38 }, spike: { additions: 46, deletions: 3 } } };

describe("taskDetail (X57)", () => {
  const detail = () => {
    const [b] = phoneBoards(hosts, { mac: mac() }, null);
    return taskDetail(b, `${LINEAR} MOON-142`, mac(), details, {}, NOW)!;
  };

  it("heads the task with its tracker, key, priority and cycle, its state and its description without HTML comments", () => {
    const t = detail();
    expect([t.mark, t.key, t.meta, t.title, t.state]).toEqual(["L", "MOON-142", "High · Cycle 14", "Remote hosts sidebar", "In Progress"]);
    expect(t.description).toBe("Add a Hosts section listing every machine running moonletd.\n\n\n- Group sessions by host");
    expect(t.choices).toEqual([
      { label: "Todo", status: "s-todo", current: false },
      { label: "In Progress", status: "s-progress", current: true },
      { label: "In Review", status: "s-review", current: false },
      { label: "Done", status: "s-done", current: false },
    ]);
  });

  it("lists its sessions with their agent and what they do, and says when one waits for the user", () => {
    expect(detail().sessions).toEqual([
      { id: "remote", name: "Remote hosts sidebar", state: "blocked", agent: "claude", word: "Claude · needs you · 5 subagents", branch: "moon-142-remote-hosts", add: 412, del: 38, waiting: "A subagent is waiting for your approval" },
      { id: "spike", name: "Hosts section spike", state: "idle", agent: "codex", word: "Codex · idle for 1h", branch: "moon-142-hosts-spike", add: 46, del: 3, waiting: null },
    ]);
  });

  it("says a session has no agent instead of naming one", () => {
    const d = mac();
    d.sessions.push(session("plain", "Plain shell", { branch: "moon-142-plain", project_id: "moonlet", agent: null }));
    const [b] = phoneBoards(hosts, { mac: d }, null);
    expect(taskDetail(b, `${LINEAR} MOON-142`, d, details, {}, NOW)!.sessions.find((s) => s.id === "plain")?.word).toMatch(/^No agent · idle for /);
  });

  it("offers its worktrees without a session, and its activity, newest first", () => {
    expect(detail().worktrees).toEqual([{ path: "/wt/ssh", branch: "moon-142-ssh-test" }]);
    expect(detail().activity).toEqual([{ when: activityTime(NOW - 20 * MIN, NOW), text: "Claude launched 5 subagents in Remote hosts sidebar" }]);
  });

  it("is null for a task the board no longer has", () => {
    const [b] = phoneBoards(hosts, { mac: mac() }, null);
    expect(taskDetail(b, `${LINEAR} MOON-999`, mac(), details, {}, NOW)).toBeNull();
  });
});

describe("activityTime (X57)", () => {
  it("is the time today, Yesterday, else the date", () => {
    const now = new Date(2026, 9, 20, 18, 0).getTime();
    expect(activityTime(new Date(2026, 9, 20, 16, 12).getTime(), now)).toBe("4:12 PM");
    expect(activityTime(new Date(2026, 9, 19, 9, 5).getTime(), now)).toBe("Yesterday");
    expect(activityTime(new Date(2026, 9, 12, 9, 5).getTime(), now)).toBe("Oct 12");
  });
});

describe("pruneMoves (X57)", () => {
  it("drops a move once the Mac's snapshot has the task there, or after two minutes", () => {
    const moving = {
      [`${LINEAR} MOON-142`]: { status: "s-progress", name: "In Progress", at: NOW },
      [`${LINEAR} MOON-151`]: { status: "s-review", name: "In Review", at: NOW },
      [`${LINEAR} MOON-152`]: { status: "s-review", name: "In Review", at: NOW - 3 * MIN },
    };
    const tasks = [MOON142, { ...MOON142, key: "MOON-151", tracker: { id: "x", state: "s-todo", source: "MOON" } }, { ...MOON142, key: "MOON-152", tracker: { id: "y", state: "s-todo", source: "MOON" } }];
    expect(Object.keys(pruneMoves(moving, tasks, NOW))).toEqual([`${LINEAR} MOON-151`]);
  });
});

describe("issueForm (X57, as X52)", () => {
  const JIRA = "jira:acme.atlassian.net";
  const jiraTask = (key: string): Task => ({ ...MOON142, connection: JIRA, key, tracker: { id: key, state: "3", source: "OPS" } });
  const OPS: BoardConfig = { id: "ops", name: "OPS", connection: JIRA, workspace: "local/acme", origin: { kind: "jql", query: "project in (OPS, PLAT)" }, columns: COLUMNS };
  const jira: TaskSnapshot = { ...snapshot, boards: [OPS], tasks: [jiraTask("OPS-1"), jiraTask("OPS-2"), jiraTask("PLAT-3")], boardData: { ops: { keys: [`${JIRA} OPS-1`, `${JIRA} OPS-2`, `${JIRA} PLAT-3`] } } };
  const draft = { title: "", description: "", assignee: "me", labels: [] };

  it("asks a Jira board where the issue goes, its projects most used first, and its type", () => {
    const f = issueForm(OPS, jira, draft, null);
    expect([f.places, f.askPlace, f.askType, f.ready]).toEqual([["OPS", "PLAT"], true, true, false]);
    expect(issueForm(OPS, jira, { ...draft, title: "Retry webhooks", place: "OPS", issueType: "10004" }, { me: "u1", people: [], labels: [], canSet: true }).ready).toBe(true);
  });

  it("waits for the Mac's lists before Create, so a field Jira requires is not missed", () => {
    expect(issueForm(MOONLET, snapshot, { ...draft, title: "Show host health" }, null).ready).toBe(false);
  });

  it("needs only a title on a Linear board, and sends no labels where they can't be set", () => {
    const f = issueForm(MOONLET, snapshot, { ...draft, title: "Show host health", labels: ["ui"] }, { me: "u1", people: [], labels: [], canSet: true, fields: ["assignee"] });
    expect([f.places, f.askPlace, f.askType, f.ready, f.labels, f.draft.labels]).toEqual([[], false, false, true, false, []]);
  });
});

describe("taskPreset (X57)", () => {
  it("starts a session from a task as the Mac's composer does: its projects, Keep in step's checkbox and the tracker's branch template", () => {
    const todo: Task = { ...MOON142, key: "MOON-151", title: "Drag sessions between sections", column: "todo", tracker: { id: "id-151", state: "s-todo", source: "MOON" } };
    const snap: TaskSnapshot = { ...snapshot, sourceProjects: { [`${LINEAR} MOON`]: ["moonlet"] }, trackers: { ...snapshot.trackers, linear: { branch_template: "{key}-{title}", max_length: 40, rules: DEFAULT_RULES } } };
    const [b] = phoneBoards(hosts, { mac: { ...mac(), tasks: { personal: snap } } }, null);
    const p = taskPreset(b, todo);
    expect([p.key, p.title, p.projects, p.template, p.maxLen, p.ref]).toEqual(["MOON-151", "Drag sessions between sections", ["moonlet"], "{key}-{title}", 40, { connection: LINEAR, key: "MOON-151", url: "https://linear.app/acme/issue/MOON-142" }]);
    expect(p.assign).toEqual({ label: "Move to In Progress", title: "Move MOON-151 to In Progress and assign it to me", checked: true });
  });
});
