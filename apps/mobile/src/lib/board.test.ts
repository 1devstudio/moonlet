import { describe, expect, it } from "vitest";
import type { BoardColumn, BoardConfig } from "@desktop/lib/boards";
import { DEFAULT_RULES } from "@desktop/lib/keepInStep";
import type { Task } from "@desktop/lib/tasks";
import type { TaskSnapshot } from "@desktop/lib/taskSnapshot";
import type { PullRequest } from "@desktop/lib/protocol";
import { boardScreen, firstColumn, phoneBoards, switcher, syncLine } from "./board";
import { MIN, NOW, data, project, session, terminal, workspace } from "./fixtures";

const LINEAR = "linear:acme";
const COLUMNS: BoardColumn[] = [
  { name: "Backlog", statuses: ["s-backlog"], category: "todo", show: "hide" },
  { name: "Todo", statuses: ["s-todo"], category: "todo" },
  { name: "In Progress", statuses: ["s-progress"], category: "in_progress" },
  { name: "In Review", statuses: ["s-review"], category: "in_review" },
  { name: "Done", statuses: ["s-done"], category: "done", show: "fold" },
];
const MOONLET: BoardConfig = { id: "moon", name: "Moonlet", connection: LINEAR, workspace: "local/personal", origin: { kind: "linear_team", team: "MOON" }, columns: COLUMNS, cards: ["assignee", "parent"] };
const task = (key: string, title: string, status: string, column: Task["column"], o: Partial<Task> = {}): Task => ({
  connection: LINEAR,
  key,
  title,
  url: `https://linear.app/acme/issue/${key}`,
  column,
  priority: 2,
  assignees: ["Sam Rivera"],
  labels: [],
  description: "",
  updatedMs: 0,
  tracker: { id: `id-${key}`, state: status, source: "MOON" },
  ...o,
});
const TASKS = [
  task("MOON-142", "Remote hosts sidebar", "s-progress", "in_progress", { priority: 3, parent: { key: "MOON-120", title: "Hosts" } }),
  task("MOON-147", "Block styling pass", "s-progress", "in_progress"),
  task("MOON-144", "File tabs", "s-review", "in_review"),
  task("MOON-151", "Drag sessions between sections", "s-todo", "todo", { assignees: [] }),
];
const snapshot = (o: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  version: 1,
  syncedAt: NOW - 5 * MIN,
  from: "studio",
  boards: [MOONLET],
  shownBoard: "moon",
  tasks: TASKS,
  boardData: { moon: { keys: TASKS.map((t) => `${LINEAR} ${t.key}`) } },
  worktrees: [],
  repos: {},
  sourceProjects: {},
  error: null,
  activity: {},
  attention: {},
  trackers: { github: { branch_template: "", max_length: 48, rules: DEFAULT_RULES }, linear: { branch_template: "{key}-{title}", max_length: 48, rules: DEFAULT_RULES } },
  link: { branch: true, pr: true, title: true },
  ...o,
});

const pr = (number: number, state: string): PullRequest => ({ number, url: `https://github.com/acme/moonlet/pull/${number}`, state, title: "", checks: [], review_decision: null });

/** The Mac's daemon: the board, and the sessions working on its tasks. */
const mac = (snap = snapshot()) =>
  data({
    workspaces: [workspace("personal", "Personal"), workspace("acme", "Acme")],
    projects: [project("moonlet", "moonlet")],
    sessions: [
      session("remote", "Remote hosts sidebar", { branch: "moon-142-remote-hosts", project_id: "moonlet" }),
      session("blocks", "Block styling pass", { branch: "moon-147-blocks", project_id: "moonlet" }),
      session("tabs", "File tabs", { branch: "moon-144-file-tabs", project_id: "moonlet" }),
    ],
    terminals: {
      1: terminal(1, "remote", { agent_state: "working", subagents: 5 }),
      2: terminal(2, "blocks", { agent_state: "blocked" }),
      3: terminal(3, "tabs", { agent_state: "idle" }),
    },
    tasks: { personal: snap },
  });
const hosts = { mac: { id: "mac", label: "studio", status: "connected" as const, via: null } };
const details = { prs: { tabs: pr(128, "merged") }, git: { remote: { additions: 412, deletions: 38 } } };

