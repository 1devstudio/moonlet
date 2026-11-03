import { describe, expect, it } from "vitest";
import { archivePrompt } from "./confirmOptions";
import type { SessionProcess, SessionProcesses } from "./protocol";
import { runningLine, toStopOnArchive, withRunning } from "./sessionProcesses";

const NOW = 1_793_700_000_000;
const dev = { kind: "terminal", id: 2, title: "dev" } as const;
const claude = { kind: "agent", id: 3, title: "Claude" } as const;
const proc = (pid: number, name: string, origin: SessionProcess["origin"], tab = false): SessionProcess => ({ pid, name, origin, tab, started: NOW - 60_000, cpu_ms: 10, rss: 1 << 20 });

const list: SessionProcesses = {
  processes: [proc(4100, "zsh", dev, true), proc(4242, "vite", dev), proc(4250, "tail", dev), proc(4300, "claude", claude, true), proc(4310, "node", claude)],
  leftovers: [proc(5151, "node", { kind: "leftover" })],
};

describe("archiving a session with processes (X83)", () => {
  it("names the processes still running, after their count", () => {
    expect(runningLine(list)).toBe("4 processes still run: vite, tail, node ×2. Archiving stops them.");
    expect(runningLine({ processes: [proc(4242, "vite", dev)], leftovers: [] })).toBe("1 process still runs: vite. Archiving stops it.");
    expect(toStopOnArchive(list)).toEqual([4242, 4250, 4310, 5151]);
    const shown = withRunning(archivePrompt("Login page"), runningLine(list));
    expect(typeof shown.message === "function" && shown.message(false)).toBe(
      'Archive "Login page"? Its terminals stop and the worktree folder is removed. The branch is kept. 4 processes still run: vite, tail, node ×2. Archiving stops them.',
    );
  });

  it("says nothing when only the tabs' own processes run", () => {
    const tabs = { processes: [proc(4100, "zsh", dev, true), proc(4300, "claude", claude, true)], leftovers: [] };
    expect(runningLine(tabs)).toBeNull();
    expect(runningLine(null)).toBeNull();
    expect(toStopOnArchive(tabs)).toEqual([]);
    const prompt = archivePrompt("Login page");
    expect(withRunning(prompt, null)).toBe(prompt);
  });
});
