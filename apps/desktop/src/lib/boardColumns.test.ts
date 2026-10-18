import { describe, expect, it } from "vitest";
import { boardSubtitle, boardView, categorize, placeOnBoards, statusFor, switcherGroups } from "./boardColumns";
import type { BoardConfig } from "./boards";
import type { BoardColumn } from "./boards";
import type { PullRequest } from "./protocol";
import type { Task } from "./tasks";
import type { BoardSession } from "./tasksBoard";

// The OPS board of the "Tasks mode · Jira board" design, with Jira's status
// ids: Backlog hidden, Ready for Release and Done folded.
const OPS: BoardColumn[] = [
  { name: "Backlog", statuses: ["10000"], category: "todo", show: "hide" },
  { name: "To Do", statuses: ["10001"], category: "todo" },
  { name: "In Progress", statuses: ["3"], category: "in_progress", wip: 3 },
  { name: "Code Review", statuses: ["10018", "10019"], category: "in_review", wip: 2 },
  { name: "QA", statuses: ["10020"], category: "in_review" },
  { name: "Ready for Release", statuses: ["10021"], category: "in_review", show: "fold" },
  { name: "Done", statuses: ["10002"], category: "done", show: "fold" },
];

const jira = (key: string, statusId: string): Task => ({
  connection: "jira:acme.atlassian.net",
  key,
  title: key,
  url: "",
  column: "todo",
  priority: 0,
  assignees: [],
  labels: [],
  description: "",
  updatedMs: 0,
  tracker: { id: key, state: "", statusId, source: "OPS" },
});
const pr = (number: number, state: string): PullRequest => ({ number, url: "", state, title: "", checks: [], review_decision: null });
const session = (name: string, branch: string, o: Partial<BoardSession> = {}): BoardSession => ({
  id: name,
  name,
  branch,
  path: `/w/${branch}`,
  archived: false,
  task: null,
  task_unlinked: false,
  state: "idle",
  pr: null,
  additions: 0,
  subagents: 0,
  originRepo: "acme/ops",
  ...o,
});
const view = (tasks: Task[], sessions: BoardSession[] = []) => boardView(OPS, { tasks, sessions, worktrees: [], sessionStartRule: "auto" });

