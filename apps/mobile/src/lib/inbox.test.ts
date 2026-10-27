import { describe, expect, it } from "vitest";
import { buildInbox, summaryLine } from "./inbox";
import { MIN, NOW, ask, chat, data, project, read, session, terminal, workspace } from "./fixtures";

const PLAN = `# Idempotent refund webhooks\n\nStore event ids, retry with backoff, add a replay script. Then backfill.`;

/** The design's Inbox: a Bash ask on This Mac, a plan on devbox, a terminal read. */
const world = () => ({
  hosts: {
    mac: { id: "mac", label: "This Mac", status: "connected" as const, via: null },
    "mac/devbox": { id: "mac/devbox", label: "devbox", status: "connected" as const, via: "This Mac" },
  },
  data: {
    mac: data({
      workspaces: [workspace("personal", "Personal")],
      projects: [project("storefront", "storefront"), project("changedeck", "changedeck")],
      sessions: [session("add-search", "Add search to the product list"), session("fix-login", "Fix login", { project_id: "changedeck" })],
      terminals: { 10: terminal(10, "add-search", { agent_state: "blocked" }), 30: terminal(30, "fix-login", { agent_state: "working" }) },
      chats: { 10: chat([ask("a1", "Bash", { summary: "pnpm test --filter search", asked_at: NOW - 2 * MIN })]) },
      reads: [read({ asked_at: NOW - 9 * MIN })],
    }),
    "mac/devbox": data({
      workspaces: [workspace("personal", "Personal"), workspace("work", "Work")],
      projects: [project("payments", "payments-api")],
      sessions: [session("refund", "Idempotent refund webhooks", { project_id: "payments" })],
      terminals: { 5: terminal(5, "refund", { agent_state: "blocked" }) },
      chats: { 5: chat([ask("p1", "ExitPlanMode", { summary: "Idempotent refund webhooks", input: { plan: PLAN }, asked_at: NOW - 6 * MIN })]) },
    }),
  },
});

describe("buildInbox", () => {
  it("lists every ask across hosts, newest first", () => {
    const inbox = buildInbox(world().hosts, world().data, null);
    expect(inbox.needs.map((c) => [c.kind, c.host, c.title, c.project, c.hostLabel])).toEqual([
      ["permission", "mac", "Add search to the product list", "storefront", "This Mac"],
      ["plan", "mac/devbox", "Idempotent refund webhooks", "payments-api", "devbox"],
      ["read", "mac", "Fix login", "changedeck", "This Mac"],
    ]);
    expect(inbox.needs[0].ask?.id).toBe("a1");
    expect(inbox.needs[2].read?.request_id).toBe(7);
  });

  it("calls an AskUserQuestion a question", () => {
    const w = world();
    w.data.mac.chats[10] = chat([ask("q1", "AskUserQuestion", { asked_at: NOW })]);
    expect(buildInbox(w.hosts, w.data, null).needs[0].kind).toBe("question");
  });

  it("keeps to the shown workspace, by name on every host", () => {
    const w = world();
    expect(buildInbox(w.hosts, w.data, "Personal").needs).toHaveLength(3);
    w.data["mac/devbox"].sessions[0].workspace_id = "work";
    expect(buildInbox(w.hosts, w.data, "Personal").needs.map((c) => c.title)).toEqual(["Add search to the product list", "Fix login"]);
    expect(buildInbox(w.hosts, w.data, "Work").needs.map((c) => c.title)).toEqual(["Idempotent refund webhooks"]);
  });

  it("names the subagent that asks, and none for the main agent (X42)", () => {
    const w = world();
    const explore = {
      id: "a98344134013d8227",
      tool_use_id: "toolu_01QNjAbPMDQiZwKyCqkmv2VD",
      description: "Run the search\ntests",
      prompt: "Run them.",
      status: "running" as const,
      started_at: NOW - 3 * MIN,
      tokens: 9721,
      tool_uses: 1,
      tools: [],
    };
    w.data.mac.chats[10] = {
      ...chat([ask("a1", "Bash", { asked_at: NOW - 2 * MIN, agent: "a98344134013d8227" }), ask("a2", "Bash", { asked_at: NOW - MIN })]),
      subagents: [explore],
    };
    const cards = buildInbox(w.hosts, w.data, null).needs.filter((c) => c.host === "mac" && c.kind === "permission");
    expect(cards.map((c) => [c.ask?.id, c.asker])).toEqual([
      ["a2", null],
      ["a1", "Run the search tests"],
    ]);
  });

  it("leaves out hosts that are not connected", () => {
    const w = world();
    const hosts = { ...w.hosts, "mac/devbox": { ...w.hosts["mac/devbox"], status: "reconnecting" as const } };
    expect(buildInbox(hosts, w.data, null).needs.map((c) => c.host)).toEqual(["mac", "mac"]);
  });
});

describe("the counts", () => {
  /** A done session, an archived one, one more working, one host offline. */
  const counted = () => {
    const w = world();
    w.data.mac.sessions.push(
      session("checkout", "Fix checkout button on mobile"),
      session("old", "Old work", { archived: true }),
      session("dark", "Dark mode for account pages"),
    );
    Object.assign(w.data.mac.terminals, {
      40: terminal(40, "checkout", { agent_state: "done" }),
      41: terminal(41, "old", { agent_state: "done" }),
      42: terminal(42, "dark", { agent_state: "working" }),
    });
    return w;
  };

  it("counts what needs the user, what works and the hosts online, not the sessions done", () => {
    const w = counted();
    const hosts = { ...w.hosts, gpu: { id: "gpu", label: "gpu-box", status: "error" as const, via: "This Mac" } };
    const inbox = buildInbox(hosts, w.data, null);
    // "Fix login" (30) and "Dark mode" (42) are working.
    expect(inbox.working).toBe(2);
    expect(inbox.hostsOnline).toBe(2);
    expect(summaryLine(inbox)).toBe("3 need you · 2 working · 2 hosts online");
  });

  it("lists only the asks, not the sessions done", () => {
    const inbox = buildInbox(counted().hosts, counted().data, null);
    expect(inbox).toEqual({ needs: expect.any(Array), working: 2, hostsOnline: 2 });
    expect(inbox.needs.map((c) => c.title)).toEqual(["Add search to the product list", "Idempotent refund webhooks", "Fix login"]);
  });

  it("leaves zero counts out of the line, except the hosts", () => {
    expect(summaryLine({ needs: [], working: 0, hostsOnline: 1 })).toBe("1 host online");
    expect(summaryLine({ needs: [], working: 1, hostsOnline: 0 })).toBe("1 working · 0 hosts online");
  });
});
