import { beforeEach, describe, expect, it, vi } from "vitest";
import { archiveSession } from "./actions";
import { useStore } from "./store";
import type { Session } from "./protocol";

const daemon = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./daemon", () => ({ rpc: daemon.rpc, sendInput: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: () => Promise.resolve(true) }));

const ws: Session = {
  id: "s1",
  project_id: "p",
  name: "s1",
  branch: "jaunt/s1",
  base: "main",
  path: "/w/s1",
  agent: "claude",
  archived: false,
  created_at: 0,
  terminals: [],
  layout: null,
};

describe("archiveSession", () => {
  beforeEach(() => {
    daemon.rpc.mockReset();
    useStore.setState({ sessions: { local: [ws] }, selected: { host: "local", session: "s1" }, toasts: [] });
  });

  it("closes the session's views before the worktree is removed", async () => {
    let selectedDuringArchive: unknown = "unset";
    daemon.rpc.mockImplementation(async () => {
      selectedDuringArchive = useStore.getState().selected;
    });
    await archiveSession();
    expect(selectedDuringArchive).toBeNull();
    expect(useStore.getState().selected).toBeNull();
  });

  it("selects the session again when archiving fails", async () => {
    daemon.rpc.mockRejectedValue(new Error("boom"));
    await archiveSession();
    expect(useStore.getState().selected).toEqual({ host: "local", session: "s1" });
    expect(useStore.getState().toasts.map((t) => t.text)).toContain("boom");
  });
});
