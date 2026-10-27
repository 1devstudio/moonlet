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
