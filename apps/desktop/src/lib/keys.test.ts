import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { claimKeys, installShortcuts } from "./keys";
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
      workspaces: { local: [ws("personal", "Personal"), ws("acme", "Acme")] },
      sessions: { local: [session("s1", "personal"), session("s2", "acme")] },
      workspace: { host: "local", id: "personal" },
      selected: { host: "local", session: "s1" },
      lastSession: { "local/acme": "s2" },
    }),
  );

  it("⌃⌘2 switches to the second workspace and reopens its last session", () => {
    ctrlCmd("2");
    expect(useStore.getState().workspace).toEqual({ host: "local", id: "acme" });
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

describe("font size shortcuts (X37)", () => {
  const press = (key: string, shiftKey = false, target: Element = document.body) => target.dispatchEvent(new KeyboardEvent("keydown", { key, metaKey: true, shiftKey, bubbles: true }));
  const fontSize = () => useStore.getState().settings.term.fontSize;
  const givenFontSize = (size: number) => useStore.setState((s) => ({ settings: { ...s.settings, term: { ...s.settings.term, fontSize: size } } }));

  beforeAll(() => installShortcuts());
  beforeEach(() => {
    useStore.setState({ confirm: null, dialog: null });
    givenFontSize(13);
  });

  it("⌘= and ⌘+ make the text 1px bigger", () => {
    press("=");
    expect(fontSize()).toBe(14);
    press("+", true);
    expect(fontSize()).toBe(15);
    press("+");
    expect(fontSize()).toBe(16);
  });

  it("⌘− makes the text 1px smaller", () => {
    press("-");
    expect(fontSize()).toBe(12);
  });

  it("⌘0 goes back to the default 13px", () => {
    givenFontSize(20);
    press("0");
    expect(fontSize()).toBe(13);
  });

  it("stop at 9px and 24px", () => {
    givenFontSize(24);
    press("=");
    expect(fontSize()).toBe(24);
    givenFontSize(9);
    press("-");
    expect(fontSize()).toBe(9);
  });

  it("work from a terminal, the chat input and an editor", () => {
    document.body.innerHTML = '<div class="xterm"><textarea id="term"></textarea></div><textarea id="chat"></textarea><div class="monaco-editor"><textarea id="editor"></textarea></div>';
    press("=", false, document.getElementById("term")!);
    expect(fontSize()).toBe(14);
    press("=", false, document.getElementById("chat")!);
    expect(fontSize()).toBe(15);
    press("-", false, document.getElementById("editor")!);
    expect(fontSize()).toBe(14);
    document.body.innerHTML = "";
  });

  it("are off while a dialog is open", () => {
    useStore.setState({ dialog: { kind: "palette" } });
    press("=");
    expect(fontSize()).toBe(13);
  });

  it("are off while the confirm modal is open", () => {
    givenFontSize(20);
    void askConfirm({ title: "Close agent", message: "Stop the claude running in this tab?", action: "Stop agent" });
    press("=");
    expect(fontSize()).toBe(20);
    press("0");
    expect(fontSize()).toBe(20);
  });
});

describe("keys a screen takes (X65)", () => {
  const press = (key: string) => document.body.dispatchEvent(new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true }));
  const fontSize = () => useStore.getState().settings.term.fontSize;

  beforeAll(() => installShortcuts());
  beforeEach(() => {
    useStore.setState((s) => ({ confirm: null, dialog: null, sidebarOpen: true, settings: { ...s.settings, term: { ...s.settings.term, fontSize: 13 } } }));
  });

  it("go to the design screen while it claims them, and back to the app once it lets go", () => {
    const got: string[] = [];
    const release = claimKeys((id) => (id === "cmd+=" || id === "cmd+0" ? (got.push(id), true) : false));
    press("=");
    press("0");
    // A key it does not take is still the app's.
    press("b");
    expect(got).toEqual(["cmd+=", "cmd+0"]);
    expect(fontSize()).toBe(13);
    expect(useStore.getState().sidebarOpen).toBe(false);
    release();
    press("=");
    expect(got).toEqual(["cmd+=", "cmd+0"]);
    expect(fontSize()).toBe(14);
  });
});

describe("the settings page (X43)", () => {
  beforeAll(() => installShortcuts());
  beforeEach(() => useStore.setState({ confirm: null, dialog: null, settingsPage: null, sidebarOpen: true }));

  it("⌘, opens it at General", () => {
    cmd(",");
    expect(useStore.getState().settingsPage).toEqual({ page: "general" });
  });

  it("leaves every key, ⌘K too, to a shortcut being recorded", () => {
    useStore.setState({ settingsPage: { page: "shortcuts" } });
    document.body.innerHTML = '<button data-recording-shortcut="commit">Press a shortcut…</button>';
    cmd("k");
    expect(useStore.getState().dialog).toBeNull();
    document.body.innerHTML = "";
  });

  it("turns the other shortcuts off while it is open, except ⌘K", () => {
    useStore.setState({ settingsPage: { page: "agents" } });
    cmd("b");
    expect(useStore.getState().sidebarOpen).toBe(true);
    cmd("k");
    expect(useStore.getState().dialog).toEqual({ kind: "palette" });
    expect(useStore.getState().settingsPage).toEqual({ page: "agents" });
  });
});
