import { describe, expect, it } from "vitest";
import { appendActivity, enterOpensFirst, findTasks, glyphShape, initials, sessionCard, stateOptions } from "./taskDetails";
import type { Task } from "./tasks";
import { tasksBoard } from "./tasksBoard";

const task = (key: string, title: string, o: Partial<Task> = {}): Task => ({
  connection: "linear:acme",
  key,
  title,
  url: "",
  column: "todo",
  priority: 0,
  assignees: [],
  labels: [],
  description: "",
  updatedMs: 0,
  ...o,
});

describe("initials (X45 card)", () => {
  it("takes the first letters of the first and last name", () => {
    expect(["Sam Rivera", "ada", "Mia van der Krystof", "  "].map(initials)).toEqual(["SR", "A", "MK", ""]);
  });
});

describe("stateOptions (X45 detail, X46 task bar)", () => {
  it("offers a tracker issue the four columns, and a GitHub issue open or closed", () => {
    expect(stateOptions(task("MOON-1", "x", { column: "in_progress" }))).toEqual([
      { label: "Todo", column: "todo", current: false },
      { label: "In Progress", column: "in_progress", current: true },
      { label: "In Review", column: "in_review", current: false },
      { label: "Done", column: "done", current: false },
    ]);
    const gh = task("acme/web#7", "x", { connection: "github:github.com", column: "open", github: { repo: "acme/web", number: 7, closingPrs: [] } });
    expect(stateOptions(gh)).toEqual([
      { label: "Open", column: null, current: true },
      { label: "Closed", column: "done", current: false },
    ]);
  });
});

describe("findTasks (X45 Find a task)", () => {
  it("keeps the cards whose key or title has the text", () => {
    const board = tasksBoard({ tasks: [task("MOON-142", "Remote hosts sidebar"), task("MOON-144", "File tabs")], sessions: [], worktrees: [], sessionStartRule: "auto" });
    const keys = (q: string) => Object.values(findTasks(board, q)).flat().map((c) => c.task.key);
    expect(keys("tabs")).toEqual(["MOON-144"]);
    expect(keys("moon-142")).toEqual(["MOON-142"]);
    expect(keys("")).toEqual(["MOON-142", "MOON-144"]);
  });
});

describe("appendActivity (X45 activity)", () => {
  it("keeps the newest entries first, at most 20", () => {
    const list = Array.from({ length: 20 }, (_, i) => ({ at: i, text: `e${i}` })).reverse();
    const next = appendActivity(list, { at: 99, text: "Moved to In Review" });
    expect(next.length).toBe(20);
    expect(next[0]).toEqual({ at: 99, text: "Moved to In Review" });
    expect(next[19].text).toBe("e1");
  });
});

describe("glyphShape (X45: task state by shape)", () => {
  it("is an empty ring for Todo, half for In Progress, three quarters for In Review and a filled check for Done", () => {
    expect((["todo", "in_progress", "in_review", "done"] as const).map(glyphShape)).toEqual(["ring", "half", "three-quarters", "check"]);
  });
});

describe("sessionCard (X45 detail: a session's card)", () => {
  const base = { id: "s1", name: "Remote hosts", branch: "moon-142-hosts", path: "/w/moon-142-hosts", archived: false, task: null, task_unlinked: false, state: "working" as const, pr: null, additions: 42, deletions: 7, subagents: 0, originRepo: null };
  const check = (conclusion: string | null) => ({ name: "ci", url: "", status: conclusion ? "completed" : "in_progress", conclusion });
  it("names where it works, its diff, each agent with its state and time, and its PR", () => {
    const card = sessionCard({ ...base, agents: [{ name: "claude", state: "working", since: 1_000 }], pr: { number: 131, url: "", state: "open", title: "", checks: [check("success"), check("success"), check("failure")], review_decision: "APPROVED" } }, "web", 121_000);
    expect(card).toEqual({
      where: "web/moon-142-hosts",
      diff: "+42 −7",
      agents: ["claude · working · 2 min"],
      pr: "#131 open · 2/3 checks · approved",
    });
  });

  it("offers Create PR when there is none, and leaves out an empty diff", () => {
    expect(sessionCard({ ...base, additions: 0, deletions: 0, agents: [] }, "web", 0)).toEqual({ where: "web/moon-142-hosts", diff: "", agents: [], pr: "No pull request · Create PR ⇧⌘P" });
  });
});

describe("enterOpensFirst (X45 detail: ↵ opens the first session)", () => {
  it("is ↵ outside a field or button", () => {
    expect(enterOpensFirst({ key: "Enter", tagName: "BODY", isContentEditable: false })).toBe(true);
    expect(enterOpensFirst({ key: "Enter", tagName: "INPUT", isContentEditable: false })).toBe(false);
    expect(enterOpensFirst({ key: "Enter", tagName: "BUTTON", isContentEditable: false })).toBe(false);
    expect(enterOpensFirst({ key: "Enter", tagName: "DIV", isContentEditable: true })).toBe(false);
    expect(enterOpensFirst({ key: "a", tagName: "BODY", isContentEditable: false })).toBe(false);
  });

  it("leaves ↵ alone with a modifier, once something handled it, or with a dialog or Settings over Tasks mode", () => {
    const plain = { key: "Enter", tagName: "BODY", isContentEditable: false };
    expect(enterOpensFirst({ ...plain, modifier: true })).toBe(false);
    expect(enterOpensFirst({ ...plain, defaultPrevented: true })).toBe(false);
    expect(enterOpensFirst({ ...plain, covered: true })).toBe(false);
  });
});
