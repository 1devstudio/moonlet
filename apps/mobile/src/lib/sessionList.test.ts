import { describe, expect, it } from "vitest";
import type { Section } from "@desktop/lib/protocol";
import { chips, filterGroups, foldsAfterTap, rowBadge, rowGlyph, rowTarget, sessionGroups, sessionSections, sessionTask, suggestedTask, taskChip, taskLine } from "./sessionList";
import { MIN, NOW, ask, chat, data, project, session, terminal, workspace } from "./fixtures";

const section = (id: string, name: string, project_ids: string[]): Section => ({
  id,
  name,
  project_ids,
  view: { group_by: "project", sort_by: "recent", filter: [] },
  created_at: NOW,
});

/** The design's Sessions board. */
const world = () => ({
  hosts: {
    mac: { id: "mac", label: "This Mac", status: "connected" as const, via: null },
    "mac/devbox": { id: "mac/devbox", label: "devbox", status: "connected" as const, via: "This Mac" },
  },
  data: {
    mac: data({
      workspaces: [{ ...workspace("personal", "Personal"), section_ids: ["dev", "side"] }],
      sections: [section("dev", "1devstudio", ["storefront"]), section("side", "Side projects", ["changedeck"])],
      projects: [project("storefront", "storefront"), project("changedeck", "changedeck")],
      sessions: [
        session("add-search", "Add search to the product list"),
        session("checkout", "Fix checkout button on mobile"),
        session("dark", "Dark mode for account pages"),
        session("old", "Old", { archived: true }),
        session("fix-login", "Fix login", { project_id: "changedeck" }),
      ],
      terminals: {
        1: terminal(1, "add-search", { agent_state: "blocked", last_output_at: NOW - MIN }),
        2: terminal(2, "checkout", { agent_state: "done", last_output_at: NOW - 30 * MIN }),
        3: terminal(3, "dark", { agent_state: "working", last_output_at: NOW - 2 * MIN }),
        4: terminal(4, "fix-login", { agent_state: "blocked" }),
      },
      chats: {
        1: chat([ask("a1", "Bash")]),
        3: { ...chat([], "working"), turn_started_at: NOW - 3 * MIN },
      },
    }),
    "mac/devbox": data({
      workspaces: [{ ...workspace("personal", "Personal"), section_ids: ["pay"] }],
      sections: [section("pay", "1devstudio", ["payments"])],
      projects: [project("payments", "payments-api")],
      sessions: [session("refund", "Idempotent refund webhooks", { project_id: "payments" }), session("node", "Bump Node to 22", { project_id: "payments" })],
      terminals: { 5: terminal(5, "refund", { agent_state: "blocked" }), 6: terminal(6, "node", { agent_state: "idle", last_output_at: NOW - 90 * MIN }) },
      chats: { 5: chat([ask("p1", "ExitPlanMode", { input: { plan: "# Refunds" } })]) },
    }),
  },
});

