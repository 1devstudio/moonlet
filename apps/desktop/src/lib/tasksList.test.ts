import { describe, expect, it } from "vitest";
import type { PullRequest } from "./protocol";
import type { Task } from "./tasks";
import { type BoardSession, tasksBoard } from "./tasksBoard";
import { listGroups, listRow } from "./tasksList";

const task = (key: string, column: Task["column"], updatedMs = 0): Task => ({
  connection: "linear:acme",
  key,
  title: key,
  url: "",
  column,
  priority: 0,
  assignees: [],
  labels: [],
  description: "",
  updatedMs,
});
const pr = (number: number, state: string, failing = 0): PullRequest => ({
  number,
  url: "",
  state,
  title: "",
  review_decision: null,
  checks: [
    ...Array.from({ length: 7 - failing }, (_, i) => ({ name: `ok${i}`, status: "completed", conclusion: "success", url: null })),
    ...Array.from({ length: failing }, (_, i) => ({ name: `bad${i}`, status: "completed", conclusion: "failure", url: null })),
  ],
});
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
  originRepo: null,
  ...o,
});
const board = tasksBoard({
  tasks: [
    task("MOON-151", "todo"),
    task("MOON-149", "todo"),
    task("MOON-142", "in_progress"),
    task("MOON-147", "in_progress"),
    task("MOON-139", "in_review"),
    task("MOON-144", "in_review"),
    task("MOON-136", "in_review"),
    task("MOON-131", "done"),
  ],
  sessions: [
    session("Remote hosts", "moon-142-hosts", { state: "working" }),
    session("Hosts spike", "moon-142-spike"),
    session("Block styling", "moon-147-blocks", { state: "blocked" }),
    session("Live upgrade", "moon-139-live", { state: "done", pr: pr(131, "open") }),
    session("File tabs", "moon-144-tabs", { pr: pr(128, "merged") }),
    session("Context meter", "moon-136-meter", { state: "working", pr: pr(124, "open", 2) }),
    session("Codex hooks", "moon-131-hooks", { pr: pr(119, "merged") }),
  ],
  worktrees: [{ path: "/w/moon-149-health", branch: "moon-149-health", originRepo: null }],
  sessionStartRule: "auto",
});

describe("Tasks list (X45 List)", () => {
  it("groups In Progress, In Review, Todo and Done, with a note on what needs attention", () => {
    expect(listGroups(board).map((g) => [g.name, g.cards.length, g.note])).toEqual([
      ["In Progress", 2, "1 needs you"],
      ["In Review", 3, "1 out of sync"],
      ["Todo", 2, ""],
      ["Done", 1, "1 needs clean-up"],
    ]);
  });

  it("notes both what needs you and what is out of sync, in any group", () => {
    const b = tasksBoard({
      tasks: [task("MOON-153", "todo"), task("MOON-160", "in_review")],
      sessions: [session("Guard", "moon-153-guard", { state: "working" }), session("Review fixes", "moon-160-fixes", { state: "blocked" })],
      worktrees: [],
      sessionStartRule: "suggest",
    });
    expect(listGroups(b).map((g) => [g.name, g.note, g.noteTone])).toEqual([
      ["In Progress", "", "faint"],
      ["In Review", "1 needs you", "blocked"],
      ["Todo", "1 out of sync", "accent"],
      ["Done", "", "faint"],
    ]);
  });

  it("sums up each task's sessions, PR and worktrees in its row", () => {
    const rows = Object.fromEntries(listGroups(board).flatMap((g) => g.cards.map((c) => [c.task.key, listRow(c)])));
    expect(rows["MOON-142"]).toEqual({ glyphs: ["working", "idle"], sum: "1 working", sumTone: "faint", pr: "no PR", prTone: "faint", worktrees: 2, needsYou: false, chip: null, updated: "" });
    expect(rows["MOON-147"]).toMatchObject({ sum: "needs you", sumTone: "blocked", needsYou: true });
    expect(rows["MOON-139"]).toMatchObject({ sum: "1 session", pr: "#131 · 7/7 ✓", prTone: "open" });
    expect(rows["MOON-144"]).toMatchObject({ pr: "#128 merged", prTone: "merged" });
    expect(rows["MOON-136"]).toMatchObject({ pr: "#124 · 2 failing", prTone: "error" });
    expect(rows["MOON-149"]).toMatchObject({ glyphs: [], sum: "1 worktree", worktrees: 1 });
    expect(rows["MOON-151"]).toMatchObject({ sum: "none", worktrees: 0 });
  });
});

describe("a group with both notes (X45 List)", () => {
  it("joins them", () => {
    const b = tasksBoard({
      tasks: [task("MOON-170", "todo"), task("MOON-171", "todo")],
      sessions: [session("Waiting", "moon-170-wait", { state: "blocked" }), session("Guard", "moon-171-guard", { state: "working" })],
      worktrees: [],
      sessionStartRule: "suggest",
    });
    expect(listGroups(b).find((g) => g.name === "Todo")).toMatchObject({ note: "1 needs you · 2 out of sync", noteTone: "blocked" });
  });
});

describe("a row's chip and updated time (X45 List)", () => {
  it("shows the Out of sync chip with its fix, and how long ago the task changed", () => {
    const b = tasksBoard({
      tasks: [task("MOON-153", "todo", 1_000)],
      sessions: [session("Guard", "moon-153-guard", { state: "working" })],
      worktrees: [],
      sessionStartRule: "suggest",
    });
    expect(listRow(b.todo[0], 1_000 + 5 * 60_000)).toMatchObject({ chip: "Session running · In Progress", updated: "5 min ago" });
    expect(listRow(b.todo[0], 1_000 + 3 * 3_600_000).updated).toBe("3 h ago");
  });
});
