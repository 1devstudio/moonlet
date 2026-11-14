import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitStatus, Session, TerminalInfo } from "./protocol";
import { pollBackgroundGit, refreshGit, useStore } from "./store";

const daemon = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./daemon", () => ({ rpc: daemon.rpc, sendInput: vi.fn() }));

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

// What `git.status` answers for a worktree with one edited file.
const status = (additions: number): GitStatus => ({
  branch: "moonlet/s1",
  head: "4f2a9c1",
  upstream: null,
  ahead: 1,
  behind: 0,
  against: "main",
  files: [{ path: "src/app.ts", status: "modified", staged: false, unstaged: true, additions, deletions: 2, binary: false }],
  additions,
  deletions: 2,
});

/** How many times the store tells its subscribers (each one a re-render) while `run` runs. */
async function notifications(run: () => Promise<void>): Promise<number> {
  let n = 0;
  const stop = useStore.subscribe(() => n++);
  await run();
  stop();
  return n;
}

describe("background git poll (X78)", () => {
  beforeEach(() => {
    useStore.setState({ sessions: { local: [ws] }, git: {} });
    daemon.rpc.mockReset();
  });

  it("re-renders nothing when the worktree has not changed since the last poll", async () => {
    daemon.rpc.mockResolvedValue(status(5));
    await refreshGit("local", "s1");
    expect(await notifications(() => refreshGit("local", "s1"))).toBe(0);
  });

  it("stores a changed status and tells subscribers once", async () => {
    daemon.rpc.mockResolvedValue(status(5));
    await refreshGit("local", "s1");
    daemon.rpc.mockResolvedValue(status(9));
    expect(await notifications(() => refreshGit("local", "s1"))).toBe(1);
    expect(useStore.getState().git["local/s1"]?.additions).toBe(9);
  });
});

/** The paths `git.status` was asked for, in order. */
const asked = () => daemon.rpc.mock.calls.filter((c) => c[1] === "git.status").map((c) => (c[2] as { path: string }).path);

const session = (id: string): Session => ({ ...ws, id, name: id, path: `/w/${id}` });

describe("background git poll passes (X102)", () => {
  beforeEach(() => {
    daemon.rpc.mockReset();
    useStore.setState({ sessions: { local: [session("a"), session("b")] }, terminals: {}, selected: null, git: {} });
  });

  it("starts no second pass on a host while its first still runs", async () => {
    let answer!: (st: GitStatus) => void;
    daemon.rpc.mockImplementationOnce(() => new Promise<GitStatus>((r) => (answer = r))).mockResolvedValue(status(1));
    const first = pollBackgroundGit("local");
    await pollBackgroundGit("local");
    answer(status(1));
    await first;
    expect(asked()).toEqual(["/w/a", "/w/b"]);
  });

  describe("which sessions a pass checks", () => {
    const t0 = Date.parse("2026-11-14T09:00:00Z");
    /** Runs a pass `ms` after t0. */
    const pollAt = (ms: number) => {
      vi.setSystemTime(t0 + ms);
      return pollBackgroundGit("local");
    };
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      daemon.rpc.mockResolvedValue(status(1));
    });
    afterEach(() => vi.useRealTimers());

    it("checks a session nobody works in again once it has gone 5 minutes without a check", async () => {
      useStore.setState({ sessions: { local: [session("quiet")] } });
      await pollAt(0);
      await pollAt(20_000);
      await pollAt(280_000);
      expect(asked()).toEqual(["/w/quiet"]);
      await pollAt(300_000);
      expect(asked()).toEqual(["/w/quiet", "/w/quiet"]);
    });

    /** A session's agent terminal, as `terminal.list` reports it. */
    const agent = (sessionId: string, agentState: TerminalInfo["agent_state"], lastOutputAt: number): TerminalInfo => ({
      id: 7,
      kind: "agent",
      title: "claude",
      cwd: `/w/${sessionId}`,
      command: ["claude"],
      session_id: sessionId,
      agent: "claude",
      agent_state: agentState,
      cols: 80,
      rows: 24,
      pid: 4242,
      created_at: t0 - 3_600_000,
      last_output_at: lastOutputAt,
    });

    it("checks a session with a working agent on every poll", async () => {
      useStore.setState({ sessions: { local: [session("busy")] }, terminals: { local: { 7: agent("busy", "working", t0 - 3_600_000) } } });
      await pollAt(0);
      await pollAt(20_000);
      expect(asked()).toEqual(["/w/busy", "/w/busy"]);
    });

    it("checks a session on every poll for 5 minutes after its terminal last printed", async () => {
      useStore.setState({ sessions: { local: [session("printed")] }, terminals: { local: { 7: agent("printed", "idle", t0 + 100_000) } } });
      await pollAt(0);
      await pollAt(120_000);
      expect(asked()).toEqual(["/w/printed", "/w/printed"]);
      // 5 minutes after the output, and 280 seconds after the last check.
      await pollAt(400_000);
      expect(asked()).toEqual(["/w/printed", "/w/printed"]);
    });

    it("checks the open session on every poll", async () => {
      useStore.setState({ sessions: { local: [session("open")] }, selected: { host: "local", session: "open" } });
      await pollAt(0);
      await pollAt(20_000);
      expect(asked()).toEqual(["/w/open", "/w/open"]);
    });

    it("checks a session on every poll for 5 minutes after its status changed", async () => {
      useStore.setState({ sessions: { local: [session("moved")] } });
      await pollAt(0);
      await pollAt(300_000);
      daemon.rpc.mockResolvedValue(status(4));
      await pollAt(600_000);
      await pollAt(620_000);
      await pollAt(880_000);
      await pollAt(900_000);
      expect(asked()).toEqual(["/w/moved", "/w/moved", "/w/moved", "/w/moved", "/w/moved"]);
    });
  });
});