describe("sessionGroups", () => {
  it("groups by host, section and project, most recently active first", () => {
    const w = world();
    const groups = sessionGroups(w.hosts, w.data, null);
    expect(groups.map((g) => [g.sectionKey, g.label, g.host, g.rows.map((r) => r.session.name)])).toEqual([
      ["mac:personal:dev", "storefront", "mac", ["Add search to the product list", "Dark mode for account pages", "Fix checkout button on mobile"]],
      ["mac:personal:side", "changedeck", "mac", ["Fix login"]],
      ["mac/devbox:personal:pay", "payments-api", "mac/devbox", ["Idempotent refund webhooks", "Bump Node to 22"]],
    ]);
  });

  it("lists live agents first, working or needing you, then the rest by their last output", () => {
    const w = world();
    // The done session printed last; the working one and the one that needs
    // you have been quiet longer.
    w.data.mac.terminals[1] = terminal(1, "add-search", { agent_state: "blocked", last_output_at: NOW - 20 * MIN });
    w.data.mac.terminals[2] = terminal(2, "checkout", { agent_state: "done", last_output_at: NOW - MIN });
    w.data.mac.terminals[3] = terminal(3, "dark", { agent_state: "working", last_output_at: NOW - 10 * MIN });
    const groups = sessionGroups(w.hosts, w.data, null);
    expect(groups[0].rows.map((r) => r.session.name)).toEqual(["Dark mode for account pages", "Add search to the product list", "Fix checkout button on mobile"]);
  });

  it("gives each row its state, and the waiting plan of one that needs you", () => {
    const w = world();
    const rows = sessionGroups(w.hosts, w.data, null).flatMap((g) => g.rows);
    expect(rows.map((r) => [r.session.name, r.state, r.plan])).toEqual([
      ["Add search to the product list", "blocked", null],
      ["Dark mode for account pages", "working", null],
      ["Fix checkout button on mobile", "done", null],
      ["Fix login", "blocked", null],
      ["Idempotent refund webhooks", "blocked", { terminal: 5, ask: "p1" }],
      ["Bump Node to 22", "idle", null],
    ]);
  });

  it("says how many subagents the session's chats are running (X42)", () => {
    const w = world();
    w.data.mac.terminals[3] = terminal(3, "dark", { agent_state: "working", last_output_at: NOW - 2 * MIN, subagents: 2 });
    w.data.mac.terminals[7] = terminal(7, "dark", { last_output_at: NOW - 2 * MIN, subagents: 1 });
    w.data.mac.terminals[2] = terminal(2, "checkout", { agent_state: "done", last_output_at: NOW - 30 * MIN, subagents: 0 });
    w.data.mac.terminals[8] = terminal(8, "fix-login", { subagents: 1 });
    const rows = sessionGroups(w.hosts, w.data, null).flatMap((g) => g.rows);
    expect(rows.map((r) => [r.session.name, r.subagents])).toEqual([
      ["Add search to the product list", 0],
      ["Dark mode for account pages", 3],
      ["Fix checkout button on mobile", 0],
      ["Fix login", 1],
      ["Idempotent refund webhooks", 0],
      ["Bump Node to 22", 0],
    ]);
  });
});

describe("sessionSections (X118)", () => {
  it("follows the section's view: grouped by status, sorted by name", () => {
    const w = world();
    w.data.mac.sections[0].view = { group_by: "status", sort_by: "recent", filter: [] };
    w.data.mac.sections[1].view = { group_by: "none", sort_by: "name", filter: [] };
    w.data.mac.sessions.push(session("api", "Add an API key page", { project_id: "changedeck" }));
    const secs = sessionSections(w.hosts, w.data, { host: "mac", id: "personal" });
    expect(secs.map((s) => [s.name, s.groups.map((g) => [g.heading, g.label, g.rows.map((r) => r.session.name)])])).toEqual([
      [
        "1devstudio",
        [
          ["label", "Needs input", ["Add search to the product list"]],
          ["label", "Working", ["Dark mode for account pages"]],
          ["label", "Ready for review", ["Fix checkout button on mobile"]],
        ],
      ],
      ["Side projects", [[null, "All sessions", ["Add an API key page", "Fix login"]]]],
    ]);
  });

  it("keeps a nested session right under its parent, marked nested (X112)", () => {
    const w = world();
    w.data.mac.sessions.push(session("dark-2", "Dark mode follow-up", { parent: "dark", created_at: NOW - 200 * MIN }));
    const [storefront] = sessionGroups(w.hosts, w.data, null);
    expect(storefront.rows.map((r) => [r.session.name, r.nested])).toEqual([
      ["Add search to the product list", false],
      ["Dark mode for account pages", false],
      ["Dark mode follow-up", true],
      ["Fix checkout button on mobile", false],
    ]);
  });

  it("gives a project on GitHub its owner's avatar, else none", () => {
    const w = world();
    w.data.mac.projects[0] = { ...project("storefront", "storefront"), identity: { origin: "github.com/acme/storefront", root: "a1" } };
    const groups = sessionGroups(w.hosts, w.data, null);
    expect(groups.map((g) => [g.label, g.avatar])).toEqual([
      ["storefront", "https://avatars.githubusercontent.com/acme?s=64"],
      ["changedeck", null],
      ["payments-api", null],
    ]);
  });

  it("gives each row what its glyph and badge need, as the desktop draws them", () => {
    const w = world();
    // Fix checkout is still being set up; Dark mode runs two subagents.
    w.data.mac.terminals[9] = terminal(9, "checkout", { kind: "setup", chat: false });
    w.data.mac.terminals[3] = terminal(3, "dark", { agent_state: "working", last_output_at: NOW - 2 * MIN, subagents: 2 });
    const rows = sessionGroups(w.hosts, w.data, null).flatMap((g) => g.rows);
    const by = (name: string) => rows.find((r) => r.session.name === name)!;
    expect(rowBadge(by("Fix checkout button on mobile"), undefined, undefined)).toEqual({ text: "creating", tone: "muted" });
    expect(rowBadge(by("Add search to the product list"), { additions: 5, deletions: 0 }, undefined)).toEqual({ text: "needs input", tone: "blocked" });
    expect(rowBadge(by("Dark mode for account pages"), undefined, undefined)).toEqual({ text: "2 agents", tone: "agents" });
    expect(rowBadge(by("Bump Node to 22"), { additions: 1412, deletions: 38 }, undefined)).toEqual({ text: "+1.4k -38", tone: "diff" });
    expect(rowBadge(by("Bump Node to 22"), { additions: 1412, deletions: 38 }, "MERGED")).toBeNull();
    expect(rowGlyph(by("Dark mode for account pages"), undefined)).toBe("working");
    expect(rowGlyph(by("Bump Node to 22"), "OPEN")).toBe("branch");
    expect(rowGlyph(by("Bump Node to 22"), "MERGED")).toBe("idle");
  });

  it("folds a section or a project under the desktop's keys, and opens it again on a second tap", () => {
    const w = world();
    const [dev] = sessionSections(w.hosts, w.data, { host: "mac", id: "personal" });
    expect([dev.foldKey, dev.groups[0].foldKey]).toEqual(["ws:mac/dev", "mac/dev/proj:storefront"]);
    const once = foldsAfterTap({}, "mac/dev/proj:storefront");
    expect(once).toEqual({ "mac/dev/proj:storefront": true });
    expect(foldsAfterTap(once, "mac/dev/proj:storefront")).toEqual({});
  });
});

