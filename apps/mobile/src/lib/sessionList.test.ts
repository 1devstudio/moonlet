import { describe, expect, it } from "vitest";
import type { Section } from "@desktop/lib/protocol";
import { chips, filterGroups, rowTarget, sessionGroups, taskChip } from "./sessionList";
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
    const groups = sessionGroups(w.hosts, w.data, null, NOW);
    expect(groups.map((g) => [g.section, g.project.name, g.hostLabel, g.rows.map((r) => r.session.name)])).toEqual([
      ["1devstudio", "storefront", "This Mac", ["Add search to the product list", "Dark mode for account pages", "Fix checkout button on mobile"]],
      ["Side projects", "changedeck", "This Mac", ["Fix login"]],
      ["1devstudio", "payments-api", "devbox", ["Idempotent refund webhooks", "Bump Node to 22"]],
    ]);
    expect(groups[2].remote).toBe(true);
    expect(groups[0].letter).toBe("S");
  });

  it("gives each row its state and word", () => {
    const w = world();
    const rows = sessionGroups(w.hosts, w.data, null, NOW).flatMap((g) => g.rows);
    expect(rows.map((r) => [r.session.name, r.state, r.word])).toEqual([
      ["Add search to the product list", "blocked", "needs you"],
      ["Dark mode for account pages", "working", "3m"],
      ["Fix checkout button on mobile", "done", "done"],
      ["Fix login", "blocked", "needs you"],
      ["Idempotent refund webhooks", "blocked", "plan"],
      ["Bump Node to 22", "idle", ""],
    ]);
  });

  it("says how many subagents the session's chats are running (X42)", () => {
    const w = world();
    w.data.mac.terminals[3] = terminal(3, "dark", { agent_state: "working", last_output_at: NOW - 2 * MIN, subagents: 2 });
    w.data.mac.terminals[7] = terminal(7, "dark", { last_output_at: NOW - 2 * MIN, subagents: 1 });
    w.data.mac.terminals[2] = terminal(2, "checkout", { agent_state: "done", last_output_at: NOW - 30 * MIN, subagents: 0 });
    w.data.mac.terminals[8] = terminal(8, "fix-login", { subagents: 1 });
    const rows = sessionGroups(w.hosts, w.data, null, NOW).flatMap((g) => g.rows);
    expect(rows.map((r) => [r.session.name, r.agents])).toEqual([
      ["Add search to the product list", ""],
      ["Dark mode for account pages", "3 agents"],
      ["Fix checkout button on mobile", ""],
      ["Fix login", "1 agent"],
      ["Idempotent refund webhooks", ""],
      ["Bump Node to 22", ""],
    ]);
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
  const view = (groups: ReturnType<typeof sessionGroups>) => groups.map((g) => [g.section, g.project.name, g.hostLabel, g.rows.map((r) => [r.session.name, r.on])]);

  it("shows a shared section once, and a project once by identity with every member's sessions, saying where the others are", () => {
    const w = shared();
    const groups = sessionGroups(w.hosts, w.data, shown, NOW);
    expect(view(groups)).toEqual([
      [
        "1devstudio",
        "storefront",
        "This Mac",
        [
          ["Add search to the product list", null],
          ["Retry the flaky checkout test", "studio-mini"],
          ["Fix checkout button on mobile", null],
        ],
      ],
      ["1devstudio", "payments-api", "studio-mini", [["Idempotent refund webhooks", null]]],
    ]);
    expect(groups[0].sectionKey).toBe(groups[1].sectionKey);
    expect(rowTarget(groups[0].rows[1])).toEqual({ kind: "session", host: "mini", id: "flaky", tab: "chat" });
  });

  it("shows a shared workspace once among all workspaces", () => {
    const w = shared();
    expect(view(sessionGroups(w.hosts, w.data, null, NOW))).toEqual([
      [
        "1devstudio",
        "storefront",
        "This Mac",
        [
          ["Add search to the product list", null],
          ["Retry the flaky checkout test", "studio-mini"],
          ["Fix checkout button on mobile", null],
        ],
      ],
      ["1devstudio", "payments-api", "studio-mini", [["Idempotent refund webhooks", null]]],
    ]);
  });

  it("keeps a member's sessions out once it no longer shares the account", () => {
    const w = shared();
    w.data.mini.account = undefined;
    expect(view(sessionGroups(w.hosts, w.data, shown, NOW))).toEqual([
      [
        "1devstudio",
        "storefront",
        "This Mac",
        [
          ["Add search to the product list", null],
          ["Fix checkout button on mobile", null],
        ],
      ],
    ]);
  });
});

describe("chips and filters", () => {
  it("counts all, needs you, working and review", () => {
    const w = world();
    expect(chips(sessionGroups(w.hosts, w.data, null, NOW))).toEqual([
      { id: "all", label: "All", count: 6 },
      { id: "needs", label: "Needs you", count: 3 },
      { id: "working", label: "Working", count: 1 },
      { id: "review", label: "Review", count: 1 },
    ]);
  });

  it("keeps the rows of a chip and drops empty groups", () => {
    const w = world();
    const groups = filterGroups(sessionGroups(w.hosts, w.data, null, NOW), "working", "");
    expect(groups.map((g) => [g.project.name, g.rows.map((r) => r.session.name)])).toEqual([["storefront", ["Dark mode for account pages"]]]);
  });

  it("lists the sessions whose agent is done under Review", () => {
    const w = world();
    const groups = filterGroups(sessionGroups(w.hosts, w.data, null, NOW), "review", "");
    expect(groups.map((g) => [g.project.name, g.rows.map((r) => r.session.name)])).toEqual([["storefront", ["Fix checkout button on mobile"]]]);
  });

  it("searches titles, branches and projects", () => {
    const w = world();
    const names = (q: string) => filterGroups(sessionGroups(w.hosts, w.data, null, NOW), "all", q).flatMap((g) => g.rows.map((r) => r.session.name));
    expect(names("LOGIN")).toEqual(["Fix login"]);
    expect(names("moonlet/node")).toEqual(["Bump Node to 22"]);
    expect(names("payments")).toEqual(["Idempotent refund webhooks", "Bump Node to 22"]);
  });
});

describe("rowTarget", () => {
  it("opens a waiting plan's sheet, a done session's changes, else the chat", () => {
    const w = world();
    const rows = sessionGroups(w.hosts, w.data, null, NOW).flatMap((g) => g.rows);
    const by = (name: string) => rowTarget(rows.find((r) => r.session.name === name)!);
    expect(by("Idempotent refund webhooks")).toEqual({ kind: "plan", host: "mac/devbox", terminal: 5, ask: "p1" });
    expect(by("Fix checkout button on mobile")).toEqual({ kind: "session", host: "mac", id: "checkout", tab: "changes" });
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
