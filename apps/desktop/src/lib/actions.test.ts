import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveSession } from "./actions";
import { LOADERS } from "./archiveLoader";
import { useStore } from "./store";
import { answerConfirm } from "./confirm";
import type { PullRequest, Session } from "./protocol";
import { DEFAULT_GIT_SETTINGS } from "./gitSettings";

const daemon = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./daemon", () => ({ rpc: daemon.rpc, sendInput: vi.fn() }));

// Answers the confirm modal as soon as it opens, like a click on its buttons.
let reply = { ok: true, checked: false };
useStore.subscribe((s) => {
  if (s.confirm) answerConfirm(reply.ok, reply.checked);
});

const ws: Session = {
  id: "s1",
  project_id: "p",
  name: "s1",
  branch: "moonlet/s1",
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
    useStore.setState({
      sessions: { local: [ws] },
      selected: { host: "local", session: "s1" },
      toasts: [],
      archiving: {},
      gitSettings: { local: { ...DEFAULT_GIT_SETTINGS, archive_branch: "ask" } },
      prs: {},
    });
    reply = { ok: true, checked: false };
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("keeps the branch unless the modal's box is checked", async () => {
    daemon.rpc.mockResolvedValue(undefined);
    const done = archiveSession();
    await vi.runAllTimersAsync();
    await done;
    expect(daemon.rpc).toHaveBeenCalledWith("local", "session.archive", { id: "s1", remove_worktree: true, delete_branch: false, delete_remote: false });
  });

  it("deletes the branch too when the modal's box is checked", async () => {
    daemon.rpc.mockResolvedValue(undefined);
    reply = { ok: true, checked: true };
    const done = archiveSession();
    await vi.runAllTimersAsync();
    await done;
    expect(daemon.rpc).toHaveBeenCalledWith("local", "session.archive", { id: "s1", remove_worktree: true, delete_branch: true, delete_remote: false });
  });

  const merged: PullRequest = { number: 7, url: "", state: "merged", title: "s1", checks: [], review_decision: null };

  it("deletes a merged PR's branch without asking, by default (X55)", async () => {
    daemon.rpc.mockResolvedValue({ remote_error: null });
    useStore.setState({ gitSettings: {}, prs: { "local/s1": merged } });
    const done = archiveSession();
    await vi.runAllTimersAsync();
    await done;
    expect(daemon.rpc).toHaveBeenCalledWith("local", "session.archive", { id: "s1", remove_worktree: true, delete_branch: true, delete_remote: false });
  });

  it("says when origin refused to delete the branch (X55)", async () => {
    daemon.rpc.mockResolvedValue({ remote_error: "remote rejected" });
    useStore.setState({ gitSettings: { local: { ...DEFAULT_GIT_SETTINGS, delete_remote_branch: true } }, prs: { "local/s1": merged } });
    // Toasts go away on a timer; keep every one shown.
    const shown = new Set<string>();
    const stop = useStore.subscribe((s) => s.toasts.forEach((t) => shown.add(t.text)));
    const done = archiveSession();
    await vi.runAllTimersAsync();
    await done;
    stop();
    expect(daemon.rpc).toHaveBeenCalledWith("local", "session.archive", { id: "s1", remove_worktree: true, delete_branch: true, delete_remote: true });
    expect([...shown]).toContain("Couldn't delete moonlet/s1 on origin: remote rejected");
  });

  it("does nothing when the modal is cancelled", async () => {
    reply = { ok: false, checked: true };
    await archiveSession();
    expect(daemon.rpc).not.toHaveBeenCalled();
    expect(useStore.getState().selected).toEqual({ host: "local", session: "s1" });
  });

  it("plays a random pixel scene in the row while the daemon archives", async () => {
    let during: unknown;
    daemon.rpc.mockImplementation(async () => {
      during = useStore.getState().archiving["local/s1"];
    });
    void archiveSession();
    await vi.waitFor(() => expect(during).toBeDefined());
    expect(during).toMatchObject({ done: false, folding: false });
    expect(LOADERS).toContain((during as { loader: string }).loader);
  });

  it("closes the session's views before the worktree is removed", async () => {
    let selectedDuringArchive: unknown = "unset";
    daemon.rpc.mockImplementation(async () => {
      selectedDuringArchive = useStore.getState().selected;
    });
    const done = archiveSession();
    await vi.runAllTimersAsync();
    await done;
    expect(selectedDuringArchive).toBeNull();
    expect(useStore.getState().selected).toBeNull();
  });

  it("selects the session again when archiving fails", async () => {
    daemon.rpc.mockRejectedValue(new Error("boom"));
    await archiveSession();
    expect(useStore.getState().selected).toEqual({ host: "local", session: "s1" });
    expect(useStore.getState().toasts.map((t) => t.text)).toContain("boom");
  });

  it("plays the scene for one full cycle, then folds the row away and confirms", async () => {
    daemon.rpc.mockResolvedValue(undefined);
    const toasts = () => useStore.getState().toasts.map((t) => t.text);
    const done = archiveSession();
    await vi.advanceTimersByTimeAsync(5900);
    expect(useStore.getState().archiving["local/s1"]).toMatchObject({ done: true, folding: false });
    expect(toasts()).not.toContain("Archived s1");
    await vi.advanceTimersByTimeAsync(100);
    expect(useStore.getState().archiving["local/s1"]).toMatchObject({ done: true, folding: true });
    await vi.advanceTimersByTimeAsync(280);
    await done;
    expect(useStore.getState().archiving).toEqual({});
    expect(toasts()).toContain("Archived s1");
  });

  it("stops the loader at once when archiving fails", async () => {
    daemon.rpc.mockRejectedValue(new Error("boom"));
    await archiveSession();
    expect(useStore.getState().archiving).toEqual({});
  });
});