describe("sessionGroups across an account's members (X68)", () => {
  const storefront = { origin: "github.com/acme/storefront", root: "a1b2c3" };
  /** X68's journey: the MacBook and studio-mini share one Personal. */
  const shared = () => ({
    hosts: {
      mac: { id: "mac", label: "This Mac", status: "connected" as const, via: null },
      mini: { id: "mini", label: "studio-mini", status: "connected" as const, via: null },
    },
    data: {
      mac: data({
        account: "w-mini",
        workspaces: [{ ...workspace("personal", "Personal"), section_ids: ["dev", "side"] }],
        sections: [section("dev", "1devstudio", ["storefront"]), section("side", "Side projects", ["changedeck"])],
        projects: [{ ...project("storefront", "storefront"), identity: storefront }, project("changedeck", "changedeck")],
        sessions: [session("add-search", "Add search to the product list"), session("checkout", "Fix checkout button on mobile")],
        terminals: { 1: terminal(1, "add-search", { last_output_at: NOW - MIN }), 2: terminal(2, "checkout", { last_output_at: NOW - 30 * MIN }) },
      }),
      mini: data({
        account: "w-mini",
        workspaces: [{ ...workspace("personal", "Personal"), section_ids: ["dev"] }],
        sections: [section("dev", "1devstudio", ["sf", "payments"])],
        projects: [{ ...project("sf", "storefront"), identity: storefront }, { ...project("payments", "payments-api"), identity: { origin: "github.com/acme/payments-api", root: "d4e5f6" } }],
        sessions: [session("flaky", "Retry the flaky checkout test", { project_id: "sf" }), session("refund", "Idempotent refund webhooks", { project_id: "payments" })],
        terminals: { 3: terminal(3, "flaky", { last_output_at: NOW - 10 * MIN }), 4: terminal(4, "refund", { last_output_at: NOW - 5 * MIN }) },
      }),
    },
  });
  const shown = { host: "mac", id: "personal", account: "w-mini" };
  const view = (groups: ReturnType<typeof sessionGroups>) => groups.map((g) => [g.label, g.host, g.rows.map((r) => [r.session.name, r.on])]);

  it("shows a shared section once, and a project once by identity with every member's sessions, saying where the others are", () => {
    const w = shared();
    const groups = sessionGroups(w.hosts, w.data, shown);
    expect(view(groups)).toEqual([
      [
        "storefront",
        "mac",
        [
          ["Add search to the product list", null],
          ["Retry the flaky checkout test", "studio-mini"],
          ["Fix checkout button on mobile", null],
        ],
      ],
      ["payments-api", "mini", [["Idempotent refund webhooks", null]]],
      // A project of the section shows without sessions too (X118).
      ["changedeck", "mac", []],
    ]);
    expect(groups[0].sectionKey).toBe(groups[1].sectionKey);
    expect(rowTarget(groups[0].rows[1])).toEqual({ kind: "session", host: "mini", id: "flaky", tab: "chat" });
  });

  it("says which member a project or a section is on, as the desktop does (X118)", () => {
    const w = shared();
    const secs = sessionSections(w.hosts, w.data, shown);
    expect(secs.map((s) => [s.name, s.where, s.groups.map((g) => [g.label, g.on])])).toEqual([
      ["1devstudio", null, [["storefront", null], ["payments-api", "studio-mini"]]],
      ["Side projects", "This Mac", [["changedeck", null]]],
    ]);
  });

  it("shows a shared workspace once among all workspaces", () => {
    const w = shared();
    expect(view(sessionGroups(w.hosts, w.data, null))).toEqual([
      [
        "storefront",
        "mac",
        [
          ["Add search to the product list", null],
          ["Retry the flaky checkout test", "studio-mini"],
          ["Fix checkout button on mobile", null],
        ],
      ],
      ["payments-api", "mini", [["Idempotent refund webhooks", null]]],
      // A project of the section shows without sessions too (X118).
      ["changedeck", "mac", []],
    ]);
  });

  it("keeps a member's sessions out once it no longer shares the account", () => {
    const w = shared();
    w.data.mini.account = undefined;
    expect(view(sessionGroups(w.hosts, w.data, shown))).toEqual([
      [
        "storefront",
        "mac",
        [
          ["Add search to the product list", null],
          ["Fix checkout button on mobile", null],
        ],
      ],
      ["changedeck", "mac", []],
    ]);
  });
});

