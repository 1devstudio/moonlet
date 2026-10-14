import { describe, expect, it } from "vitest";
import { applyRules, autoFixes, cleanUpMessage, removeWorktreeAsk, closesIssue, DEFAULT_RULES, driftFix, driftKey, outsideMoves, prComments, startAction, withCloses, withoutPutOff } from "./keepInStep";
import type { Task } from "./tasks";
import type { BoardSession, Card } from "./tasksBoard";

const task = (key: string, column: Task["column"], github?: Task["github"]): Task => ({
  connection: github ? "github:github.com" : "linear:acme",
  key,
  title: key,
  url: "",
  column,
  priority: 0,
  assignees: [],
  labels: [],
  description: "",
  updatedMs: 0,
  github,
});
const session = (id: string, path: string, pr: number | null = null): BoardSession => ({
  id,
  name: id,
  branch: id,
  path,
  archived: false,
  task: null,
  task_unlinked: false,
  state: "idle",
  pr: pr ? { number: pr, url: "", state: "merged", title: "", checks: [], review_decision: null } : null,
  additions: 0,
  subagents: 0,
  originRepo: "acme/web",
});
const card = (t: Task, drift: Card["drift"], sessions: BoardSession[] = [], orphans: Card["orphans"] = []): Card => ({
  task: t,
  column: "in_review",
  rows: sessions.map((s) => ({ session: s, meta: { text: "", tone: "faint" } })),
  needsYou: false,
  orphans,
  empty: null,
  drift,
});

describe("driftFix (X45 out of sync, X46 Keep in step)", () => {
  it("closes a GitHub issue as completed when every PR is merged", () => {
    const c = card(task("acme/web#7", "open", { repo: "acme/web", number: 7, closingPrs: [] }), { kind: "merged", text: "#70 merged", fix: "Move to Done" });
    expect(driftFix(c)).toEqual({ kind: "github", repo: "acme/web", number: 7, close: true });
  });

  it("moves a tracker issue to the drift's column", () => {
    expect(driftFix(card(task("MOON-144", "in_review"), { kind: "merged", text: "#128 merged", fix: "Move to Done" }))).toEqual({ kind: "move", column: "done" });
    expect(driftFix(card(task("MOON-153", "todo"), { kind: "started", text: "Session running", fix: "In Progress" }))).toEqual({ kind: "move", column: "in_progress" });
  });

  it("cleans up a done task's sessions and worktrees", () => {
    const c = card(task("MOON-131", "done"), { kind: "done_open", text: "1 session, 2 worktrees", fix: "Clean up" }, [session("hooks", "/w/hooks", 119)], [
      { path: "/w/old", branch: "moon-131-old", originRepo: null },
    ]);
    expect(driftFix(c)).toEqual({ kind: "clean_up", sessions: ["hooks"], worktrees: ["/w/old"] });
  });
});

describe("removeWorktreeAsk (X45: remove a worktree from a task)", () => {
  it("warns when uncommitted changes would be lost", () => {
    expect(removeWorktreeAsk("/w/moon-131-old", "moon-131-old", false)).toEqual({
      title: "Remove moon-131-old?",
      message: "The worktree at /w/moon-131-old goes; its branch is kept.",
      action: "Remove",
      variant: "primary",
    });
    expect(removeWorktreeAsk("/w/moon-131-old", "moon-131-old", true)).toMatchObject({
      message: "/w/moon-131-old has uncommitted changes, which will be lost. Its branch is kept.",
      variant: "danger",
    });
  });
});

describe("cleanUpMessage", () => {
  it("names what goes and warns about uncommitted changes", () => {
    expect(cleanUpMessage(1, 1, [])).toBe("Archive 1 session and remove 1 worktree?");
    expect(cleanUpMessage(2, 0, ["/w/hooks"])).toBe("Archive 2 sessions? /w/hooks has uncommitted changes, which will be lost.");
    expect(cleanUpMessage(0, 2, ["/w/a", "/w/b"])).toBe("Remove 2 worktrees? /w/a and /w/b have uncommitted changes, which will be lost.");
  });
});

describe("driftKey", () => {
  it("stays the same until the task or its sessions change, so Not now holds until then", () => {
    const merged = { kind: "merged" as const, text: "#128 merged", fix: "Move to Done" };
    const a = card(task("MOON-144", "in_review"), merged, [session("tabs", "/w/tabs", 128)]);
    expect(driftKey(a)).toBe(driftKey(card(task("MOON-144", "in_review"), merged, [session("tabs", "/w/tabs", 128)])));
    expect(driftKey(a)).not.toBe(driftKey(card(task("MOON-144", "in_review"), merged, [session("tabs", "/w/tabs", 128), session("more", "/w/more", 130)])));
  });
});

