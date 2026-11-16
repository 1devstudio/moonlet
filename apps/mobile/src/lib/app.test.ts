import { describe, expect, it, vi } from "vitest";

// The daemon's replies: each `account.get` waits until the test lets it
// answer; `exec.setups` too while `holdSetups` is on.
const accounts: ((account: string) => void)[] = [];
const setups: ((list: unknown[]) => void)[] = [];
let holdSetups = false;
/** What `session.list` answers. */
let sessionList: unknown[] = [];
vi.mock("@desktop/lib/daemon", async (real) => ({
  ...(await real<typeof import("@desktop/lib/daemon")>()),
  rpc: (_host: string, method: string) => {
    if (method === "account.get") return new Promise((resolve) => accounts.push((account) => resolve({ account, central: null })));
    if (method === "exec.setups" && holdSetups) return new Promise((resolve) => setups.push(resolve));
    if (method === "session.list") return Promise.resolve(sessionList);
    return Promise.resolve(method === "git.settings" ? null : []);
  },
}));

const { dropSetup, loadHost, refreshSetups, useApp } = await import("./app");

describe("loadHost (X68)", () => {
  it("keeps the newer load's account when an older load answers last", async () => {
    const older = loadHost("mac");
    const newer = loadHost("mac");
    await vi.waitFor(() => expect(accounts).toHaveLength(2));
    accounts[1]("w-mini");
    await newer;
    accounts[0]("mac");
    await older;
    expect(useApp.getState().data.mac.account).toBe("w-mini");
  });
});

describe("refreshSetups (X62)", () => {
  it("does not bring back a setup answered while the list was read", async () => {
    const ask = { copy: "r1", host: "studio-mini", project: "shop", command: "make deps" };
    holdSetups = true;
    const reading = refreshSetups("mini");
    await vi.waitFor(() => expect(setups).toHaveLength(1));
    dropSetup("mini", "r1");
    setups[0]([ask]);
    await reading;
    expect(useApp.getState().data.mini.setups).toEqual([]);
  });
});

describe("a task's Back (X76)", () => {
  it("goes back to the session the task was opened from, else to the board's tab", async () => {
    const { showScreen, taskBack, useApp } = await import("./app");
    const session = { kind: "session" as const, host: "mac", id: "s1", tab: "chat" as const };
    showScreen({ kind: "task", board: "mac/personal/web", task: "jira:acme WEB-271", from: session });
    taskBack();
    expect(useApp.getState().screen).toEqual(session);
    showScreen({ kind: "task", board: "mac/personal/web", task: "jira:acme WEB-271" });
    taskBack();
    expect(useApp.getState().screen).toBeNull();
  });
});

describe("a session open on the phone as its owner changes (X73)", () => {
  const fixCart = (owner?: unknown) => ({ id: "5e7f9a1b3c5d", project_id: "p1", name: "fix-cart", branch: "moonlet/fix-cart", base: "", path: "/Users/alex/shop/fix-cart", agent: null, archived: false, created_at: 1790000000002, terminals: [], layout: null, owner });
  const load = async (host: string) => {
    holdSetups = false;
    const before = accounts.length;
    const done = loadHost(host);
    await vi.waitFor(() => expect(accounts.length).toBeGreaterThan(before));
    accounts[accounts.length - 1]("acct-alex");
    await done;
  };

  it("keeps showing it from the central host once it was handed over there, and from its Mac once brought back", async () => {
    const { showScreen } = await import("./app");
    sessionList = [fixCart({ worker: "w-book", name: "MacBook", reachable: false, unreachable_since: 1790000000000 })];
    await load("studio");
    showScreen({ kind: "session", host: "studio#copy:5e7f9a1b3c5d", id: "5e7f9a1b3c5d", tab: "chat" });
    // The MacBook handed it over as it slept: studio-mini runs it now.
    sessionList = [fixCart()];
    await load("studio");
    await vi.waitFor(() => expect(useApp.getState().screen).toEqual({ kind: "session", host: "studio", id: "5e7f9a1b3c5d", tab: "chat" }));
    // Typing on the MacBook brought it back.
    sessionList = [fixCart({ worker: "w-book", name: "MacBook", reachable: true })];
    await load("studio");
    await vi.waitFor(() => expect(useApp.getState().screen).toEqual({ kind: "session", host: "studio#copy:5e7f9a1b3c5d", id: "5e7f9a1b3c5d", tab: "chat" }));
    expect(useApp.getState().data["studio#copy:5e7f9a1b3c5d"].sessions[0].owner).toEqual({ worker: "w-book", name: "MacBook", reachable: true });
  });
});
