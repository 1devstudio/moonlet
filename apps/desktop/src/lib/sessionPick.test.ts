import { describe, expect, it } from "vitest";
import type { ClaudeProfile, Section, Session, TerminalInfo, Workspace } from "./protocol";
import { clickPick, escClearsPick, moveConfirm, moveTargets, pickedSessions, pickLine, shownPick } from "./sessionPick";

// The sidebar's rows top to bottom, as `host/session` keys.
const rows = ["local/fix-checkout", "local/add-search", "local/dark-mode", "local/old-cart", "local/refund", "local/webhooks"];

describe("clickPick (X106)", () => {
  it("a plain click opens the session and clears the picks", () => {
    const picked = { keys: ["local/dark-mode", "local/refund"], anchor: "local/refund" };
    expect(clickPick(picked, { key: "local/old-cart", cmd: false, shift: false }, rows)).toEqual({
      pick: { keys: [], anchor: "local/old-cart" },
      open: true,
    });
  });

  it("⌘-click adds a session and a second ⌘-click takes it out", () => {
    const one = clickPick({ keys: [], anchor: "local/add-search" }, { key: "local/refund", cmd: true, shift: false }, rows);
    expect(one).toEqual({ pick: { keys: ["local/refund"], anchor: "local/refund" }, open: false });
    const two = clickPick(one.pick, { key: "local/dark-mode", cmd: true, shift: false }, rows);
    // Kept in the sidebar's order, not the order they were clicked.
    expect(two.pick.keys).toEqual(["local/dark-mode", "local/refund"]);
    const back = clickPick(two.pick, { key: "local/refund", cmd: true, shift: false }, rows);
    expect(back).toEqual({ pick: { keys: ["local/dark-mode"], anchor: "local/refund" }, open: false });
  });

  it("⇧-click picks the range from the last click, adding to the picks", () => {
    // The design's journey: ⌘-click Dark mode, then ⇧-click Webhooks two rows below Refund.
    const first = clickPick({ keys: [], anchor: null }, { key: "local/fix-checkout", cmd: true, shift: false }, rows).pick;
    const dark = clickPick(first, { key: "local/old-cart", cmd: true, shift: false }, rows).pick;
    expect(clickPick(dark, { key: "local/webhooks", cmd: false, shift: true }, rows)).toEqual({
      pick: { keys: ["local/fix-checkout", "local/old-cart", "local/refund", "local/webhooks"], anchor: "local/old-cart" },
      open: false,
    });
    // Upwards too.
    expect(clickPick({ keys: [], anchor: "local/refund" }, { key: "local/add-search", cmd: false, shift: true }, rows).pick.keys).toEqual([
      "local/add-search",
      "local/dark-mode",
      "local/old-cart",
      "local/refund",
    ]);
  });

  it("⇧-click with nothing clicked yet picks just that row", () => {
    expect(clickPick({ keys: [], anchor: null }, { key: "local/dark-mode", cmd: false, shift: true }, rows)).toEqual({
      pick: { keys: ["local/dark-mode"], anchor: "local/dark-mode" },
      open: false,
    });
  });

  it("⇧-click range counts a session shown under two sections once", () => {
    // "storefront" is in Acme and in Side projects: its sessions show twice.
    const twice = ["local/a", "local/b", "local/c", "local/a", "local/b"];
    expect(clickPick({ keys: [], anchor: "local/b" }, { key: "local/c", cmd: false, shift: true }, twice).pick.keys).toEqual(["local/b", "local/c"]);
  });
});

describe("shownPick (X106)", () => {
  it("picks drop sessions no longer in the sidebar", () => {
    // Refund was archived; Webhooks moved to another workspace.
    const p = { keys: ["local/dark-mode", "local/refund", "local/webhooks"], anchor: "local/webhooks" };
    expect(shownPick(p, ["local/fix-checkout", "local/dark-mode"])).toEqual({ keys: ["local/dark-mode"], anchor: null });
    // Unchanged when every pick is still there, the same object.
    const kept = { keys: ["local/dark-mode"], anchor: "local/dark-mode" };
    expect(shownPick(kept, rows)).toBe(kept);
  });
});

describe("pickLine (X106)", () => {
  it("the bar says how many and in how many projects", () => {
    expect(pickLine(["storefront", "payments-api", "payments-api"])).toEqual({ count: "3 selected", where: "in 2 projects" });
    expect(pickLine(["storefront", "storefront"])).toEqual({ count: "2 selected", where: null });
    expect(pickLine(["storefront"])).toEqual({ count: "1 selected", where: null });
  });
});

const ws = (id: string, name: string, section_ids: string[], claude_profile: string | null = null): Workspace => ({ id, name, color: "blue", section_ids, claude_profile, created_at: 0 });
const section = (id: string, project_ids: string[]): Section => ({ id, name: id, project_ids, view: { group_by: "project", sort_by: "created", filter: [] }, created_at: 0 });
const ses = (id: string, project: string, workspace: string, extra: Partial<Session> = {}): Session => ({
  id,
  project_id: project,
  name: id,
  branch: `moonlet/${id}`,
  base: "main",
  path: `/w/${id}`,
  agent: "claude",
  archived: false,
  created_at: 0,
  workspace_id: workspace,
  terminals: [],
  layout: null,
  ...extra,
});

