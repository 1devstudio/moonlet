import { describe, expect, it } from "vitest";
import type { BoardColumn, BoardConfig } from "@desktop/lib/boards";
import { DEFAULT_RULES } from "@desktop/lib/keepInStep";
import type { Task } from "@desktop/lib/tasks";
import type { TaskSnapshot } from "@desktop/lib/taskSnapshot";
import { phoneBoards } from "./board";
import { activityTime, issueForm, linkSheet, moveSheet, pruneMoves, taskDetail, taskPreset } from "./taskView";
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

describe("taskDetail (X76)", () => {
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
      { id: "remote", name: "Remote hosts sidebar", state: "blocked", agent: "claude", word: "Claude · needs you · 5 subagents", branch: "moon-142-remote-hosts", add: 412, del: 38, waiting: "A subagent is waiting for your approval", where: "moonlet/moon-142-remote-hosts", ask: "Allow Bash?", pr: null },
      { id: "spike", name: "Hosts section spike", state: "idle", agent: "codex", word: "Codex · idle for 1h", branch: "moon-142-hosts-spike", add: 46, del: 3, waiting: null, where: "moonlet/moon-142-hosts-spike", ask: null, pr: null },
    ]);
  });

  it("says idle without a time for a session that has said nothing yet", () => {
    const d = mac();
    d.sessions.push(session("quiet", "Quiet one", { branch: "moon-142-quiet", project_id: "moonlet", agent: "codex" }));
    const [b] = phoneBoards(hosts, { mac: d }, null);
    expect(taskDetail(b, `${LINEAR} MOON-142`, d, details, {}, NOW)!.sessions.find((s) => s.id === "quiet")?.word).toBe("Codex · idle");
  });

  it("says a session has no agent instead of naming one", () => {
    const d = mac();
    d.sessions.push(session("plain", "Plain shell", { branch: "moon-142-plain", project_id: "moonlet", agent: null }));
    const [b] = phoneBoards(hosts, { mac: d }, null);
    expect(taskDetail(b, `${LINEAR} MOON-142`, d, details, {}, NOW)!.sessions.find((s) => s.id === "plain")?.word).toBe("No agent · idle");
  });

  it("offers its worktrees without a session, and its activity, newest first", () => {
    expect(detail().worktrees).toEqual([{ path: "/wt/ssh", branch: "moon-142-ssh-test" }]);
    expect(detail().activity).toEqual([{ when: activityTime(NOW - 20 * MIN, NOW), text: "Claude launched 5 subagents in Remote hosts sidebar" }]);
  });

  it("heads the task as the design does: type and estimate, priority, assignee, sprint dates and labels", () => {
    const d = mac();
    const oct20 = new Date(2026, 9, 20).getTime();
    const nov2 = new Date(2026, 10, 2).getTime();
    d.tasks.personal = {
      ...snapshot,
      tasks: [{ ...MOON142, issueType: "Story", points: 5, labels: ["search", "catalog"] }],
      boardData: { moon: { keys: [`${LINEAR} MOON-142`], sprint: { id: 14, name: "Cycle 14", startMs: oct20, endMs: nov2 } } },
    };
    const [b] = phoneBoards(hosts, { mac: d }, null);
    const t = taskDetail(b, `${LINEAR} MOON-142`, d, details, {}, NOW)!;
    expect([t.kind, t.priority, t.assignee, t.sprint, t.labels]).toEqual(["Story · 5 pt", "High", { initials: "SR", name: "Sam Rivera" }, "Cycle 14 · Oct 20 – Nov 2", ["search", "catalog"]]);
  });

  it("says in a sentence why the task is out of sync", () => {
    const pr = { number: 147, url: "", state: "open", title: "", checks: [{ name: "ci / test", conclusion: "failure" }, { name: "ci / lint", conclusion: "success" }, { name: "preview", conclusion: null }], review_decision: "REVIEW_REQUIRED" };
    const [b] = phoneBoards(hosts, { mac: mac() }, null);
    const t = taskDetail(b, `${LINEAR} MOON-142`, mac(), { ...details, prs: { remote: pr as never } }, {}, NOW)!;
    expect(t.outOfSync).toEqual({ why: "PR #147 is open and not a draft, but the issue is still In Progress.", fix: "Move to In Review", to: "In Review", key: expect.stringContaining("MOON-142") });
    // Each session's lines: where, its agent with what it waits for, and its PR.
    expect(t.sessions[0]).toMatchObject({ where: "moonlet/moon-142-remote-hosts", ask: "Allow Bash?", pr: { text: "#147 open", tone: "open", checks: "1/3 checks", failing: "1 failing", review: "review required" } });
    expect(t.sessions[1].pr).toBeNull();
  });

  it("says what is left of a done task", () => {
    const d = mac();
    d.tasks.personal = { ...snapshot, tasks: [{ ...MOON142, column: "done", tracker: { id: "id-142", state: "s-done", source: "MOON" } }] };
    const [b] = phoneBoards(hosts, { mac: d }, null);
    expect(taskDetail(b, `${LINEAR} MOON-142`, d, details, {}, NOW)!.outOfSync).toEqual({ why: "The issue is done, but 2 sessions, 3 worktrees are left.", fix: "Clean up", to: null, key: expect.any(String) });
  });

  it("lists the description's acceptance criteria, and the newest activity line for the folded Activity", () => {
    const d = mac();
    d.tasks.personal = { ...snapshot, tasks: [{ ...MOON142, description: "Shoppers can't find products.\n\n- [x] Search box above the grid\n- [ ] Waits 200 ms after typing" }] };
    const [b] = phoneBoards(hosts, { mac: d }, null);
    const t = taskDetail(b, `${LINEAR} MOON-142`, d, details, {}, NOW)!;
    expect(t.criteria).toEqual({ heading: "Acceptance criteria · 1 of 2", items: [{ text: "Search box above the grid", done: true }, { text: "Waits 200 ms after typing", done: false }] });
    // The description leaves its checklist to the criteria.
    expect(t.description).toBe("Shoppers can't find products.");
    // Plain bullets under an Acceptance criteria heading leave the description too.
    d.tasks.personal = { ...snapshot, tasks: [{ ...MOON142, description: "Shoppers can't find products.\n\n## Acceptance criteria\n- Search box above the grid\n- Waits 200 ms\n\n## Notes\nSee the frame." }] };
    const [b2] = phoneBoards(hosts, { mac: d }, null);
    const t2 = taskDetail(b2, `${LINEAR} MOON-142`, d, details, {}, NOW)!;
    expect([t2.criteria?.heading, t2.description]).toEqual(["Acceptance criteria · 0 of 2", "Shoppers can't find products.\n\n## Notes\nSee the frame."]);
    // With a checklist elsewhere, the criteria are the checklist: the section's plain bullets stay in the description.
    d.tasks.personal = { ...snapshot, tasks: [{ ...MOON142, description: "Intro.\n\n- [ ] Ship it\n\n## Acceptance criteria\n- Works offline" }] };
    const [b3] = phoneBoards(hosts, { mac: d }, null);
    const t3 = taskDetail(b3, `${LINEAR} MOON-142`, d, details, {}, NOW)!;
    expect([t3.criteria?.heading, t3.description]).toEqual(["Acceptance criteria · 0 of 1", "Intro.\n\n## Acceptance criteria\n- Works offline"]);
    expect(t.latest).toBe("Claude launched 5 subagents in Remote hosts sidebar · 20m ago");
  });

  it("is null for a task the board no longer has", () => {
    const [b] = phoneBoards(hosts, { mac: mac() }, null);
    expect(taskDetail(b, `${LINEAR} MOON-999`, mac(), details, {}, NOW)).toBeNull();
  });
});

