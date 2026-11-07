import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveSession, restoreSession } from "./actions";
import { LOADERS } from "./archiveLoader";
import { useStore } from "./store";
import { answerConfirm, type ConfirmOptions } from "./confirm";
import type { PullRequest, Session } from "./protocol";
import { DEFAULT_GIT_SETTINGS } from "./gitSettings";

const daemon = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./daemon", () => ({ rpc: daemon.rpc, sendInput: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: () => Promise.resolve() }) }));

// Answers the confirm modal as soon as it opens, like a click on its buttons,
// keeping what it asked.
let reply: { ok: boolean; checked: boolean; alt?: boolean } = { ok: true, checked: false };
let asked: ConfirmOptions | null = null;
useStore.subscribe((s) => {
  if (!s.confirm) return;
  asked = s.confirm.options;
  answerConfirm(reply.ok, reply.checked, reply.alt);
});
const askedText = () => (typeof asked?.message === "function" ? asked.message(false) : asked?.message);

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

/** The daemon: nothing unpushed, and `archive` for session.archive. */
const answers = (archive: unknown, unpushed: unknown = { files: [], commits: 0, upstream: null }) =>
  daemon.rpc.mockImplementation(async (_host: string, method: string) => (method === "git.unpushed" ? unpushed : method === "session.archive" ? archive : true));
const archived = () => daemon.rpc.mock.calls.filter((c) => c[1] === "session.archive");

