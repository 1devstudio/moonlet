import { describe, expect, it, vi } from "vitest";

// The daemon's replies: each `account.get` waits until the test lets it
// answer; `exec.setups` too while `holdSetups` is on.
const accounts: ((account: string) => void)[] = [];
const setups: ((list: unknown[]) => void)[] = [];
let holdSetups = false;
vi.mock("@desktop/lib/daemon", async (real) => ({
  ...(await real<typeof import("@desktop/lib/daemon")>()),
  rpc: (_host: string, method: string) => {
    if (method === "account.get") return new Promise((resolve) => accounts.push((account) => resolve({ account, central: null })));
    if (method === "exec.setups" && holdSetups) return new Promise((resolve) => setups.push(resolve));
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