describe("moveSheet (X76)", () => {
  it("lists the board's columns in order, the current one now, the out-of-sync fix's suggested and picked, and says what the Mac does", () => {
    const pr = { number: 147, url: "", state: "open", title: "", checks: [], review_decision: null };
    const [b] = phoneBoards(hosts, { mac: mac() }, null);
    const t = taskDetail(b, `${LINEAR} MOON-142`, mac(), { ...details, prs: { remote: pr } }, {}, NOW)!;
    expect(moveSheet(b, t)).toEqual({
      title: "Move MOON-142",
      sub: "Moonlet · Cycle 14 · the board's columns, in its order",
      rows: [
        { name: "Todo", status: "s-todo", category: "todo", line: "To do", tone: "muted" },
        { name: "In Progress", status: "s-progress", category: "in_progress", line: "In progress · now", tone: "muted" },
        { name: "In Review", status: "s-review", category: "in_review", line: "In review · suggested, PR #147 is open", tone: "accent" },
        { name: "Done", status: "s-done", category: "done", line: "Done · Keep in step suggests clean-up after", tone: "muted" },
      ],
      picked: "In Review",
      note: "moonlet on studio moves it in Linear to the column's first status and notes it in the task's Activity. If Linear refuses, it goes back with Linear's message.",
    });
    // In step: the current column starts picked.
    expect(moveSheet(b, taskDetail(b, `${LINEAR} MOON-142`, mac(), details, {}, NOW)!).picked).toBe("In Progress");
  });
});

