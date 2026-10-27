import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostInfo } from "./protocol";
import { announceOlderHosts, updateAll, updateHost, useHostUpdates } from "./hostUpdateStore";

/** The hosts as the app sees them, which tests change, and what each host
 * answers to `host_update`. */
const app = vi.hoisted(() => ({
  hosts: {} as Record<string, HostInfo>,
  answers: {} as Record<string, () => Promise<unknown>>,
  reconnected: [] as string[],
  toasts: [] as { text: string; action?: string }[],
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
    hostsApi: {
      update: (id: string) => app.answers[id](),
      reconnect: (id: string) => (app.reconnected.push(id), Promise.resolve()),
    },
  };
});
vi.mock("./store", () => ({
  toast: (text: string, _kind: string, action?: { label: string }) => app.toasts.push({ text, action: action?.label }),
  useStore: { getState: () => ({ hosts: app.hosts }) },
}));

const host = (patch: Partial<HostInfo>): HostInfo => ({
  id: "studio-mini",
  label: "studio-mini",
  remote: true,
  kind: "tailnet",
  status: "connected",
  message: null,
  daemon_version: "0.1.33",
  hostname: null,
  home: null,
  ...patch,
});

beforeEach(() => {
  vi.useFakeTimers();
  app.hosts = {};
  app.answers = {};
  app.reconnected = [];
  app.toasts = [];
  useHostUpdates.setState({ updates: {} });
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe("updating a host from the app (X69)", () => {
  it("follows the host until it runs the new version, asking it to connect again meanwhile", async () => {
    const mini = host({ status: "needs_update" });
    app.hosts = { [mini.id]: mini };
    app.answers[mini.id] = () => Promise.resolve({ from: "0.1.33", to: "0.1.34" });

    await updateHost(mini, "0.1.34");
    expect(useHostUpdates.getState().updates["studio-mini"]).toMatchObject({ phase: "updating", to: "0.1.34" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(app.reconnected).toEqual(["studio-mini"]);

    app.hosts = { [mini.id]: host({ status: "connected", daemon_version: "0.1.34" }) };
    await vi.advanceTimersByTimeAsync(2_000);
    expect(useHostUpdates.getState().updates).toEqual({});
  });

  it("shows why an update failed on its host, and Update all carries on with the others", async () => {
    const { DaemonError } = await import("./daemon");
    const tooOld = (message: string) => new DaemonError({ code: "too_old", message });
    const box = host({ id: "build-box", label: "build-box", os: "linux", daemon_version: "0.1.32" });
    const mini = host({});
    app.hosts = { [box.id]: box, [mini.id]: mini };
    app.answers[box.id] = () => Promise.reject(tooOld("build-box runs moonlet 0.1.32, which can't be updated from here"));
    app.answers[mini.id] = () => Promise.resolve({ from: "0.1.33", to: "0.1.34" });

    updateAll(Object.values(app.hosts), "0.1.34");
    await vi.advanceTimersByTimeAsync(0);
    expect(useHostUpdates.getState().updates).toMatchObject({
      "build-box": { phase: "failed", text: "build-box runs moonlet 0.1.32, which can't be updated from here: run this there" },
      "studio-mini": { phase: "updating", to: "0.1.34" },
    });
  });

  it("reads the error Tauri hands back as a plain object", async () => {
    const box = host({ id: "build-box", label: "build-box", os: "linux", daemon_version: "0.1.32" });
    app.hosts = { [box.id]: box };
    app.answers[box.id] = () => Promise.reject({ code: "too_old", message: "build-box runs moonlet 0.1.32, which can't be updated from here" });
    await updateHost(box, "0.1.34");
    expect(useHostUpdates.getState().updates["build-box"]).toEqual({
      phase: "failed",
      text: "build-box runs moonlet 0.1.32, which can't be updated from here: run this there",
      command: "curl -fsSL https://github.com/1devstudio/moonlet/releases/latest/download/install.sh | sh",
    });
  });

  it("forgets the update of a host removed meanwhile, so the same host can update again", async () => {
    const mini = host({});
    app.hosts = { [mini.id]: mini };
    let answer = (_: unknown) => {};
    app.answers[mini.id] = () => new Promise((resolve) => (answer = resolve));
    const running = updateHost(mini, "0.1.34");
    app.hosts = {};
    answer({ from: "0.1.33", to: "0.1.34" });
    await running;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(useHostUpdates.getState().updates).toEqual({});

    app.hosts = { [mini.id]: mini };
    app.answers[mini.id] = () => Promise.resolve({ from: "0.1.33", to: "0.1.34" });
    await updateHost(mini, "0.1.34");
    expect(useHostUpdates.getState().updates["studio-mini"]).toMatchObject({ phase: "updating" });
  });

  it("offers Update all once per app version", () => {
    const hosts = [host({}), host({ id: "build-box", label: "build-box" })];
    announceOlderHosts(hosts, "0.1.34");
    announceOlderHosts(hosts, "0.1.34");
    expect(app.toasts).toEqual([{ text: "2 hosts run an older moonlet", action: "Update all" }]);
    announceOlderHosts([host({ daemon_version: "0.1.34" })], "0.1.35");
    expect(app.toasts).toHaveLength(2);
    announceOlderHosts([host({ daemon_version: "0.1.35" })], "0.1.35");
    expect(app.toasts).toHaveLength(2);
  });
});
