import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitStatus, Session } from "./protocol";
import { refreshGit, useStore } from "./store";

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
