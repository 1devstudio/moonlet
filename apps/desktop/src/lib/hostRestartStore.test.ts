import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostInfo } from "./protocol";
import { restartHost, useHostRestarts } from "./hostRestartStore";

/** The hosts as the app sees them, what `host_restart` answers, and the pid
 * each host's `daemon.info` answers (none: it does not answer). */
const app = vi.hoisted(() => ({
  hosts: {} as Record<string, HostInfo>,
  restart: (() => Promise.resolve({ pid: 4242 })) as () => Promise<unknown>,
  asked: 0,
  pid: null as number | null,
  reconnected: [] as string[],
  toasts: [] as { text: string; kind: string }[],
}));
vi.mock("./daemon", () => {
  class DaemonError extends Error {
    code: string;
    constructor(e: { code: string; message: string }) {
      super(e.message);
      this.code = e.code;
    }
  }
  return {
    DaemonError,
    rpc: (_host: string, method: string) =>
      method === "daemon.info" && app.pid !== null ? Promise.resolve({ pid: app.pid }) : Promise.reject(new DaemonError({ code: "unreachable", message: "gone" })),
    hostsApi: {
      restart: () => (app.asked++, app.restart()),
      reconnect: (id: string) => (app.reconnected.push(id), Promise.resolve()),
    },
  };
});
vi.mock("./store", () => ({
  toast: (text: string, kind: string) => app.toasts.push({ text, kind }),
  useStore: { getState: () => ({ hosts: app.hosts }) },
}));

const host = (patch: Partial<HostInfo>): HostInfo => ({
  id: "studio-mini",
  label: "studio-mini",
  remote: true,
  kind: "tailnet",
  status: "connected",
  message: null,
  daemon_version: "0.2.2",
  hostname: null,
  home: null,
  ...patch,
});

beforeEach(() => {
  vi.useFakeTimers();
  app.hosts = {};
  app.restart = () => Promise.resolve({ pid: 4242 });
  app.pid = 4242;
  app.asked = 0;
  app.reconnected = [];
  app.toasts = [];
  useHostRestarts.setState({ restarts: {} });
});
afterEach(() => vi.useRealTimers());

describe("restarting a host from the app (X120)", () => {
  it("follows the host until a fresh daemon answers, then says its sessions kept running", async () => {
    const mini = host({});
    app.hosts = { [mini.id]: mini };

    await restartHost(mini);
    expect(useHostRestarts.getState().restarts["studio-mini"]).toMatchObject({ phase: "restarting", from: 4242 });
    app.pid = null;
    app.hosts = { [mini.id]: host({ status: "error" }) };
    await vi.advanceTimersByTimeAsync(2_000);
    expect(app.reconnected).toEqual(["studio-mini"]);
    expect(app.toasts).toEqual([]);

    app.pid = 5151;
    app.hosts = { [mini.id]: mini };
    await vi.advanceTimersByTimeAsync(2_000);
    expect(useHostRestarts.getState().restarts).toEqual({});
    expect(app.toasts).toEqual([{ text: "studio-mini restarted. Its sessions kept running.", kind: "info" }]);
  });

  it("shows why a restart failed on its host", async () => {
    const { DaemonError } = await import("./daemon");
    const mini = host({});
    app.hosts = { [mini.id]: mini };
    app.restart = () => Promise.reject(new DaemonError({ code: "too_old", message: "studio-mini runs moonlet 0.2.1, which can't be restarted from here" }));

    await restartHost(mini);
    expect(useHostRestarts.getState().restarts["studio-mini"]).toEqual({
      phase: "failed",
      text: "studio-mini runs moonlet 0.2.1, which can't be restarted from here",
    });
  });

  it("is restarting from the click: the old failure goes, and a second click asks nothing while the host answers", async () => {
    const mini = host({});
    app.hosts = { [mini.id]: mini };
    useHostRestarts.setState({ restarts: { [mini.id]: { phase: "failed", text: "the host did not answer" } } });
    let answer: (v: { pid: number }) => void = () => {};
    app.restart = () => new Promise((resolve) => (answer = resolve));

    const first = restartHost(mini);
    expect(useHostRestarts.getState().restarts["studio-mini"]?.phase).toBe("restarting");
    await restartHost(mini);
    expect(app.asked).toBe(1);

    answer({ pid: 4242 });
    await first;
    expect(useHostRestarts.getState().restarts["studio-mini"]).toMatchObject({ phase: "restarting", from: 4242 });
  });
});