describe("pickedSessions (X106)", () => {
  it("are the picked sessions the hosts still list, in the picks' order", () => {
    const sessions = { local: [ses("dark-mode", "storefront", "personal"), ses("refund", "payments", "personal")], "studio-mini": [ses("webhooks", "payments", "personal")] };
    const pick = { keys: ["studio-mini/webhooks", "local/dark-mode", "local/gone"], anchor: null };
    expect(pickedSessions(pick, sessions)).toEqual([
      { host: "studio-mini", ws: sessions["studio-mini"][0] },
      { host: "local", ws: sessions.local[0] },
    ]);
  });
});

describe("escClearsPick (X106)", () => {
  it("Esc clears the picks, except for a field, a terminal or an editor", () => {
    document.body.innerHTML = '<button id="row"></button><input id="find"><div class="xterm"><textarea id="term"></textarea></div><div class="monaco-editor"><span id="code"></span></div><div contenteditable="true" id="edit"></div>';
    const at = (id: string) => document.getElementById(id);
    expect(escClearsPick(at("row"))).toBe(true);
    expect(escClearsPick(null)).toBe(true);
    expect(escClearsPick(at("find"))).toBe(false);
    expect(escClearsPick(at("term"))).toBe(false);
    expect(escClearsPick(at("code"))).toBe(false);
    expect(escClearsPick(at("edit"))).toBe(false);
  });
});

describe("moveTargets (X106)", () => {
  const sections = [section("acme", ["storefront", "payments"]), section("client", ["storefront", "payments"]), section("research", ["storefront"])];
  const workspaces = [ws("personal", "Personal", ["acme"]), ws("client", "Acme client", ["client"], "work"), ws("research", "Research", ["research"])];
  const projects = [{ id: "storefront", name: "storefront", path: "/storefront", base_branch: "main" }, { id: "payments", name: "payments-api", path: "/payments-api", base_branch: "main" }];
  const profiles: ClaudeProfile[] = [{ id: "work", name: "Work profile", path: "/p/work", created_at: 0 }];
  const local = { host: "local", workspaces, sections, projects, profiles };

  it("move targets are the workspaces holding every picked project", () => {
    const picked = [
      { host: "local", ws: ses("dark-mode", "storefront", "personal") },
      { host: "local", ws: ses("refund", "payments", "personal") },
    ];
    expect(moveTargets(picked, [local])).toEqual({
      disabled: null,
      targets: [
        { id: "personal", name: "Personal", color: "blue", profile: null, note: null, current: true, disabled: "They are in Personal" },
        // Another Claude profile than Personal's: named, as moving asks first.
        { id: "client", name: "Acme client", color: "blue", profile: "work", note: "Work profile", current: false, disabled: null },
        // Research has storefront, not payments: Refund would show nowhere.
        { id: "research", name: "Research", color: "blue", profile: null, note: null, current: false, disabled: "payments-api is not in Research" },
      ],
    });
  });

  it("a workspace one member lacks the project in is disabled, by the same workspace id on every member (X68)", () => {
    // studio-mini has the workspaces under the same ids, its Research without payments.
    const mini = { host: "studio-mini", workspaces, sections: [section("acme", ["storefront", "payments"]), section("client", ["storefront"]), section("research", ["storefront"])], projects, profiles };
    const picked = [
      { host: "local", ws: ses("dark-mode", "storefront", "personal") },
      { host: "studio-mini", ws: ses("webhooks", "payments", "personal") },
    ];
    expect(moveTargets(picked, [local, mini]).targets.map((t) => [t.name, t.disabled])).toEqual([
      ["Personal", "They are in Personal"],
      ["Acme client", "payments-api is not in Acme client"],
      ["Research", "payments-api is not in Research"],
    ]);
  });

  it("a picked session another Mac runs disables Move to", () => {
    const picked = [
      { host: "local", ws: ses("dark-mode", "storefront", "personal") },
      { host: "local", ws: ses("theirs", "storefront", "personal", { owner: { worker: "w-air", name: "studio-air", reachable: true } }) },
    ];
    expect(moveTargets(picked, [local]).disabled).toBe("theirs runs on studio-air");
  });
});

describe("moveConfirm (X106)", () => {
  const term = (id: number, session_id: string): TerminalInfo =>
    ({ id, kind: "agent", title: "claude", cwd: "/w", command: [], session_id, agent: "claude", agent_state: "working", cols: 80, rows: 24, pid: 1, last_output_at: 0, created_at: 0 }) as TerminalInfo;
  const workspaces = [ws("personal", "Personal", ["acme"]), ws("client", "Acme client", ["client"], "work"), ws("research", "Research", ["research"])];
  const profiles = [{ id: "work", name: "Work profile", path: "/p/work", created_at: 0, account: null, hooks_installed: true }];
  const sessions = [ses("dark-mode", "storefront", "personal"), ses("refund", "payments", "personal")];
  const picked = sessions.map((s) => ({ host: "local", ws: s }));
  const target = (id: string, profile: string | null) => ({ id, name: id, color: "blue" as const, profile, note: null, current: false, disabled: null });

  it("asks before Claude agents in the picked sessions switch profiles, as moving a section does (X33)", () => {
    const local = { host: "local", workspaces, profiles, sessions, terminals: [term(7, "refund")] };
    expect(moveConfirm(picked, target("client", "work"), [local])).toBe(
      "1 session in this workspace has an agent. A running agent keeps its account until it restarts, then signs in with Work profile and starts a new conversation.",
    );
    // The same profile, or no agent running: nothing to ask.
    expect(moveConfirm(picked, target("research", null), [local])).toBeNull();
    expect(moveConfirm(picked, target("client", "work"), [{ ...local, terminals: [] }])).toBeNull();
  });
});
