import { describe, expect, it } from "vitest";
import type { GhTask } from "./protocol";
import { githubBranchNumber, mentionsKey, type Task, taskForSession, taskFromGh } from "./tasks";

describe("mentionsKey (X44 keys)", () => {
  it("finds the key in a branch or PR title, ignoring case", () => {
    expect(mentionsKey("moon-142-remote-hosts", "MOON-142")).toBe(true);
    expect(mentionsKey("feat/MOON-142", "MOON-142")).toBe(true);
    expect(mentionsKey("feat_moon-142_hosts", "MOON-142")).toBe(true);
    expect(mentionsKey("Fix MOON-142: hosts", "MOON-142")).toBe(true);
  });

  it("needs no letter or digit right before or after it", () => {
    expect(mentionsKey("moon-1420-other", "MOON-142")).toBe(false);
    expect(mentionsKey("xmoon-142", "MOON-142")).toBe(false);
    expect(mentionsKey("moon-1420-and-moon-142", "MOON-142")).toBe(true);
    expect(mentionsKey("anything", "")).toBe(false);
  });
});

describe("githubBranchNumber", () => {
  it("reads the issue number gh issue develop puts first", () => {
    expect(githubBranchNumber("42-fix-login")).toBe(42);
    expect(githubBranchNumber("142x-fix")).toBe(null);
    expect(githubBranchNumber("fix-42-login")).toBe(null);
    expect(githubBranchNumber("42")).toBe(null);
  });
});

const ghIssue: GhTask = {
  repo: "cli/cli",
  number: 13876,
  title: "`gh skill install` can't find skills",
  body: "### Describe the bug",
  url: "https://github.com/cli/cli/issues/13876",
  closed: false,
  state_reason: null,
  assignees: ["sam-rivera"],
  labels: ["bug", "gh-skill"],
  updated_ms: 1_789_528_295_000,
  closing_prs: [13894],
};

describe("taskFromGh", () => {
  it("keys a GitHub issue by repository and number, placed by its work while open", () => {
    expect(taskFromGh(ghIssue, "github:github.com")).toEqual({
      connection: "github:github.com",
      key: "cli/cli#13876",
      title: "`gh skill install` can't find skills",
      url: "https://github.com/cli/cli/issues/13876",
      column: "open",
      priority: 0,
      assignees: ["sam-rivera"],
      labels: ["bug", "gh-skill"],
      description: "### Describe the bug",
      updatedMs: 1_789_528_295_000,
      github: { repo: "cli/cli", number: 13876, closingPrs: [13894] },
    });
  });

  it("puts issues closed as completed in Done and other closed ones out of sight", () => {
    expect(taskFromGh({ ...ghIssue, closed: true, state_reason: "completed" }, "github:github.com").column).toBe("done");
    expect(taskFromGh({ ...ghIssue, closed: true, state_reason: "not_planned" }, "github:github.com").column).toBe("hidden");
    expect(taskFromGh({ ...ghIssue, closed: true, state_reason: "duplicate" }, "github:github.com").column).toBe("hidden");
  });
});

const linear = (key: string, title: string): Task => ({
  connection: "linear:acme",
  key,
  title,
  url: `https://linear.app/acme/issue/${key}`,
  column: "in_progress",
  priority: 2,
  assignees: [],
  labels: [],
  description: "",
  updatedMs: 0,
});
const hosts = linear("MOON-142", "Remote hosts sidebar");
const tabs = linear("MOON-144", "File tabs");
const gh = taskFromGh(ghIssue, "github:github.com");
const tasks = [hosts, tabs, gh];
const session = (o: Partial<{ branch: string; task: { connection: string; key: string; url: string }; task_unlinked: boolean }>) => ({
  branch: "moonlet/something",
  task: null,
  task_unlinked: false,
  ...o,
});
const pr = (number: number, title: string) => ({ number, url: "", state: "open", title, checks: [], review_decision: null });

describe("taskForSession (X46 links)", () => {
  it("uses the stored link first", () => {
    const s = session({ branch: "moon-142-x", task: { connection: "linear:acme", key: "MOON-144", url: "" } });
    expect(taskForSession(s, null, null, tasks)).toBe(tabs);
  });

  it("finds the key in the branch name", () => {
    expect(taskForSession(session({ branch: "moon-142-remote-hosts" }), null, null, tasks)).toBe(hosts);
  });

  it("finds a GitHub issue by the branch's leading number, only in that repository", () => {
    expect(taskForSession(session({ branch: "13876-skills" }), null, "cli/cli", tasks)).toBe(gh);
    expect(taskForSession(session({ branch: "13876-skills" }), null, "other/repo", tasks)).toBe(null);
  });

  it("finds the task from the session's PR: a title with the key, or a PR that closes the issue", () => {
    expect(taskForSession(session({}), pr(7, "MOON-144: tabs"), null, tasks)).toBe(tabs);
    expect(taskForSession(session({}), pr(13894, "Fix skills"), "cli/cli", tasks)).toBe(gh);
  });

  it("links nothing after the user unlinked it, and nothing when no task matches", () => {
    expect(taskForSession(session({ branch: "moon-142-x", task_unlinked: true }), null, null, tasks)).toBe(null);
    expect(taskForSession(session({ branch: "zsh-perf" }), pr(9, "Speed up zsh"), "cli/cli", tasks)).toBe(null);
  });
});