describe("boardView (X50 Board)", () => {
  it("draws the tracker's columns in the board's order, folded ones as such, hidden ones not at all", () => {
    const columns = view([jira("OPS-512", "10001"), jira("OPS-498", "3"), jira("OPS-487", "10018"), jira("OPS-476", "10020"), jira("OPS-470", "10002"), jira("OPS-400", "10000"), jira("OPS-1", "99999")]);
    expect(columns.map((c) => [c.name, c.category, c.folded, c.cards.map((x) => x.task.key)])).toEqual([
      ["To Do", "todo", false, ["OPS-512"]],
      ["In Progress", "in_progress", false, ["OPS-498"]],
      ["Code Review", "in_review", false, ["OPS-487"]],
      ["QA", "in_review", false, ["OPS-476"]],
      ["Ready for Release", "in_review", true, []],
      ["Done", "done", true, ["OPS-470"]],
    ]);
  });

  it("shows a Jira column's WIP limit, full at the limit", () => {
    const columns = view([jira("OPS-498", "3"), jira("OPS-487", "10018"), jira("OPS-490", "10019"), jira("OPS-476", "10020")]);
    expect(columns.slice(1, 4).map((c) => [c.name, c.wip])).toEqual([
      ["In Progress", { count: 1, max: 3, full: false }],
      ["Code Review", { count: 2, max: 2, full: true }],
      ["QA", undefined],
    ]);
  });

  it("lays out 2000 issues with 60 sessions in under a second", () => {
    const tasks = Array.from({ length: 2000 }, (_, i) => jira(`OPS-${i + 1}`, ["10001", "3", "10018", "10020", "10002"][i % 5]));
    const sessions = Array.from({ length: 60 }, (_, i) => session(`s${i}`, `ops-${i * 7 + 1}-work`, { pr: i % 3 ? null : pr(i, "merged") }));
    const started = performance.now();
    const columns = view(tasks, sessions);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(columns.reduce((n, c) => n + c.cards.length, 0)).toBe(2000);
  });

  describe("out of sync on a board", () => {
    const drift = (columns: ReturnType<typeof view>, key: string) => {
      const card = columns.flatMap((c) => c.cards).find((c) => c.task.key === key);
      if (!card) throw new Error(`${key} is not on the board`);
      return card.drift ? [card.drift.text, card.drift.fix] : null;
    };

    it("expects a merged PR in any In review column of a board with several", () => {
      const cols = view([jira("OPS-476", "10020"), jira("OPS-487", "10018")], [
        session("Status API limits", "ops-476-limits", { pr: pr(301, "merged") }),
        session("Billing queues", "ops-487-billing", { pr: pr(311, "merged") }),
      ]);
      expect([drift(cols, "OPS-476"), drift(cols, "OPS-487")]).toEqual([null, null]);
    });

    it("names each fix after the next column and moves there", () => {
      const cols = view([jira("OPS-498", "3"), jira("OPS-512", "10001"), jira("OPS-505", "3")], [
        session("EventBridge migration", "ops-498-eventbridge", { pr: pr(320, "merged") }),
        session("Rotate keys", "ops-512-rotate", { state: "working" }),
        session("Webhook retries", "ops-505-retries", { pr: pr(322, "open") }),
      ]);
      expect([drift(cols, "OPS-498"), drift(cols, "OPS-512"), drift(cols, "OPS-505")]).toEqual([
        ["#320 merged", "Move to Code Review"],
        ["Session running", "Move to In Progress"],
        ["#322 open", "Move to Code Review"],
      ]);
      const card = cols[1].cards.find((c) => c.task.key === "OPS-498");
      expect(card?.drift?.to).toEqual({ column: "Code Review", category: "in_review", statuses: ["10018", "10019"] });
    });

    it("moves a merged PR in To Do to the next column, a later category", () => {
      const cols = view([jira("OPS-512", "10001")], [session("Rotate keys", "ops-512-rotate", { pr: pr(330, "merged") })]);
      expect(drift(cols, "OPS-512")).toEqual(["#330 merged", "Move to In Progress"]);
    });

    it("has no fix when the next column is not a later category", () => {
      const board: BoardColumn[] = [
        { name: "To Do", statuses: ["10001"], category: "todo" },
        { name: "Selected for Development", statuses: ["10002"], category: "todo" },
        { name: "In Progress", statuses: ["3"], category: "in_progress" },
      ];
      const cols = boardView(board, { tasks: [jira("OPS-512", "10001")], sessions: [session("Rotate keys", "ops-512-rotate", { state: "working" })], worktrees: [], sessionStartRule: "auto" });
      expect(drift(cols, "OPS-512")).toEqual(["Session running", ""]);
      expect(cols[0].cards[0].drift?.to).toBeUndefined();
    });

    it("moves a merged PR from a board's only In review column to Done, and from In Progress to In Review", () => {
      // The "Tasks mode · Board" design's Linear board, by state name.
      const linear: BoardColumn[] = [
        { name: "Todo", statuses: ["Todo"], category: "todo" },
        { name: "In Progress", statuses: ["In Progress"], category: "in_progress" },
        { name: "In Review", statuses: ["In Review"], category: "in_review" },
        { name: "Done", statuses: ["Done"], category: "done", show: "fold" },
      ];
      // A Linear task keys on its state's name; an empty status id does not hide it.
      const task = (key: string, state: string): Task => ({ ...jira(key, ""), connection: "linear:1devstudio", tracker: { id: key, state, statusId: "", source: "MOON" } });
      const cols = boardView(linear, {
        tasks: [task("MOON-144", "In Review"), task("MOON-147", "In Progress")],
        sessions: [session("File tabs", "moon-144-file-tabs", { pr: pr(128, "merged") }), session("Block styling", "moon-147-blocks", { pr: pr(129, "merged") })],
        worktrees: [],
        sessionStartRule: "auto",
      });
      expect([drift(cols, "MOON-144"), drift(cols, "MOON-147")]).toEqual([
        ["#128 merged", "Move to Done"],
        ["#129 merged", "Move to In Review"],
      ]);
    });

    it("flags a GitHub repository issue only for a merged PR, closing it", () => {
      const repo: BoardColumn[] = [
        { name: "Open", statuses: ["open"], category: "todo" },
        { name: "Closed", statuses: ["completed"], category: "done", show: "fold" },
      ];
      const gh = (n: number): Task => ({ ...jira(`acme/web#${n}`, ""), connection: "github:github.com", column: "open", tracker: undefined, github: { repo: "acme/web", number: n, closingPrs: [] } });
      const cols = boardView(repo, {
        tasks: [gh(12), gh(15), gh(18)],
        sessions: [
          session("Checkout", "12-checkout", { state: "working", originRepo: "acme/web" }),
          session("Gift cards", "15-gift-cards", { pr: pr(40, "open"), originRepo: "acme/web" }),
          session("Orphans", "18-orphans", { pr: pr(41, "merged"), originRepo: "acme/web" }),
        ],
        worktrees: [],
        sessionStartRule: "auto",
      });
      expect(cols[0].cards.map((c) => c.task.key)).toEqual(["acme/web#12", "acme/web#15", "acme/web#18"]);
      expect([drift(cols, "acme/web#12"), drift(cols, "acme/web#15"), drift(cols, "acme/web#18")]).toEqual([null, null, ["#41 merged", "Move to Closed"]]);
    });
  });

  describe("boardSubtitle (X50 header)", () => {
    it("names the tracker, its site, the sprint's dates and the counts, Jira counting issues", () => {
      const sprint = { startMs: new Date(2026, 9, 9).getTime(), endMs: new Date(2026, 9, 23).getTime() };
      expect(boardSubtitle("jira:acme.atlassian.net", "acme.atlassian.net", sprint, 12, 5)).toBe("Jira · acme.atlassian.net · Oct 9 – Oct 23 · 12 issues · 5 sessions");
      expect(boardSubtitle("linear:1devstudio", "1devstudio", null, 1, 1)).toBe("Linear · 1devstudio · 1 task · 1 session");
      expect(boardSubtitle("github:github.com", "acme/web", null, 0, 0)).toBe("GitHub · acme/web · 0 tasks · 0 sessions");
    });
  });

  describe("switcherGroups (X50 board switcher)", () => {
    const b = (id: string, name: string, workspace: string, origin: BoardConfig["origin"], columns: BoardColumn[] = []): BoardConfig => ({
      id,
      name,
      connection: origin.kind.startsWith("jira") || origin.kind === "jql" ? "jira:acme.atlassian.net" : origin.kind.startsWith("github") ? "github:github.com" : "linear:1devstudio",
      workspace,
      origin,
      finished: 14,
      columns,
    });
    const boards = [
      b("moon", "Moonlet", "local/1dev", { kind: "linear_team", team: "MOON" }),
      b("ops", "OPS · Sprint board", "local/acme", { kind: "jira_board", board: 7 }, OPS),
      b("web", "acme/web", "local/acme", { kind: "github_repo", repo: "acme/web" }),
    ];
    const names = { "local/1dev": "1devstudio", "local/acme": "Acme" };

    it("lists this workspace's boards first, then the others', with their columns and live counts", () => {
      const groups = switcherGroups(boards, "local/acme", "", names, { ops: { tasks: 12, sessions: 5, state: "blocked", kind: "Scrum" } });
      expect(groups.map((g) => [g.name, g.hint, g.rows.map((r) => [r.board.id, r.kind, r.bars, r.meta, r.sessions])])).toEqual([
        [
          "Acme",
          "this workspace",
          [
            ["ops", "Scrum", ["todo", "in_progress", "in_review", "in_review", "in_review", "done"], "6 columns · 12 issues", { text: "5 sessions", state: "blocked" }],
            ["web", "Repository", [], "", null],
          ],
        ],
        ["1devstudio", "switches workspace", [["moon", "Team", [], "", null]]],
      ]);
    });

    it("finds a board by its name, its key or its workspace", () => {
      const ids = (q: string) => switcherGroups(boards, "local/acme", q, names, {}).flatMap((g) => g.rows.map((r) => r.board.id));
      expect([ids("sprint"), ids("moon"), ids("ACME"), ids("acme/web"), ids("nothing")]).toEqual([["ops"], ["moon"], ["ops", "web"], ["web"], []]);
    });
  });

  describe("categorize (X50 a task's state is its board column's category)", () => {
    it("gives a tracker task its column's category, hides one in no column or a hidden one, and leaves GitHub issues as they are", () => {
      const gh: Task = { ...jira("acme/web#12", ""), connection: "github:github.com", column: "open", tracker: undefined, github: { repo: "acme/web", number: 12, closingPrs: [] } };
      const tasks = [jira("OPS-487", "10018"), jira("OPS-1", "10000"), jira("OPS-2", "99999"), { ...jira("OPS-3", "10020"), column: "in_progress" as const }, gh];
      expect(categorize(OPS, tasks).map((t) => [t.key, t.column])).toEqual([
        ["OPS-487", "in_review"],
        ["OPS-1", "hidden"],
        ["OPS-2", "hidden"],
        ["OPS-3", "in_review"],
        ["acme/web#12", "open"],
      ]);
    });
  });

  describe("statusFor (X50 Keep in step's moves on a board)", () => {
    it("is the first status of the first shown or folded column of that category", () => {
      expect([statusFor(OPS, "in_review"), statusFor(OPS, "done"), statusFor(OPS, "todo")]).toEqual(["10018", "10002", "10001"]);
      expect(statusFor([], "done")).toBeNull();
    });
  });

  describe("placeOnBoards (X50 the board's columns as saved now)", () => {
    it("places each task by the columns of the board it came from, so a changed mapping shows without a sync", () => {
      const board = { id: "ops", name: "OPS", connection: "jira:acme.atlassian.net", workspace: "local/w", origin: { kind: "jira_board" as const, board: 10 }, columns: OPS };
      const tasks = [{ ...jira("OPS-476", "10020"), column: "in_progress" as const }, jira("OPS-9", "10020")];
      expect(placeOnBoards(tasks, { ops: { keys: ["jira:acme.atlassian.net OPS-476"], sprint: null } }, [board]).map((t) => [t.key, t.column])).toEqual([
        ["OPS-476", "in_review"],
        ["OPS-9", "todo"],
      ]);
    });
  });

  describe("mapCards and WIP (X50)", () => {
    it("counts the WIP of the cards a filter leaves", async () => {
      const { mapCards } = await import("./boardScreen");
      const columns = view([jira("OPS-487", "10018"), jira("OPS-490", "10019")]);
      const filtered = mapCards(columns, (c) => (c.task.key === "OPS-487" ? c : null));
      expect(filtered.find((c) => c.name === "Code Review")?.wip).toEqual({ count: 1, max: 2, full: false });
    });
  });
});