describe("archiveSession", () => {
  beforeEach(() => {
    daemon.rpc.mockReset();
    answers(undefined);
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
    const done = archiveSession();
    await vi.runAllTimersAsync();
    await done;
    expect(daemon.rpc).toHaveBeenCalledWith("local", "session.archive", { id: "s1", remove_worktree: true, delete_branch: false, delete_remote: false });
  });

  it("deletes the branch too when the modal's box is checked", async () => {
    reply = { ok: true, checked: true };
    const done = archiveSession();
    await vi.runAllTimersAsync();
    await done;
    expect(daemon.rpc).toHaveBeenCalledWith("local", "session.archive", { id: "s1", remove_worktree: true, delete_branch: true, delete_remote: false });
  });

  const merged: PullRequest = { number: 7, url: "", state: "merged", title: "s1", checks: [], review_decision: null };

  it("deletes a merged PR's branch without asking, by default (X55)", async () => {
    answers({ remote_error: null });
    useStore.setState({ gitSettings: {}, prs: { "local/s1": merged } });
    const done = archiveSession();
    await vi.runAllTimersAsync();
    await done;
    expect(daemon.rpc).toHaveBeenCalledWith("local", "session.archive", { id: "s1", remove_worktree: true, delete_branch: true, delete_remote: false });
  });

  it("says when origin refused to delete the branch (X55)", async () => {
    answers({ remote_error: "remote rejected" });
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

  it("pushes first when asked to, then archives (X55)", async () => {
    answers({ remote_error: null }, { files: [], commits: 2, upstream: null });
    reply = { ok: true, checked: false, alt: true };
    const done = archiveSession();
    await vi.runAllTimersAsync();
    await done;
    expect(daemon.rpc.mock.calls.map((c) => c[1])).toEqual(["git.unpushed", "session.processes", "git.push", "session.archive"]);
  });

  it("names the member that runs a copy where its unpushed work is (X88)", async () => {
    const copy: Session = { ...ws, id: "s7", owner: { worker: "book-id", name: "MacBook", reachable: true } };
    useStore.setState({ sessions: { "local#copy:s7": [copy] }, selected: { host: "local#copy:s7", session: "s7" } });
    answers(undefined, { files: [], commits: 2, upstream: null });
    reply = { ok: false, checked: false };
    const done = archiveSession();
    await vi.runAllTimersAsync();
    await done;
    expect(asked?.unpushed?.heading).toBe("This work is only on MacBook");
  });

  const running = {
    processes: [
      { pid: 4100, name: "zsh", origin: { kind: "terminal", id: 1, title: "zsh" }, tab: true },
      { pid: 4242, name: "vite", origin: { kind: "terminal", id: 1, title: "zsh" }, tab: false, start: 1_793_700_000_000_123, started: 1_793_700_000_000 },
      { pid: 4310, name: "tail", origin: { kind: "agent", id: 3, title: "Claude" }, tab: false },
    ],
    leftovers: [{ pid: 5151, name: "node", origin: { kind: "leftover", parent: "launchd" }, tab: false, start: 1_793_100_000_000_456, started: 1_793_100_000_000 }],
  };

  it("lists the processes still running and stops them before archiving (X83)", async () => {
    daemon.rpc.mockImplementation(async (_h: string, method: string) => (method === "session.processes" ? running : method === "git.unpushed" ? { files: [], commits: 0, upstream: null } : true));
    const done = archiveSession();
    await vi.runAllTimersAsync();
    await done;
    expect(askedText()).toBe('Archive "s1"? Its terminals stop and the worktree folder is removed. The branch is kept. 3 processes still run: vite, tail, node. Archiving stops them.');
    expect(daemon.rpc.mock.calls.map((c) => c[1])).toEqual(["git.unpushed", "session.processes", "session.kill_processes", "session.processes", "session.kill_processes", "session.archive"]);
    // What was left in the worktree, each with the start it was listed with,
    // so a pid reused meanwhile is left alone.
    expect(daemon.rpc).toHaveBeenCalledWith("local", "session.kill_processes", { id: "s1", pids: [{ pid: 5151, start: 1_793_100_000_000_456 }] });
  });

  it("stops what the session runs once Archive is chosen, not only what the confirm listed (X83)", async () => {
    // A server started, and another left in the worktree, while the confirm was open.
    const later = {
      processes: [...running.processes, { pid: 4400, name: "vite", origin: { kind: "terminal", id: 1, title: "zsh" }, tab: false, start: 1_793_700_100_000_000 }],
      leftovers: [...running.leftovers, { pid: 5200, name: "python3", origin: { kind: "leftover", parent: "launchd" }, tab: false, start: 1_793_700_200_000_000 }],
    };
    let looks = 0;
    daemon.rpc.mockImplementation(async (_h: string, method: string) => {
      if (method === "session.processes") return looks++ ? later : running;
      if (method === "session.kill_processes") return { ended: [], skipped: [], gone: [], still_running: [] };
      return method === "git.unpushed" ? { files: [], commits: 0, upstream: null } : true;
    });
    const done = archiveSession();
    await vi.runAllTimersAsync();
    await done;
    const kills = daemon.rpc.mock.calls.filter((c) => c[1] === "session.kill_processes").map((c) => c[2]);
    // Stop all, which the daemon works out as it is asked, then what is left
    // in the worktree now, each by the start it is listed with now.
    expect(kills).toEqual([
      { id: "s1" },
      {
        id: "s1",
        pids: [
          { pid: 5151, start: 1_793_100_000_000_456 },
          { pid: 5200, start: 1_793_700_200_000_000 },
        ],
      },
    ]);
    expect(daemon.rpc.mock.calls.at(-1)?.[1]).toBe("session.archive");
  });

  it("says what still runs after archiving's Stop, from both of its stops (X83)", async () => {
    daemon.rpc.mockImplementation(async (_h: string, method: string, params: { pids?: unknown[] }) => {
      if (method === "session.processes") return running;
      if (method === "session.kill_processes") return { ended: [], skipped: [], gone: [], still_running: params.pids ? [5151] : [4310] };
      return method === "git.unpushed" ? { files: [], commits: 0, upstream: null } : true;
    });
    const shown = new Set<string>();
    const stop = useStore.subscribe((s) => s.toasts.forEach((t) => shown.add(t.text)));
    const done = archiveSession();
    await vi.runAllTimersAsync();
    await done;
    stop();
    expect([...shown]).toContain("2 processes still run after SIGKILL: 4310, 5151.");
  });

  it("archives as before when the daemon cannot list processes (X83)", async () => {
    daemon.rpc.mockImplementation(async (_h: string, method: string) => {
      if (method === "session.processes") throw new Error("unknown method: session.processes");
      return method === "git.unpushed" ? { files: [], commits: 0, upstream: null } : true;
    });
    const done = archiveSession();
    await vi.runAllTimersAsync();
    await done;
    expect(askedText()).toBe('Archive "s1"? Its terminals stop and the worktree folder is removed. The branch is kept.');
    expect(daemon.rpc.mock.calls.map((c) => c[1])).toEqual(["git.unpushed", "session.processes", "session.archive"]);
  });

  it("archives nothing when the push fails (X55)", async () => {
    daemon.rpc.mockImplementation(async (_h: string, method: string) => {
      if (method === "git.unpushed") return { files: [], commits: 2, upstream: null };
      if (method === "git.push") throw new Error("rejected");
      return true;
    });
    reply = { ok: true, checked: false, alt: true };
    const done = archiveSession();
    await vi.runAllTimersAsync();
    await done;
    expect(archived()).toEqual([]);
  });

  it("doesn't look for unpushed work with the warning off (X55)", async () => {
    useStore.setState({ gitSettings: { local: { ...DEFAULT_GIT_SETTINGS, archive_branch: "ask", warn_unpushed: false } } });
    const done = archiveSession();
    await vi.runAllTimersAsync();
    await done;
    expect(daemon.rpc.mock.calls.map((c) => c[1])).toEqual(["session.processes", "session.archive"]);
  });

  it("does nothing when the modal is cancelled", async () => {
    reply = { ok: false, checked: true };
    await archiveSession();
    expect(archived()).toEqual([]);
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

describe("restoreSession (X86)", () => {
  const old = { ...ws, archived: true, archived_at: 5 };
  beforeEach(() => {
    daemon.rpc.mockReset();
    useStore.setState({ sessions: { local: [old] }, selected: null, toasts: [], showHistory: true });
  });

  it("restores the session and shows it, live", async () => {
    daemon.rpc.mockImplementation(async (_host: string, method: string) => (method === "session.unarchive" ? { ...old, archived: false, archived_at: null, terminals: [7] } : true));
    await restoreSession("local", old);
    const st = useStore.getState();
    expect([st.selected, st.sessions.local[0].archived, st.showHistory, st.toasts.map((t) => t.text)]).toEqual([{ host: "local", session: "s1" }, false, false, ["Restored s1"]]);
  });

  it("says why it could not, and leaves it archived", async () => {
    daemon.rpc.mockImplementation(async () => {
      throw new Error("cannot add the worktree");
    });
    await restoreSession("local", old);
    const st = useStore.getState();
    expect([st.sessions.local[0].archived, st.toasts.map((t) => t.text)]).toEqual([true, ["cannot add the worktree"]]);
  });
});