describe("chips and filters", () => {
  it("counts all, needs you, working and review", () => {
    const w = world();
    expect(chips(sessionGroups(w.hosts, w.data, null))).toEqual([
      { id: "all", label: "All", count: 6 },
      { id: "needs", label: "Needs you", count: 3 },
      { id: "working", label: "Working", count: 1 },
      { id: "review", label: "Review", count: 1 },
    ]);
  });

  it("keeps the rows of a chip and drops empty groups", () => {
    const w = world();
    const groups = filterGroups(sessionGroups(w.hosts, w.data, null), "working", "");
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.session.name)])).toEqual([["storefront", ["Dark mode for account pages"]]]);
  });

  it("keeps a project without sessions under All, not under a chip or a search (X118)", () => {
    const w = world();
    w.data.mac.projects.push(project("docs", "docs-site"));
    w.data.mac.sections[1].project_ids.push("docs");
    const all = sessionGroups(w.hosts, w.data, null);
    expect(filterGroups(all, "all", "").map((g) => [g.label, g.rows.length])).toEqual([
      ["storefront", 3],
      ["changedeck", 1],
      ["docs-site", 0],
      ["payments-api", 2],
    ]);
    expect(filterGroups(all, "needs", "").map((g) => g.label)).toEqual(["storefront", "changedeck", "payments-api"]);
    expect(filterGroups(all, "all", "fix").map((g) => g.label)).toEqual(["storefront", "changedeck"]);
  });

  it("lists the sessions whose agent is done under Review", () => {
    const w = world();
    const groups = filterGroups(sessionGroups(w.hosts, w.data, null), "review", "");
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.session.name)])).toEqual([["storefront", ["Fix checkout button on mobile"]]]);
  });

  it("searches titles, branches and projects", () => {
    const w = world();
    const names = (q: string) => filterGroups(sessionGroups(w.hosts, w.data, null), "all", q).flatMap((g) => g.rows.map((r) => r.session.name));
    expect(names("LOGIN")).toEqual(["Fix login"]);
    expect(names("moonlet/node")).toEqual(["Bump Node to 22"]);
    expect(names("payments")).toEqual(["Idempotent refund webhooks", "Bump Node to 22"]);
  });
});

describe("rowTarget", () => {
  it("opens a waiting plan's sheet, else the session's Chat", () => {
    const w = world();
    const rows = sessionGroups(w.hosts, w.data, null).flatMap((g) => g.rows);
    const by = (name: string) => rowTarget(rows.find((r) => r.session.name === name)!);
    expect(by("Idempotent refund webhooks")).toEqual({ kind: "plan", host: "mac/devbox", terminal: 5, ask: "p1" });
    expect(by("Fix checkout button on mobile")).toEqual({ kind: "session", host: "mac", id: "checkout", tab: "chat" });
    expect(by("Add search to the product list")).toEqual({ kind: "session", host: "mac", id: "add-search", tab: "chat" });
  });
});

