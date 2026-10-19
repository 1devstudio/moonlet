import { beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonError } from "./daemon";
import { gitSettingsOf } from "./gitSettings";
import { loadGitSettings, useStore } from "./store";

const daemon = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./daemon", async (original) => ({ ...(await original<typeof import("./daemon")>()), rpc: daemon.rpc }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: () => Promise.resolve() }) }));

describe("a host's Git settings (X55)", () => {
  beforeEach(() => {
    daemon.rpc.mockReset();
    useStore.setState({ gitSettings: {} });
  });

  it("are what its daemon keeps", async () => {
    daemon.rpc.mockResolvedValue({ ...gitSettingsOf({}, "devbox"), draft_prs: true });
    await loadGitSettings("devbox");
    expect(useStore.getState().gitSettings.devbox?.draft_prs).toBe(true);
  });

  it("mark a daemon that doesn't know them as too old", async () => {
    daemon.rpc.mockRejectedValue(new DaemonError({ code: "unknown_method", message: "unknown method git.settings" }));
    await loadGitSettings("devbox");
    expect(useStore.getState().gitSettings.devbox).toBeNull();
  });

  it("stay unknown when the daemon can't be reached", async () => {
    daemon.rpc.mockRejectedValue(new DaemonError({ code: "failed", message: "disconnected" }));
    await loadGitSettings("devbox");
    expect(useStore.getState().gitSettings.devbox).toBeUndefined();
  });
});
