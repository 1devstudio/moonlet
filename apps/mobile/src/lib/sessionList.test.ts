import { describe, expect, it } from "vitest";
import type { Section } from "@desktop/lib/protocol";
import { chips, filterGroups, rowTarget, sessionGroups } from "./sessionList";
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
    const groups = sessionGroups(w.hosts, w.data, "Personal", NOW);
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