describe("taskChip (X46)", () => {
  it("shows a linked session's issue: a tracker key whole, a GitHub issue by its number", () => {
    expect(taskChip(session("s", "x", { task: { connection: "linear:acme", key: "MOON-142", url: "https://linear.app/acme/issue/MOON-142" } }))).toEqual({
      label: "MOON-142",
      url: "https://linear.app/acme/issue/MOON-142",
    });
    expect(taskChip(session("s", "x", { task: { connection: "github:github.com", key: "acme/web#12", url: "https://github.com/acme/web/issues/12" } }))).toEqual({
      label: "#12",
      url: "https://github.com/acme/web/issues/12",
    });
  });

  it("shows nothing for a session without a stored link", () => {
    expect(taskChip(session("s", "x"))).toBeNull();
    expect(taskChip(session("s", "x", { task: null, task_unlinked: true }))).toBeNull();
  });
});

describe("sessionTask (X76)", () => {
  const LINEAR = "linear:acme";
  const board = { id: "moon", name: "Moonlet", connection: LINEAR, workspace: "local/personal", origin: { kind: "linear_team" as const, team: "MOON" }, columns: [
    { name: "Todo", statuses: ["s-todo"], category: "todo" as const },
    { name: "In Progress", statuses: ["s-progress"], category: "in_progress" as const },
  ] };
  const moon142 = { connection: LINEAR, key: "MOON-142", title: "Remote hosts sidebar", url: "https://linear.app/acme/issue/MOON-142", column: "in_progress" as const, priority: 3, assignees: [], labels: [], description: "", updatedMs: 0, tracker: { id: "i", state: "s-progress", source: "MOON" } };
  const snap = { version: 1 as const, syncedAt: NOW, from: "studio", boards: [board], shownBoard: "moon", tasks: [moon142], boardData: { moon: { keys: [`${LINEAR} MOON-142`] } }, worktrees: [], repos: {}, sourceProjects: {}, error: null, activity: {}, attention: {}, trackers: { github: { branch_template: "", max_length: 48, rules: { session_starts: "auto" as const, pr_opens: "auto" as const, all_merged: "suggest" as const, pr_comment: "auto" as const, issue_done: "suggest" as const } } }, link: { branch: true, pr: true, title: true } };
  const d = (s = session("remote", "Remote hosts sidebar", { branch: "moon-142-remote-hosts", project_id: "moonlet" })) => ({ ...data({ projects: [project("moonlet", "moonlet")], sessions: [s], tasks: { personal: snap } }), s });

  it("finds the task a session's branch names, with its state on the board and the project", () => {
    const { s, ...host } = d();
    expect(sessionTask(host, s, null)).toEqual({ key: "MOON-142", state: "In Progress", category: "in_progress", project: "moonlet", url: "https://linear.app/acme/issue/MOON-142" });
  });

  it("names a GitHub issue by its number, as rows show it", () => {
    const gh = { ...moon142, connection: "github:github.com", key: "acme/web#12", url: "https://github.com/acme/web/issues/12", tracker: undefined, github: { repo: "acme/web", number: 12, closingPrs: [] } };
    const s = session("fix", "Fix", { branch: "12-fix-login", project_id: "moonlet" });
    const host = { ...data({ projects: [project("moonlet", "moonlet")], sessions: [s], tasks: { personal: { ...snap, tasks: [gh], repos: { moonlet: "acme/web" }, boardData: { moon: { keys: [] } } } } }) };
    expect(sessionTask(host, s, null)?.key).toBe("#12");
  });

  it("keeps to the stored link without the Mac's boards, and shows nothing once unlinked", () => {
    const stored = session("x", "x", { task: { connection: "github:github.com", key: "acme/web#12", url: "https://github.com/acme/web/issues/12" } });
    expect(sessionTask(data({ sessions: [stored] }), stored, null)).toEqual({ key: "#12", state: null, category: null, project: null, url: "https://github.com/acme/web/issues/12" });
    const { s, ...host } = d(session("remote", "Remote hosts sidebar", { branch: "moon-142-remote-hosts", task: null, task_unlinked: true }));
    expect(sessionTask(host, s, null)).toBeNull();
  });

  it("finds a session's task on a board another member of its account shares (X68)", () => {
    const s = session("remote", "Remote hosts sidebar", { branch: "moon-142-remote-hosts", project_id: "moonlet" });
    // This member has no snapshot; the account's board came from another.
    const host = data({ projects: [project("moonlet", "moonlet")], sessions: [s] });
    expect(sessionTask(host, s, null)).toBeNull();
    expect(sessionTask(host, s, null, [snap])?.key).toBe("MOON-142");
    expect(suggestedTask(host, { ...s, branch: "x", name: "Remote hosts sidebar" }, [snap])).toEqual({ key: "MOON-142", id: `${LINEAR} MOON-142` });
  });

  it("matches a GitHub issue on another member's board by the session's own repository, whatever that member's project ids", () => {
    const gh = { ...moon142, connection: "github:github.com", key: "acme/web#12", url: "https://github.com/acme/web/issues/12", tracker: undefined, github: { repo: "acme/web", number: 12, closingPrs: [] } };
    // The other member keys its repositories by its own project id.
    const theirs = { ...snap, tasks: [gh], repos: { "p-on-air": "acme/web" }, boardData: { moon: { keys: [] } } };
    const s = session("fix", "Fix", { branch: "12-fix-login", project_id: "moonlet" });
    const host = data({ projects: [{ ...project("moonlet", "moonlet"), identity: { origin: "git@github.com:acme/web.git", root: "abc" } }], sessions: [s] });
    expect(sessionTask(host, s, null, [theirs])?.key).toBe("#12");
  });

  it("gives a linked session its task line for the row styles, only from the Mac's boards (X118)", () => {
    const { s, ...host } = d();
    expect(taskLine(host, s)).toEqual({ key: "MOON-142", title: "Remote hosts sidebar", column: "in_progress", outOfSync: false });
    const stored = session("x", "x", { task: { connection: "github:github.com", key: "acme/web#12", url: "https://github.com/acme/web/issues/12" } });
    expect(taskLine(data({ sessions: [stored] }), stored)).toBeNull();
  });

  it("groups a section by task from the Mac's boards, and gives each row its line keyed by host (X118)", () => {
    const remote = session("remote", "Remote hosts sidebar", { branch: "moon-142-remote-hosts", project_id: "moonlet" });
    const other = session("other", "Zsh startup profiling", { branch: "moonlet/zsh", project_id: "moonlet" });
    const mac = data({
      workspaces: [{ ...workspace("personal", "Personal"), section_ids: ["dev"] }],
      sections: [{ id: "dev", name: "1devstudio", project_ids: ["moonlet"], view: { group_by: "task", sort_by: "name", filter: [] }, created_at: NOW }],
      projects: [project("moonlet", "moonlet")],
      sessions: [remote, other],
      tasks: { personal: snap },
    });
    const hosts = { mac: { id: "mac", label: "This Mac", status: "connected" as const, via: null } };
    const [sec] = sessionSections(hosts, { mac }, { host: "mac", id: "personal" });
    expect(sec.groups.map((g) => [g.label, g.rows.map((r) => r.session.name)])).toEqual([
      ["MOON-142 Remote hosts sidebar", ["Remote hosts sidebar"]],
      ["No task", ["Zsh startup profiling"]],
    ]);
    expect(sec.groups.flatMap((g) => g.rows.map((r) => [r.key, r.task?.key ?? null, r.sources]))).toEqual([
      ["mac/remote", "MOON-142", true],
      ["mac/other", null, true],
    ]);
  });

  it("suggests a task whose title is the session's name, for a session with no task (shown as MOON-142?)", () => {
    const { s, ...host } = d(session("dark", "Remote hosts sidebar", { branch: "moonlet/sidebar", project_id: "moonlet" }));
    expect(sessionTask(host, s, null)).toBeNull();
    expect(suggestedTask(host, s)).toEqual({ key: "MOON-142", id: `${LINEAR} MOON-142` });
    // Never once the user unlinked it, nor for a session with a task.
    expect(suggestedTask(host, { ...s, task_unlinked: true })).toBeNull();
    expect(suggestedTask(host, { ...s, task: { connection: LINEAR, key: "MOON-1", url: "" } })).toBeNull();
    expect(suggestedTask(host, { ...s, name: "Something else" })).toBeNull();
  });
});
