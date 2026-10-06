import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installShortcuts } from "./keys";
import { askConfirm } from "./confirm";
import { useStore } from "./store";

vi.mock("./daemon", () => ({ rpc: vi.fn(), sendInput: vi.fn() }));

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
