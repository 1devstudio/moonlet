import { describe, expect, it } from "vitest";
import type { PullRequest } from "./protocol";
import type { Task } from "./tasks";
import { type BoardSession, outOfSync, sessionsWithoutTask, tasksBoard } from "./tasksBoard";

const task = (key: string, column: Task["column"], extra: Partial<Task> = {}): Task => ({
  connection: "linear:acme",
  key,
  title: key,
  url: "",
  column,
  priority: 0,
  assignees: [],
  labels: [],
  description: "",
  updatedMs: 0,
  ...extra,
});
const gh = (n: number, closingPrs: number[] = []) =>
  task(`acme/web#${n}`, "open", { connection: "github:github.com", github: { repo: "acme/web", number: n, closingPrs } });
const pr = (number: number, state: string, checks: PullRequest["checks"] = []): PullRequest => ({
  number,
  url: "",
  state,
  title: "",
  checks,
  review_decision: null,
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
  originRepo: "acme/web",
  ...o,
});
const keysIn = (cards: { task: Task }[]) => cards.map((c) => c.task.key);

describe("tasksBoard columns (X45)", () => {
  it("places tracker tasks by their column and leaves out hidden ones", () => {
    const b = tasksBoard({
      tasks: [task("MOON-151", "todo"), task("MOON-142", "in_progress"), task("MOON-139", "in_review"), task("MOON-1", "hidden"), task("MOON-2", "done")],
      sessions: [],
      worktrees: [],
      sessionStartRule: "auto",
    });
    expect([keysIn(b.todo), keysIn(b.in_progress), keysIn(b.in_review), keysIn(b.done)]).toEqual([
      ["MOON-151"],
      ["MOON-142"],
      ["MOON-139"],
      ["MOON-2"],
    ]);
  });

  it("places an open GitHub issue by its work: no session Todo, a session In Progress, an open PR In Review", () => {
    const b = tasksBoard({
      tasks: [gh(1), gh(2), gh(3)],
      sessions: [session("Two", "2-two"), session("Three", "3-three", { pr: pr(30, "open") })],
      worktrees: [],
      sessionStartRule: "auto",
    });
    expect([keysIn(b.todo), keysIn(b.in_progress), keysIn(b.in_review)]).toEqual([["acme/web#1"], ["acme/web#2"], ["acme/web#3"]]);
  });
});

describe("card rows (X45)", () => {
  const card = (s: BoardSession) =>
    tasksBoard({ tasks: [task("MOON-142", "in_progress")], sessions: [s], worktrees: [], sessionStartRule: "auto" }).in_progress[0];
  const meta = (o: Partial<BoardSession>) => card(session("Remote hosts sidebar", "moon-142-hosts", o)).rows[0].meta;
  const failed = [{ name: "test", status: "completed", conclusion: "failure", url: null }];
  const passed = [{ name: "test", status: "completed", conclusion: "success", url: null }];

  it("shows the most useful fact about each session, first match wins", () => {
    expect(meta({ state: "blocked", pr: pr(131, "open"), subagents: 5 })).toEqual({ text: "needs you", tone: "blocked" });
    expect(meta({ pr: pr(131, "open", passed), subagents: 5 })).toEqual({ text: "#131", tone: "open" });
    expect(meta({ pr: pr(128, "merged") })).toEqual({ text: "#128 merged", tone: "merged" });
    expect(meta({ state: "working", pr: pr(124, "open", failed) })).toEqual({ text: "#124 ✕", tone: "error" });
    expect(meta({ state: "working", subagents: 5, additions: 412 })).toEqual({ text: "◑ 5", tone: "muted" });
    expect(meta({ additions: 46 })).toEqual({ text: "+46", tone: "faint" });
  });

  it("outlines a card when a session needs the user", () => {
    expect(card(session("A", "moon-142-a", { state: "blocked" })).needsYou).toBe(true);
    expect(card(session("A", "moon-142-a", { state: "working" })).needsYou).toBe(false);
  });
});

describe("worktrees without a session (X45)", () => {
  const wt = (branch: string | null, path = `/w/${branch}`) => ({ path, branch, originRepo: "acme/web" });

  it("puts a worktree whose branch carries the key, and that no session uses, on its task", () => {
    const b = tasksBoard({
      tasks: [task("MOON-149", "todo"), task("MOON-142", "in_progress"), gh(7)],
      sessions: [session("Remote hosts sidebar", "moon-142-remote-hosts")],
      worktrees: [wt("moon-149-host-health"), wt("moon-142-remote-hosts"), wt("moon-142-ssh-test"), wt(null, "/w/detached"), wt("7-fix")],
      sessionStartRule: "auto",
    });
    const card = (key: string) => Object.values(b).flat().find((c) => c.task.key === key);
    expect(card("MOON-149")?.orphans.map((w) => w.branch)).toEqual(["moon-149-host-health"]);
    expect(card("MOON-142")?.orphans.map((w) => w.branch)).toEqual(["moon-142-ssh-test"]);
    expect(card("acme/web#7")?.orphans.map((w) => w.branch)).toEqual(["7-fix"]);
    expect(card("MOON-149")?.empty).toBe("1 worktree, no session");
    expect(card("MOON-142")?.empty).toBe(null);
  });

  it("says No sessions when nothing works on the task", () => {
    const b = tasksBoard({ tasks: [task("MOON-151", "todo")], sessions: [], worktrees: [], sessionStartRule: "auto" });
    expect(b.todo[0].empty).toBe("No sessions");
  });
});