describe("phoneBoards (X76)", () => {
  const personal = { host: "mac", id: "personal", account: "" };
  it("lists the boards of the shown workspace on connected hosts, every workspace's with none shown", () => {
    const d = { mac: mac() };
    expect(phoneBoards(hosts, d, personal).map((b) => [b.key, b.board.name, b.workspaceName])).toEqual([["mac/personal/moon", "Moonlet", "Personal"]]);
    expect(phoneBoards(hosts, d, { host: "mac", id: "acme", account: "" })).toEqual([]);
    expect(phoneBoards(hosts, d, null)).toHaveLength(1);
    expect(phoneBoards({ mac: { ...hosts.mac, status: "reconnecting" as const } }, d, null)).toEqual([]);
  });

  it("lists the boards of the shown workspace once across an account's members, the newest snapshot's (X68)", () => {
    const air = { id: "air", label: "air", status: "connected" as const, via: null };
    const other = { id: "box", label: "box", status: "connected" as const, via: null };
    const d = {
      mac: { ...mac(snapshot({ syncedAt: NOW - 9 * MIN, from: "studio" })), account: "acc" },
      air: { ...mac(snapshot({ syncedAt: NOW - MIN, from: "air" })), account: "acc" },
      // A same-id workspace outside the account is another workspace.
      box: { ...mac(), account: "else" },
    };
    const shown = phoneBoards({ ...hosts, air, box: other }, d, { host: "mac", id: "personal", account: "acc" });
    expect(shown.map((b) => [b.key, b.snapshot.from])).toEqual([["air/personal/moon", "air"]]);
  });
});

describe("boardScreen (X76)", () => {
  const screen = () => {
    const [b] = phoneBoards(hosts, { mac: mac() }, { host: "mac", id: "personal", account: "" });
    return boardScreen(b, mac(), details, {});
  };
  const personal = { host: "mac", id: "personal", account: "" };

  it("heads the board as the Mac does", () => {
    expect(screen().title).toBe("Moonlet");
    expect(screen().subtitle).toBe("Linear · acme · 4 tasks · 3 sessions");
  });

  it("has a tab per shown column with its count and the number of cards to clean up", () => {
    expect(screen().columns.map((c) => [c.name, c.count, c.cleanUps, c.folded])).toEqual([
      ["Todo", 1, 0, false],
      ["In Progress", 2, 0, false],
      ["In Review", 1, 0, false],
      ["Done", 0, 0, true],
    ]);
    expect(firstColumn(screen().columns)).toBe("In Progress");
    // A done task with a worktree left needs clean-up.
    const all = [...TASKS, task("MOON-130", "Pairing", "s-done", "done")];
    const done = snapshot({ tasks: all, boardData: { moon: { keys: all.map((t) => `${LINEAR} ${t.key}`) } }, worktrees: [{ path: "/w/moon-130-pairing", branch: "moon-130-pairing", originRepo: null, project: "moonlet" }] });
    const [b] = phoneBoards(hosts, { mac: mac(done) }, personal);
    const cols = boardScreen(b, mac(done), details, {}).columns;
    expect(cols.map((c) => c.cleanUps)).toEqual([0, 0, 0, 1]);
    expect(cols.map((c) => c.line)).toEqual(["To do · 1 task", "In progress · 2 tasks", "In review · 1 task", "Done · 1 task · 1 needs clean-up"]);
  });

  it("counts the board's out-of-sync cards for the Tasks badge", () => {
    expect(screen().outOfSync).toBe(1);
  });

  it("keeps the user's tasks and the ones with their sessions under Assignee: me", () => {
    const mine = snapshot({ tasks: TASKS.map((t) => ({ ...t, mine: t.key === "MOON-151" })) });
    const [b] = phoneBoards(hosts, { mac: mac(mine) }, personal);
    const shown = boardScreen(b, mac(mine), details, {}, { mine: true });
    // MOON-151 is assigned to the user; the others have the user's sessions.
    expect(shown.columns.flatMap((c) => c.cards.map((x) => x.key))).toEqual(["MOON-151", "MOON-142", "MOON-147", "MOON-144"]);
    const none = snapshot({ tasks: TASKS.map((t) => ({ ...t, mine: false })) });
    const noSessions = data({ ...mac(none), sessions: [] });
    const [b2] = phoneBoards(hosts, { mac: noSessions }, personal);
    expect(boardScreen(b2, noSessions, details, {}, { mine: true }).columns.flatMap((c) => c.cards)).toEqual([]);
  });

  it("drops a chip put off with Not now, until the task or its sessions change", () => {
    const [b] = phoneBoards(hosts, { mac: mac() }, personal);
    const review = boardScreen(b, mac(), details, {}).columns.find((c) => c.name === "In Review")!;
    const put = { [review.cards[0].driftKey!]: true as const };
    const after = boardScreen(b, mac(), details, {}, { notNow: put });
    expect(after.columns.find((c) => c.name === "In Review")!.cards[0].drift).toBeNull();
    expect(after.outOfSync).toBe(0);
  });

  it("puts on each card its type and estimate when the board's cards show them", () => {
    const jira = snapshot({ boards: [{ ...MOONLET, cards: ["assignee", "issue_type", "points"] }], tasks: TASKS.map((t) => ({ ...t, issueType: "Story", points: 5 })) });
    const [b] = phoneBoards(hosts, { mac: mac(jira) }, personal);
    const card = boardScreen(b, mac(jira), details, {}).columns[0].cards[0];
    expect([card.type, card.points, card.initials]).toEqual(["Story", "5 pt", null]);
  });

  it("puts on each card its key, priority, assignee, card line and live sessions, and an out-of-sync fix", () => {
    const progress = screen().columns.find((c) => c.name === "In Progress")!;
    expect(progress.cards.map((c) => [c.key, c.title, c.priority, c.initials, c.line, c.needsYou, c.rows.map((r) => [r.name, r.state, r.meta.text])])).toEqual([
      ["MOON-142", "Remote hosts sidebar", 3, "SR", "MOON-120 Hosts", false, [["Remote hosts sidebar", "working", "◑ 5"]]],
      ["MOON-147", "Block styling pass", 2, "SR", null, true, [["Block styling pass", "blocked", "needs you"]]],
    ]);
    const review = screen().columns.find((c) => c.name === "In Review")!;
    expect(review.cards[0].drift).toEqual({ text: "#128 merged · still In Review", fix: "Move to Done", to: "Done", kind: "merged" });
    const todo = screen().columns.find((c) => c.name === "Todo")!;
    expect([todo.cards[0].initials, todo.cards[0].rows, todo.cards[0].empty]).toEqual([null, [], "No sessions"]);
  });

  it("shows a move the phone asked for at once, in its new column", () => {
    const [b] = phoneBoards(hosts, { mac: mac() }, { host: "mac", id: "personal", account: "" });
    const moved = boardScreen(b, mac(), details, { [`${LINEAR} MOON-151`]: { status: "s-progress", name: "In Progress" } });
    expect(moved.columns.map((c) => [c.name, c.count])).toEqual([
      ["Todo", 0],
      ["In Progress", 3],
      ["In Review", 1],
      ["Done", 0],
    ]);
  });
});

