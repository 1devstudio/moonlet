import { describe, expect, it, vi } from "vitest";

// The daemon's replies, held until the test lets each `account.get` answer.
const accounts: ((account: string) => void)[] = [];
vi.mock("@desktop/lib/daemon", async (real) => ({
  ...(await real<typeof import("@desktop/lib/daemon")>()),
  rpc: (_host: string, method: string) =>
    method === "account.get" ? new Promise((resolve) => accounts.push((account) => resolve({ account, central: null }))) : Promise.resolve(method === "git.settings" ? null : []),
}));

const { loadHost, useApp } = await import("./app");

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