describe("linkSheet (X76)", () => {
  const todo = (key: string, title: string, updatedMs: number): Task => ({ ...MOON142, key, title, column: "todo", updatedMs, tracker: { id: key, state: "s-todo", source: "MOON" } });
  const d = () => {
    const m = mac();
    m.tasks.personal = { ...snapshot, tasks: [{ ...MOON142, updatedMs: NOW - 2 * 24 * 60 * MIN }, todo("MOON-283", "Dark mode for account pages", NOW - 3 * 60 * MIN), todo("MOON-285", "Price filter on category pages", NOW - 60 * MIN)] };
    m.sessions[0] = { ...m.sessions[0], task: { connection: LINEAR, key: "MOON-142", url: "" } };
    return m;
  };

  it("suggests the task the session's name matches, then the rest by last update, each with its column, sessions and age", () => {
    const boards = phoneBoards(hosts, { mac: d() }, null);
    const sheet = linkSheet(boards, d(), { name: "Dark mode for account pages", branch: "moonlet/account-dark" }, "", NOW);
    expect(sheet.title).toBe("Link “Dark mode for account pages” to a task");
    expect(sheet.suggested).toEqual([{ id: `${LINEAR} MOON-283`, key: "MOON-283", title: "Dark mode for account pages", category: "todo", line: "Title matches the session name · Todo · no sessions", task: expect.anything() }]);
    expect(sheet.recent.map((r) => [r.key, r.line])).toEqual([
      ["MOON-285", "Todo · no sessions · updated 1 h ago"],
      ["MOON-142", "In Progress · 1 session · updated 2 d ago"],
    ]);
    expect(sheet.note).toBe("Links live in moonlet; the tracker hears of a PR only through Keep in step.");
  });

  it("finds a task by key, title, or a pasted URL", () => {
    const boards = phoneBoards(hosts, { mac: d() }, null);
    const s = { name: "Spike", branch: "spike" };
    expect(linkSheet(boards, d(), s, "price", NOW).recent.map((r) => r.key)).toEqual(["MOON-285"]);
    expect(linkSheet(boards, d(), s, "https://linear.app/acme/issue/MOON-142/remote-hosts", NOW).recent.map((r) => r.key)).toEqual(["MOON-142"]);
    // A GitHub issue's URL finds it by its key.
    const gh = mac();
    gh.tasks.personal = { ...snapshot, tasks: [{ ...MOON142, connection: "github:github.com", key: "acme/web#12", title: "Fix login", url: "https://github.com/acme/web/issues/12", tracker: undefined, github: { repo: "acme/web", number: 12, closingPrs: [] } }], boardData: { moon: { keys: ["github:github.com acme/web#12"] } } };
    const ghBoards = phoneBoards(hosts, { mac: gh }, null);
    expect(linkSheet(ghBoards, gh, s, "https://github.com/acme/web/issues/12", NOW).recent.map((r) => r.key)).toEqual(["acme/web#12"]);
  });
});

