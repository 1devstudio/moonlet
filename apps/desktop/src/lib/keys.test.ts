import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installShortcuts } from "./keys";
import { askConfirm } from "./confirm";
import { useStore } from "./store";

vi.mock("./daemon", () => ({ rpc: vi.fn(), sendInput: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: () => Promise.resolve() }) }));

const cmd = (key: string) => document.body.dispatchEvent(new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true }));

describe("global shortcuts", () => {
  beforeAll(() => installShortcuts());
  beforeEach(() => useStore.setState({ confirm: null, dialog: null, sidebarOpen: true }));

  it("toggle the sidebar with ⌘B", () => {
    cmd("b");
    expect(useStore.getState().sidebarOpen).toBe(false);
  });

  it("are off while the confirm modal is open", () => {
    void askConfirm({ title: "Close agent", message: "Stop the claude running in this tab?", action: "Stop agent" });
    cmd("b");
    cmd("k");
    expect(useStore.getState().sidebarOpen).toBe(true);
    expect(useStore.getState().dialog).toBeNull();
  });
});

describe("workspace shortcuts (X32)", () => {
  const ctrlCmd = (key: string) => document.body.dispatchEvent(new KeyboardEvent("keydown", { key, metaKey: true, ctrlKey: true, bubbles: true }));
  const host = { id: "local", label: "This Mac", remote: false, status: "connected" as const, message: null, daemon_version: null, hostname: null, home: null };
  const ws = (id: string, name: string) => ({ id, name, color: "clay" as const, section_ids: [], created_at: 0 });
  const session = (id: string, workspace_id: string) => ({ id, project_id: "p", name: id, branch: "b", base: "main", path: `/w/${id}`, agent: null, archived: false, created_at: 0, workspace_id, terminals: [], layout: null });

  beforeAll(() => installShortcuts());
  beforeEach(() =>
    useStore.setState({
      confirm: null,
      dialog: null,
      hosts: { local: host },
      workspaces: { local: [ws("personal", "Personal"), ws("cipher", "CipherHealth")] },
      sessions: { local: [session("s1", "personal"), session("s2", "cipher")] },
      workspace: { host: "local", id: "personal" },
      selected: { host: "local", session: "s1" },
      lastSession: { "local/cipher": "s2" },
    }),
  );

  it("⌃⌘2 switches to the second workspace and reopens its last session", () => {
    ctrlCmd("2");
    expect(useStore.getState().workspace).toEqual({ host: "local", id: "cipher" });
    expect(useStore.getState().selected).toEqual({ host: "local", session: "s2" });
    ctrlCmd("1");
    expect(useStore.getState().workspace).toEqual({ host: "local", id: "personal" });
    expect(useStore.getState().selected).toEqual({ host: "local", session: "s1" });
  });

  it("⌃⌘ with a number past the last workspace does nothing", () => {
    ctrlCmd("5");
    expect(useStore.getState().workspace).toEqual({ host: "local", id: "personal" });
  });
});
