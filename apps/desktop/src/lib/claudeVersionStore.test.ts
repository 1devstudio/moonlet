import { beforeEach, describe, expect, it, vi } from "vitest";
import { claudeStatus } from "./claudeUpdate";
import { DaemonError } from "./daemon";
import { checkClaudeVersion, updateClaude, useStore } from "./store";

const daemon = vi.hoisted(() => ({ version: vi.fn(), update: vi.fn(), claudeLatest: vi.fn() }));
vi.mock("./daemon", async (original) => {
  const real = await original<typeof import("./daemon")>();
  const rpc = (_host: string, method: string) => (method === "claude.update" ? daemon.update() : daemon.version());
  return { ...real, rpc, hostsApi: { ...real.hostsApi, claudeLatest: daemon.claudeLatest } };
});
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: () => Promise.resolve() }) }));

const restarting = () => new DaemonError({ code: "failed", message: "disconnected" });
/** The Claude Code line Settings › General shows once the checks settle. */
async function shown() {
  await vi.waitFor(() => expect(useStore.getState().claudeChecking).toBe(false));
  const s = useStore.getState();
  return claudeStatus(s.claudeUpdate, s.claudeVersions, s.claudeChecking);
}

describe("Claude Code's version in Settings", () => {
  beforeEach(() => {
    daemon.version.mockReset();
    daemon.update.mockReset();
    daemon.claudeLatest.mockReset();
    useStore.setState({ claudeChecking: false, claudeUpdate: { phase: "idle" }, claudeVersions: { installed: null, latest: null } });
  });

  it("says the daemon could not be asked when it is restarting", async () => {
    daemon.version.mockRejectedValue(restarting());
    daemon.claudeLatest.mockResolvedValue("2.1.322");
    await checkClaudeVersion();
    expect(await shown()).toBe("Could not ask moonlet's daemon");
  });

  it("asks the daemon again when it came back during a check", async () => {
    // The launch check reaches the daemon while it restarts, and npm is slow.
    let npm!: (v: string) => void;
    daemon.claudeLatest.mockReturnValue(new Promise((r) => (npm = r)));
    daemon.version.mockRejectedValueOnce(restarting());
    const launch = checkClaudeVersion();
    // The daemon is back and the app checks again while npm still answers.
    daemon.version.mockResolvedValue({ version: "2.1.322", updating: false });
    void checkClaudeVersion();
    npm("2.1.322");
    await launch;
    expect(await shown()).toBe("Up to date");
  });

  it("keeps a re-check asked for during a check that an update made stale", async () => {
    useStore.setState({ claudeVersions: { installed: "2.1.300", latest: "2.1.322" } });
    let npm!: (v: string) => void;
    daemon.claudeLatest.mockReturnValueOnce(new Promise((r) => (npm = r))).mockResolvedValue("2.1.322");
    // The check and the read after the update both meet a restarting daemon.
    daemon.version.mockRejectedValueOnce(restarting()).mockRejectedValueOnce(restarting()).mockResolvedValue({ version: "2.1.322", updating: false });
    daemon.update.mockResolvedValue({ ok: true, output: "Successfully updated from 2.1.300 to version 2.1.322" });
    const launch = checkClaudeVersion();
    void checkClaudeVersion();
    await updateClaude();
    npm("2.1.322");
    await launch;
    expect(await shown()).toBe("Up to date");
  });
});