describe("startAction (the composer's checkbox)", () => {
  it("assigns a GitHub issue; moves and assigns a tracker issue from Todo; ticked when the rule is Automatically", () => {
    expect(startAction(task("acme/web#7", "open", { repo: "acme/web", number: 7, closingPrs: [] }), "auto")).toEqual({ label: "Assign acme/web#7 to me", checked: true });
    expect(startAction(task("MOON-151", "todo"), "suggest")).toEqual({ label: "Move MOON-151 to In Progress and assign it to me", checked: false });
    expect(startAction(task("MOON-151", "in_review"), "auto")).toBe(null);
    expect(startAction(task("MOON-151", "todo"), "off")).toBe(null);
  });
});

describe("withoutPutOff", () => {
  it("drops the chips put off with Not now, and only those", () => {
    const merged = { kind: "merged" as const, text: "#128 merged", fix: "Move to Done" };
    const a = card(task("MOON-144", "in_review"), merged, [session("tabs", "/w/tabs", 128)]);
    const b = card(task("MOON-139", "in_review"), merged, [session("live", "/w/live", 131)]);
    const board = { todo: [], in_progress: [], in_review: [a, b], done: [] };
    const out = withoutPutOff(board, { [driftKey(a)]: true });
    expect(out.in_review.map((c) => [c.task.key, c.drift?.text ?? null])).toEqual([["MOON-144", null], ["MOON-139", "#128 merged"]]);
  });
});

describe("Closes #N in a new PR (X46: a PR opens)", () => {
  const issue = task("acme/web#7", "open", { repo: "acme/web", number: 7, closingPrs: [] });
  const facts = (o: object) => ({ branch: "moonlet/x", task: null, task_unlinked: false, ...o });

  it("finds the GitHub issue the session works on, in the project's repository", () => {
    expect(closesIssue(facts({ branch: "7-fix" }), "acme/web", [issue])).toBe(7);
    expect(closesIssue(facts({ task: { connection: "github:github.com", key: "acme/web#9", url: "" } }), "acme/web", [])).toBe(9);
    expect(closesIssue(facts({ task: { connection: "github:github.com", key: "other/repo#9", url: "" } }), "acme/web", [])).toBe(null);
    expect(closesIssue(facts({ task: { connection: "linear:acme", key: "MOON-1", url: "" } }), "acme/web", [])).toBe(null);
    expect(closesIssue(facts({}), "acme/web", [issue])).toBe(null);
  });

  it("follows the link rules and the task's own comment rule", () => {
    const noBranch = { branch: false, pr: true, title: true };
    expect(closesIssue(facts({ branch: "7-fix" }), "acme/web", [issue], noBranch)).toBe(null);
    // The Task tab's Keep in step switch, or the rule set to Off.
    expect(closesIssue(facts({ branch: "7-fix" }), "acme/web", [issue], undefined, () => "off")).toBe(null);
    expect(closesIssue(facts({ branch: "7-fix" }), "acme/web", [issue], undefined, () => "suggest")).toBe(7);
  });

  it("adds the line once", () => {
    expect(withCloses("- Fix the button", 7)).toBe("- Fix the button\n\nCloses #7");
    expect(withCloses("", 7)).toBe("Closes #7");
    expect(withCloses("- Fix\n\nCloses #7", 7)).toBe("- Fix\n\nCloses #7");
    expect(withCloses("- Fix", null)).toBe("- Fix");
  });
});

describe("rules from Settings › Task trackers (X44, X46)", () => {
  const merged = { kind: "merged" as const, text: "#70 merged", fix: "Move to Done" };
  const doneOpen = { kind: "done_open" as const, text: "1 session, 1 worktree", fix: "Clean up" };
  const gh7 = card(task("acme/web#7", "open", { repo: "acme/web", number: 7, closingPrs: [] }), merged, [session("fix", "/w/fix", 70)]);
  const old = card(task("MOON-131", "done"), doneOpen, [session("hooks", "/w/hooks", 119)]);
  const board = { todo: [], in_progress: [gh7], in_review: [], done: [old] };

  it("drops a chip whose rule is Off", () => {
    const off = applyRules(board, () => ({ ...DEFAULT_RULES, all_merged: "off", issue_done: "off" }));
    expect(Object.values(off).flat().map((c) => c.drift)).toEqual([null, null]);
    const on = applyRules(board, () => DEFAULT_RULES);
    expect(Object.values(on).flat().map((c) => c.drift?.kind)).toEqual(["merged", "done_open"]);
  });

  it("drops the work-started chip too when its rule is Off, as the Keep in step switch does", () => {
    const started = card(task("MOON-153", "todo"), { kind: "started", text: "Session running", fix: "In Progress" }, [session("guard", "/w/guard")]);
    const b = { todo: [started], in_progress: [], in_review: [], done: [] };
    expect(applyRules(b, () => ({ ...DEFAULT_RULES, session_starts: "off" })).todo[0].drift).toBe(null);
    expect(applyRules(b, () => DEFAULT_RULES).todo[0].drift?.kind).toBe("started");
  });

  it("closes merged GitHub issues by itself when the rule is Automatically, once per situation", () => {
    expect(autoFixes(board, () => DEFAULT_RULES, {})).toEqual([]);
    const auto = () => ({ ...DEFAULT_RULES, all_merged: "auto" as const });
    expect(autoFixes(board, auto, {}).map((c) => c.task.key)).toEqual(["acme/web#7"]);
    expect(autoFixes(board, auto, { [driftKey(gh7)]: true })).toEqual([]);
  });

  it("moves a tracker issue with an open PR to In Review: by itself at Automatically, never at Off", () => {
    const prOpen = { kind: "pr_open" as const, text: "#131 open", fix: "Move to In Review" };
    const hosts = card(task("MOON-142", "in_progress"), prOpen, [session("hosts", "/w/hosts")]);
    const b = { todo: [], in_progress: [hosts], in_review: [], done: [] };
    expect(driftFix(hosts)).toEqual({ kind: "move", column: "in_review" });
    expect(autoFixes(b, () => DEFAULT_RULES, {}).map((c) => c.task.key)).toEqual(["MOON-142"]);
    expect(Object.values(applyRules(b, () => ({ ...DEFAULT_RULES, pr_opens: "off" }))).flat()[0].drift).toBe(null);
    expect(autoFixes(b, () => ({ ...DEFAULT_RULES, pr_opens: "suggest" }), {})).toEqual([]);
  });
});