describe("out of sync (X45)", () => {
  const only = (t: Task, sessions: BoardSession[], rule: "auto" | "suggest" | "off" = "auto", worktrees: { path: string; branch: string; originRepo: string }[] = []) =>
    Object.values(tasksBoard({ tasks: [t], sessions, worktrees, sessionStartRule: rule })).flat()[0];

  it("PR merged: every session's PR is merged and the task is not Done", () => {
    expect(only(task("MOON-144", "in_review"), [session("File tabs", "moon-144-tabs", { pr: pr(128, "merged") })]).drift).toEqual({
      kind: "merged",
      text: "#128 merged",
      fix: "Move to Done",
    });
    const mixed = [session("A", "moon-144-a", { pr: pr(128, "merged") }), session("B", "moon-144-b", { pr: pr(129, "open") })];
    expect(only(task("MOON-144", "in_review"), mixed).drift).toBe(null);
    expect(only(gh(7), [session("Fix", "7-fix", { pr: pr(70, "merged") })]).drift?.fix).toBe("Move to Done");
  });

  it("work started: a Todo task has a session, unless starting a session moves it automatically", () => {
    const running = [session("Force-push guard", "moon-153-guard", { state: "working" })];
    expect(only(task("MOON-153", "todo"), running, "suggest").drift).toEqual({ kind: "started", text: "Session running", fix: "In Progress" });
    expect(only(task("MOON-153", "todo"), running, "off").drift?.kind).toBe("started");
    expect(only(task("MOON-153", "todo"), running, "auto").drift).toBe(null);
  });

  it("PR open: a tracker issue not yet In Review has a session with an open PR", () => {
    const open = [session("Hosts", "moon-142-hosts", { pr: pr(131, "open") })];
    expect(only(task("MOON-142", "in_progress"), open).drift).toEqual({ kind: "pr_open", text: "#131 open", fix: "Move to In Review" });
    expect(only(task("MOON-142", "in_review"), open).drift).toBe(null);
    // A GitHub issue's column already follows its PR.
    expect(only(gh(7), [session("Fix", "7-fix", { pr: pr(70, "open") })]).drift).toBe(null);
  });

  it("done, still open: a Done task still has sessions or worktrees", () => {
    const left = [session("Codex hooks", "moon-131-hooks", { pr: pr(119, "merged") })];
    expect(only(task("MOON-131", "done"), left).drift).toEqual({ kind: "done_open", text: "1 session, 1 worktree", fix: "Clean up" });
    const orphan = [{ path: "/w/moon-131-old", branch: "moon-131-old", originRepo: "acme/web" }];
    expect(only(task("MOON-131", "done"), [], "auto", orphan).drift?.text).toBe("1 worktree");
    expect(only(task("MOON-131", "done"), left, "auto", orphan).drift?.text).toBe("1 session, 2 worktrees");
    expect(only(task("MOON-131", "done"), []).drift).toBe(null);
  });
});

describe("sessions without a task (X45 list)", () => {
  it("lists live sessions no task claims, with a hint when the name looks like a task title", () => {
    const tasks = [task("CDK-41", "todo", { title: "Changelog themes" }), task("CDK-38", "in_progress", { title: "Retry Notion sync" })];
    const sessions = [
      session("Changelog themes", "themes"),
      session("zsh startup profiling", "zsh-perf"),
      session("Notion sync retries", "cdk-38-notion-retries"),
      session("Old", "old", { archived: true }),
      session("Unlinked by hand", "cdk-38-x", { task_unlinked: true }),
    ];
    expect(sessionsWithoutTask(sessions, tasks).map((u) => [u.session.name, u.hint])).toEqual([
      ["Changelog themes", "Looks like CDK-41 Changelog themes"],
      ["zsh startup profiling", "No matching issue"],
      ["Unlinked by hand", "No matching issue"],
    ]);
  });
});

describe("link rules on the board (X44)", () => {
  it("suggests by title only with the title rule on, and links by branch only with the branch rule on", () => {
    const tasks = [task("CDK-41", "todo", { title: "Changelog themes" })];
    const off = { branch: false, pr: true, title: false };
    expect(sessionsWithoutTask([session("Changelog themes", "themes")], tasks, off).map((u) => u.hint)).toEqual([""]);
    const b = tasksBoard({ tasks, sessions: [session("Themes", "cdk-41-themes")], worktrees: [], sessionStartRule: "auto", link: off });
    expect(b.todo[0].rows).toEqual([]);
  });
});

describe("outOfSync", () => {
  it("counts the cards with a drift chip, for the Tasks button and its view", () => {
    const b = tasksBoard({
      tasks: [task("MOON-144", "in_review"), task("MOON-142", "in_progress")],
      sessions: [session("File tabs", "moon-144-tabs", { pr: pr(128, "merged") }), session("Hosts", "moon-142-hosts")],
      worktrees: [],
      sessionStartRule: "auto",
    });
    expect(outOfSync(b).map((c) => c.task.key)).toEqual(["MOON-144"]);
  });
});
