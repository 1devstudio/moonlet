import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "./protocol";
import { useStore } from "./store";
import { modeOf, setMode, toggleMode } from "./mode";

const ws = (id: string): Workspace => ({ id, name: id, color: "clay", section_ids: [], created_at: 0 });
const hosts = { local: { id: "local", label: "This Mac", remote: false, status: "connected" as const, message: null, daemon_version: null, hostname: null, home: null } };

/** A fresh app reading what the last one saved: the store lives on `globalThis`. */
async function restart() {
  delete (globalThis as { __moonletStore?: unknown }).__moonletStore;
  vi.resetModules();
  return { store: await import("./store"), mode: await import("./mode") };
}

beforeEach(() => {
  useStore.setState({
    hosts,
    workspaces: { local: [ws("personal"), ws("acme")] },
    workspace: { host: "local", id: "personal" },
    mode: {},
  });
});

describe("the sidebar's mode (X45, X65)", () => {
  it("is Sessions until the shown workspace switches, and each workspace keeps its own", () => {
    expect(modeOf(useStore.getState())).toBe("sessions");
    setMode("design");
    expect(modeOf(useStore.getState())).toBe("design");
    useStore.setState({ workspace: { host: "local", id: "acme" } });
    expect(modeOf(useStore.getState())).toBe("sessions");
    setMode("tasks");
    useStore.setState({ workspace: { host: "local", id: "personal" } });
    expect(modeOf(useStore.getState())).toBe("design");
  });

  it("a mode's shortcut opens it, and pressed again goes back to Sessions", () => {
    toggleMode("design");
    expect(modeOf(useStore.getState())).toBe("design");
    toggleMode("tasks");
    expect(modeOf(useStore.getState())).toBe("tasks");
    toggleMode("tasks");
    expect(modeOf(useStore.getState())).toBe("sessions");
  });

  it("is remembered across restarts", async () => {
    setMode("design");
    const { store, mode } = await restart();
    store.useStore.setState({ hosts, workspaces: { local: [ws("personal"), ws("acme")] } });
    expect(mode.modeOf(store.useStore.getState())).toBe("design");
  });

  it("opens in Tasks where an older version saved Tasks mode", async () => {
    localStorage.setItem("moonlet.ui", JSON.stringify({ workspace: { host: "local", id: "acme" }, tasksMode: { "local/acme": true, "local/personal": false } }));
    const { store, mode } = await restart();
    store.useStore.setState({ hosts, workspaces: { local: [ws("personal"), ws("acme")] } });
    expect(mode.modeOf(store.useStore.getState())).toBe("tasks");
    store.useStore.setState({ workspace: { host: "local", id: "personal" } });
    expect(mode.modeOf(store.useStore.getState())).toBe("sessions");
  });
});