describe("outsideMoves (X44: notify when a task changes state outside moonlet)", () => {
  const gh = (n: number, column: Task["column"]) => task(`acme/web#${n}`, column, { repo: "acme/web", number: n, closingPrs: [] });

  it("names linked tasks that changed column since the last sync, unless moonlet moved them", () => {
    const before = [task("MOON-142", "in_review"), task("MOON-151", "todo"), gh(7, "open"), gh(8, "open")];
    const after = [task("MOON-142", "in_progress"), task("MOON-151", "in_progress"), gh(7, "done"), gh(8, "done")];
    const linked = new Set(["linear:acme MOON-142", "github:github.com acme/web#7", "github:github.com acme/web#8"]);
    // moonlet closed #8 itself.
    const byMoonlet = new Map([["github:github.com acme/web#8", "done" as const]]);
    expect(outsideMoves(before, after, linked, byMoonlet)).toEqual([
      { id: "linear:acme MOON-142", title: "MOON-142", text: "MOON-142 moved to In Progress" },
      { id: "github:github.com acme/web#7", title: "acme/web#7", text: "acme/web#7 was closed" },
    ]);
  });

  it("names a move moonlet made only when the task ends up elsewhere", () => {
    const linked = new Set(["linear:acme MOON-142"]);
    const byMoonlet = new Map([["linear:acme MOON-142", "in_review" as const]]);
    expect(outsideMoves([task("MOON-142", "in_progress")], [task("MOON-142", "done")], linked, byMoonlet)).toEqual([
      { id: "linear:acme MOON-142", title: "MOON-142", text: "MOON-142 moved to Done" },
    ]);
  });

  it("does not say a closed GitHub issue was closed again when only its reason changed", () => {
    const linked = new Set(["github:github.com acme/web#7"]);
    expect(outsideMoves([gh(7, "done")], [gh(7, "hidden")], linked, new Map())).toEqual([]);
  });

  it("says nothing on the first sync", () => {
    expect(outsideMoves(null, [task("MOON-142", "done")], new Set(["linear:acme MOON-142"]), new Map())).toEqual([]);
  });
});

describe("prComments (X46: a pull request opens → comment its link)", () => {
  it("comments each newly opened PR on its tracker issue once; GitHub uses Closes #N instead", () => {
    const open = (n: number, url: string) => ({ number: n, url, state: "open", title: "Hosts section", checks: [], review_decision: null });
    const linearTask = { ...task("MOON-142", "in_review"), tracker: { id: "issue-1", state: "In Review", source: "MOON" } };
    const hosts = card(linearTask, null, [{ ...session("hosts", "/w/hosts"), pr: open(131, "https://github.com/acme/app/pull/131") }]);
    const ghCard = card(task("acme/web#7", "open", { repo: "acme/web", number: 7, closingPrs: [] }), null, [{ ...session("fix", "/w/fix"), pr: open(70, "u") }]);
    const board = { todo: [], in_progress: [ghCard], in_review: [hosts], done: [] };
    expect(prComments(board, () => DEFAULT_RULES, {})).toEqual([
      { card: hosts, key: "comment linear:acme MOON-142 https://github.com/acme/app/pull/131", text: "Opened a pull request: Hosts section https://github.com/acme/app/pull/131" },
    ]);
    expect(prComments(board, () => DEFAULT_RULES, { "comment linear:acme MOON-142 https://github.com/acme/app/pull/131": true })).toEqual([]);
    expect(prComments(board, () => ({ ...DEFAULT_RULES, pr_comment: "off" }), {})).toEqual([]);
    // A draft is not opened yet.
    const draft = card(linearTask, null, [{ ...session("hosts", "/w/hosts"), pr: { ...open(131, "https://github.com/acme/app/pull/131"), draft: true } }]);
    expect(prComments({ todo: [], in_progress: [], in_review: [draft], done: [] }, () => DEFAULT_RULES, {})).toEqual([]);
  });
});