describe("activityTime (X76)", () => {
  it("is the time today, Yesterday, else the date", () => {
    const now = new Date(2026, 9, 20, 18, 0).getTime();
    expect(activityTime(new Date(2026, 9, 20, 16, 12).getTime(), now)).toBe("4:12 PM");
    expect(activityTime(new Date(2026, 9, 19, 9, 5).getTime(), now)).toBe("Yesterday");
    expect(activityTime(new Date(2026, 9, 12, 9, 5).getTime(), now)).toBe("Oct 12");
  });
});

describe("pruneMoves (X76)", () => {
  it("drops a move once the Mac's snapshot has the task there, or after two minutes", () => {
    const moving = {
      [`${LINEAR} MOON-142`]: { status: "s-progress", name: "In Progress", at: NOW },
      [`${LINEAR} MOON-151`]: { status: "s-review", name: "In Review", at: NOW },
      [`${LINEAR} MOON-152`]: { status: "s-review", name: "In Review", at: NOW - 3 * MIN },
    };
    const tasks = [MOON142, { ...MOON142, key: "MOON-151", tracker: { id: "x", state: "s-todo", source: "MOON" } }, { ...MOON142, key: "MOON-152", tracker: { id: "y", state: "s-todo", source: "MOON" } }];
    expect(Object.keys(pruneMoves(moving, tasks, NOW))).toEqual([`${LINEAR} MOON-151`]);
    // A move waiting for moonlet on the Mac stays, however long it waits.
    const waiting = { [`${LINEAR} MOON-152`]: { status: "s-review", name: "In Review", at: NOW - 3 * 60 * MIN, waiting: true } };
    expect(Object.keys(pruneMoves(waiting, tasks, NOW))).toEqual([`${LINEAR} MOON-152`]);
  });
});

describe("issueForm refuses what Jira would (X76, as X52)", () => {
  it("keeps Create off for a Jira label with a space, and says why", () => {
    const JIRA = "jira:acme.atlassian.net";
    const OPS: BoardConfig = { id: "ops", name: "OPS", connection: JIRA, workspace: "local/acme", origin: { kind: "jira_board", board: 1 }, columns: COLUMNS };
    const jiraTask: Task = { ...MOON142, connection: JIRA, key: "OPS-1", tracker: { id: "OPS-1", state: "3", source: "OPS" } };
    const snap: TaskSnapshot = { ...snapshot, boards: [OPS], tasks: [jiraTask], boardData: { ops: { keys: [`${JIRA} OPS-1`] } } };
    const options = { me: "u1", people: [], labels: [], canSet: true, issueTypes: [{ id: "10004", name: "Task" }] };
    const form = issueForm(OPS, snap, { title: "Retry", description: "", assignee: "me", labels: ["needs review"], place: "OPS", issueType: "10004" }, options);
    expect([form.ready, form.problem]).toEqual([false, "Jira labels can't have spaces: needs review"]);
  });
});

describe("issueForm (X76, as X52)", () => {
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

describe("taskPreset (X76)", () => {
  it("starts a session from a task as the Mac's composer does: its projects, Keep in step's checkbox and the tracker's branch template", () => {
    const todo: Task = { ...MOON142, key: "MOON-151", title: "Drag sessions between sections", column: "todo", tracker: { id: "id-151", state: "s-todo", source: "MOON" } };
    const snap: TaskSnapshot = { ...snapshot, sourceProjects: { [`${LINEAR} MOON`]: ["moonlet"] }, trackers: { ...snapshot.trackers, linear: { branch_template: "{key}-{title}", max_length: 40, rules: DEFAULT_RULES } } };
    const [b] = phoneBoards(hosts, { mac: { ...mac(), tasks: { personal: snap } } }, null);
    const p = taskPreset(b, todo);
    expect([p.key, p.title, p.projects, p.template, p.maxLen, p.ref]).toEqual(["MOON-151", "Drag sessions between sections", ["moonlet"], "{key}-{title}", 40, { connection: LINEAR, key: "MOON-151", url: "https://linear.app/acme/issue/MOON-142" }]);
    expect(p.assign).toEqual({ label: "Move to In Progress", title: "Move MOON-151 to In Progress and assign it to me", checked: true });
  });
});