describe("syncLine (X76)", () => {
  it("says which Mac synced the board and when, and that moves wait while moonlet is closed there", () => {
    expect(syncLine(snapshot({ syncedAt: NOW - MIN }), true, NOW)).toEqual({ text: "Synced by studio 1m ago", open: true });
    expect(syncLine(snapshot({ syncedAt: NOW - 20 * 1000 }), true, NOW).text).toBe("Synced by studio just now");
    expect(syncLine(snapshot({ syncedAt: NOW - 2 * 60 * MIN }), false, NOW)).toEqual({ text: "moonlet is closed on studio · showing tasks from 2 h ago · moves wait for it", open: false });
    expect(syncLine(snapshot({ syncedAt: NOW - 3 * 24 * 60 * MIN }), false, NOW).text).toBe("moonlet is closed on studio · showing tasks from 3 d ago · moves wait for it");
    expect(syncLine(snapshot({ syncedAt: null }), true, NOW).text).toBe("Not synced yet by studio");
  });
});

describe("switcher (X76)", () => {
  const OPS: BoardConfig = { id: "ops", name: "OPS", connection: "jira:acme.atlassian.net", workspace: "local/acme", origin: { kind: "jira_board", board: 1 }, columns: COLUMNS, finished: "sprint" };
  const d = () => {
    const m = mac();
    m.tasks.acme = snapshot({ boards: [OPS], tasks: [], boardData: { ops: { keys: [], kind: "scrum", sprint: { id: 42, name: "Sprint 42", startMs: 0, endMs: 0 } } } });
    return { mac: m };
  };

  it("groups every workspace's boards, the shown board's workspace first, with their tasks, sessions and whether one needs the user", () => {
    const all = phoneBoards(hosts, d(), null);
    expect(switcher(all, "mac/personal/moon", "", d(), details)).toEqual([
      { name: "Personal", hint: "this workspace", rows: [{ key: "mac/personal/moon", mark: "L", name: "Moonlet", meta: "4 tasks · 3 sessions", needsYou: true, current: true }] },
      { name: "Acme", hint: "switches workspace", rows: [{ key: "mac/acme/ops", mark: "J", name: "OPS · Sprint 42", meta: "0 issues · no sessions", needsYou: false, current: false }] },
    ]);
  });

  it("finds a board by its name or its workspace's", () => {
    const all = phoneBoards(hosts, d(), null);
    expect(switcher(all, "mac/personal/moon", "ops", d(), details).map((g) => g.rows.map((r) => r.name))).toEqual([["OPS · Sprint 42"]]);
    expect(switcher(all, "mac/personal/moon", "acme", d(), details).map((g) => g.name)).toEqual(["Acme"]);
  });
});
