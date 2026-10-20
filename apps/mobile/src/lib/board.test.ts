import { describe, expect, it } from "vitest";
import type { BoardColumn, BoardConfig } from "@desktop/lib/boards";
import { DEFAULT_RULES } from "@desktop/lib/keepInStep";
import type { Task } from "@desktop/lib/tasks";
import type { TaskSnapshot } from "@desktop/lib/taskSnapshot";
import type { PullRequest } from "@desktop/lib/protocol";
import { boardScreen, firstColumn, phoneBoards, staleLine, switcher } from "./board";
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

describe("phoneBoards (X57)", () => {
  it("lists the boards of the shown workspace on connected hosts, every workspace's with none shown", () => {
    const d = { mac: mac() };
    expect(phoneBoards(hosts, d, "Personal").map((b) => [b.key, b.board.name, b.workspaceName])).toEqual([["mac/personal/moon", "Moonlet", "Personal"]]);
    expect(phoneBoards(hosts, d, "Acme")).toEqual([]);
    expect(phoneBoards(hosts, d, null)).toHaveLength(1);
    expect(phoneBoards({ mac: { ...hosts.mac, status: "reconnecting" as const } }, d, null)).toEqual([]);
  });
});

describe("boardScreen (X57)", () => {
  const screen = () => {
    const [b] = phoneBoards(hosts, { mac: mac() }, "Personal");
    return boardScreen(b, mac(), details, {}, NOW);
  };

  it("heads the board as the Mac does", () => {
    expect(screen().title).toBe("Moonlet");
    expect(screen().subtitle).toBe("Linear · acme · 4 tasks · 3 sessions");
  });

  it("has a tab per shown column with its count, and a dot where a session needs the user or a card is out of sync", () => {
    expect(screen().columns.map((c) => [c.name, c.count, c.dot, c.folded])).toEqual([
      ["Todo", 1, null, false],
      ["In Progress", 2, "blocked", false],
      ["In Review", 1, "drift", false],
      ["Done", 0, null, true],
    ]);
    expect(firstColumn(screen().columns)).toBe("In Progress");
  });

  it("puts on each card its key, priority, assignee, card line and live sessions, and an out-of-sync fix", () => {
    const progress = screen().columns.find((c) => c.name === "In Progress")!;
    expect(progress.cards.map((c) => [c.key, c.title, c.priority, c.initials, c.line, c.needsYou, c.rows.map((r) => [r.name, r.state, r.meta.text])])).toEqual([
      ["MOON-142", "Remote hosts sidebar", 3, "SR", "MOON-120 Hosts", false, [["Remote hosts sidebar", "working", "◑ 5"]]],
      ["MOON-147", "Block styling pass", 2, "SR", null, true, [["Block styling pass", "blocked", "needs you"]]],
    ]);
    const review = screen().columns.find((c) => c.name === "In Review")!;
    expect(review.cards[0].drift).toEqual({ text: "#128 merged", fix: "Move to Done", to: "Done" });
    const todo = screen().columns.find((c) => c.name === "Todo")!;
    expect([todo.cards[0].initials, todo.cards[0].rows, todo.cards[0].empty]).toEqual([null, [], "No sessions"]);
  });

  it("shows a move the phone asked for at once, in its new column", () => {
    const [b] = phoneBoards(hosts, { mac: mac() }, "Personal");
    const moved = boardScreen(b, mac(), details, { [`${LINEAR} MOON-151`]: { status: "s-progress", name: "In Progress" } }, NOW);
    expect(moved.columns.map((c) => [c.name, c.count])).toEqual([
      ["Todo", 0],
      ["In Progress", 3],
      ["In Review", 1],
      ["Done", 0],
    ]);
  });
});

describe("staleLine (X57)", () => {
  it("says when the board was synced on the Mac, once it is over 15 minutes old", () => {
    expect(staleLine(snapshot({ syncedAt: NOW - 5 * MIN }), NOW)).toBeNull();
    expect(staleLine(snapshot({ syncedAt: NOW - 20 * MIN }), NOW)).toBe("Synced 20 min ago on studio. Open moonlet on the Mac to sync.");
    expect(staleLine(snapshot({ syncedAt: NOW - 3 * 60 * MIN }), NOW)).toBe("Synced 3 h ago on studio. Open moonlet on the Mac to sync.");
    expect(staleLine(snapshot({ syncedAt: null }), NOW)).toBe("Not synced yet on studio. Open moonlet on the Mac to sync.");
  });
});

describe("switcher (X57)", () => {
  const OPS: BoardConfig = { id: "ops", name: "OPS", connection: "jira:acme.atlassian.net", workspace: "local/acme", origin: { kind: "jira_board", board: 1 }, columns: COLUMNS, finished: "sprint" };
  const d = () => {
    const m = mac();
    m.tasks.acme = snapshot({ boards: [OPS], tasks: [], boardData: { ops: { keys: [], kind: "scrum", sprint: { id: 42, name: "Sprint 42", startMs: 0, endMs: 0 } } } });
    return { mac: m };
  };

  it("groups every workspace's boards, the shown board's workspace first, with their tasks, sessions and whether one needs the user", () => {
    const all = phoneBoards(hosts, d(), null);
    expect(switcher(all, "mac/personal/moon", "", d(), details, NOW)).toEqual([
      { name: "Personal", hint: "this workspace", rows: [{ key: "mac/personal/moon", mark: "L", name: "Moonlet", meta: "4 tasks · 3 sessions", needsYou: true, current: true }] },
      { name: "Acme", hint: "switches workspace", rows: [{ key: "mac/acme/ops", mark: "J", name: "OPS · Sprint 42", meta: "0 issues · no sessions", needsYou: false, current: false }] },
    ]);
  });

  it("finds a board by its name or its workspace's", () => {
    const all = phoneBoards(hosts, d(), null);
    expect(switcher(all, "mac/personal/moon", "ops", d(), details, NOW).map((g) => g.rows.map((r) => r.name))).toEqual([["OPS · Sprint 42"]]);
    expect(switcher(all, "mac/personal/moon", "acme", d(), details, NOW).map((g) => g.name)).toEqual(["Acme"]);
  });
});
