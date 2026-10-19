import { describe, expect, it } from "vitest";
import type { GhTask } from "./protocol";
import { githubBranchNumber, githubRepo, mentionsKey, type Task, taskForSession, taskFromGh, taskStart, trackerName, trackerOf } from "./tasks";

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

  it("needs the key's own hyphen", () => {
    expect(mentionsKey("feat/moon_142", "MOON-142")).toBe(false);
    expect(mentionsKey("feat_moon-142", "MOON-142")).toBe(true);
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
      mine: true,
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

  it("follows the link rules: no branch or PR matches when they are off (X44)", () => {
    const off = { branch: false, pr: true, title: true };
    expect(taskForSession(session({ branch: "moon-142-remote-hosts" }), null, null, tasks, off)).toBe(null);
    expect(taskForSession(session({}), pr(7, "MOON-144: tabs"), null, tasks, off)).toBe(tabs);
    expect(taskForSession(session({}), pr(7, "MOON-144: tabs"), null, tasks, { branch: true, pr: false, title: true })).toBe(null);
    // A stored link always counts.
    const stored = session({ task: { connection: "linear:acme", key: "MOON-144", url: "" } });
    expect(taskForSession(stored, null, null, tasks, { branch: false, pr: false, title: false })).toBe(tabs);
  });

  it("links nothing after the user unlinked it, and nothing when no task matches", () => {
    expect(taskForSession(session({ branch: "moon-142-x", task_unlinked: true }), null, null, tasks)).toBe(null);
    expect(taskForSession(session({ branch: "zsh-perf" }), pr(9, "Speed up zsh"), "cli/cli", tasks)).toBe(null);
  });
});

describe("githubRepo", () => {
  it("reads owner/repo from an origin URL on github.com", () => {
    expect(githubRepo("https://github.com/1devstudio/moonlet.git")).toBe("1devstudio/moonlet");
    expect(githubRepo("https://github.com/1devstudio/moonlet")).toBe("1devstudio/moonlet");
    expect(githubRepo("git@github.com:1devstudio/moonlet.git\n")).toBe("1devstudio/moonlet");
    expect(githubRepo("ssh://git@github.com/acme/web.git")).toBe("acme/web");
    expect(githubRepo("https://gitlab.com/acme/web.git")).toBe(null);
    expect(githubRepo(null)).toBe(null);
  });
});

describe("taskStart (X46 starting a session from a task)", () => {
  it("prefills the composer: the link, the first message, the tracker and the project with the issue's repository", () => {
    const t = taskFromGh({ ...ghIssue, body: "  ### Describe the bug\nSkills are not found.  " }, "github:github.com");
    expect(taskStart(t, { web: "acme/web", cli: "cli/cli" })).toEqual({
      ref: { connection: "github:github.com", key: "cli/cli#13876", url: "https://github.com/cli/cli/issues/13876" },
      kind: "github",
      key: "cli/cli#13876",
      title: "`gh skill install` can't find skills",
      number: 13876,
      // The composer's folded attachment shows it (X54).
      description: "### Describe the bug\nSkills are not found.",
      projects: ["cli"],
      issueType: "bug",
      github: { repo: "cli/cli", number: 13876 },
    });
  });

  it("offers a tracker issue's session the projects that link its source", () => {
    const t = { ...linear("MOON-151", "Drag sessions"), tracker: { id: "a1", state: "Todo", source: "MOON" } };
    const st = taskStart(t, {}, { "linear:acme MOON": ["p-web", "p-api"] });
    expect([st.kind, st.projects, st.github]).toEqual(["linear", ["p-web", "p-api"], undefined]);
  });

  it("sends only the title line when the issue has no description, and names no project it can't place", () => {
    const s = taskStart({ ...hosts, description: "" }, { web: "acme/web" });
    expect([s.kind, s.description, s.projects, s.number]).toEqual(["linear", "", [], undefined]);
  });
});

describe("trackerOf and trackerName", () => {
  it("read the tracker from a connection id", () => {
    expect(["github:github.com", "linear:acme", "jira:acme.atlassian.net", "clickup:9012345"].map((c) => [trackerOf(c), trackerName(c)])).toEqual([
      ["github", "GitHub"],
      ["linear", "Linear"],
      ["jira", "Jira"],
      ["clickup", "ClickUp"],
    ]);
    expect(trackerOf("trello:x")).toBe(null);
    expect(trackerOf("constructor:x")).toBe(null);
    expect(trackerName("trello:x")).toBe("tracker");
  });
});

describe("taskStart's {type} (X44 branch names)", () => {
  const base: Task = { connection: "jira:acme.atlassian.net", key: "OPS-12", title: "Rotate keys", url: "", column: "todo", priority: 0, assignees: [], labels: ["security"], description: "", updatedMs: 0, tracker: { id: "1", state: "To Do", source: "OPS" } };
  it("is Jira's issue type, else the first label", () => {
    expect(taskStart({ ...base, issueType: "Bug" }, {}).issueType).toBe("Bug");
    expect(taskStart(base, {}).issueType).toBe("security");
    expect(taskStart({ ...base, labels: [] }, {}).issueType).toBe(undefined);
  });
});
