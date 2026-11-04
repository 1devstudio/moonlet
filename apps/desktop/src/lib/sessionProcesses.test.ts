import { describe, expect, it } from "vitest";
import { archivePrompt } from "./confirmOptions";
import type { ProcessesKilled, SessionProcess, SessionProcesses } from "./protocol";
import { cpuPercent, killParams, processLooks, processRow, processesSummary, runningLine, stillRunningLine, stoppedByStopAll, toStopOnArchive, withRunning } from "./sessionProcesses";

const NOW = 1_793_700_000_000;
const dev = { kind: "terminal", id: 2, title: "dev" } as const;
const claude = { kind: "agent", id: 3, title: "Claude" } as const;
const proc = (pid: number, name: string, origin: SessionProcess["origin"], tab = false): SessionProcess => ({ pid, name, origin, tab, started: NOW - 60_000, cpu_ms: 10, rss: 1 << 20 });

const list: SessionProcesses = {
  processes: [proc(4100, "zsh", dev, true), proc(4242, "vite", dev), proc(4250, "tail", dev), proc(4300, "claude", claude, true), proc(4310, "node", claude)],
  leftovers: [proc(5151, "node", { kind: "leftover", parent: "launchd" })],
};

describe("archiving a session with processes (X83)", () => {
  it("names the processes still running, after their count", () => {
    expect(runningLine(list)).toBe("4 processes still run: vite, tail, node ×2. Archiving stops them.");
    expect(runningLine({ processes: [proc(4242, "vite", dev)], leftovers: [] })).toBe("1 process still runs: vite. Archiving stops it.");
    expect(toStopOnArchive(list).map((p) => p.pid)).toEqual([4242, 4250, 4310, 5151]);
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

describe("the Processes tab (X83)", () => {
  it("describes a process row: origin, age, CPU and memory", () => {
    const vite: SessionProcess = { pid: 4242, name: "vite", origin: dev, tab: false, started: NOW - 2 * 3600_000 - 60_000, cpu_ms: 72_500, rss: 210 << 20 };
    expect(processRow(vite, NOW, 12.4)).toEqual({ pid: 4242, name: "vite", origin: "Terminal · dev", age: "2h", cpu: "12%", memory: "210 MB", stop: true });
    const agent: SessionProcess = { pid: 4300, name: "claude", origin: claude, tab: true, started: NOW - 42_000, rss: 900 << 10 };
    expect(processRow(agent, NOW, null)).toEqual({ pid: 4300, name: "claude", origin: "Agent · Claude", age: "42s", cpu: "–", memory: "900 KB", stop: false });
    const left: SessionProcess = { pid: 5151, name: "node", origin: { kind: "leftover", parent: "launchd" }, tab: false, started: NOW - 6 * 86_400_000, rss: 3 * 2 ** 30 };
    expect(processRow(left, NOW, 0.2)).toEqual({ pid: 5151, name: "node", origin: "launchd", age: "6d", cpu: "0%", memory: "3.0 GB", stop: true });
    // A Linux host's leftovers were left to init.
    const linux: SessionProcess = { pid: 5152, name: "node", origin: { kind: "leftover", parent: "init" }, tab: false };
    expect(processRow(linux, NOW, null).origin).toBe("init");
    const script: SessionProcess ={ pid: 4250, name: "node", origin: { kind: "run", id: 4, title: "dev" }, tab: false };
    expect(processRow(script, NOW, null).origin).toBe("Run · dev");
    expect(processesSummary(list)).toBe("5 processes · 1 left in the worktree");
    expect(processesSummary({ processes: [proc(4242, "vite", dev)], leftovers: [] })).toBe("1 process");
  });

  it("Stop all covers what the daemon stops: neither the tabs' own nor what was left in the worktree", () => {
    expect(stoppedByStopAll(list).map((p) => p.pid)).toEqual([4242, 4250, 4310]);
    expect(stoppedByStopAll({ processes: [proc(4100, "zsh", dev, true)], leftovers: [proc(5151, "node", { kind: "leftover", parent: "launchd" })] })).toEqual([]);
  });

  it("stops a row by its pid and the start it was listed with; Stop all names none", () => {
    // The start the kernel keeps (on Linux, ticks since boot), never the
    // time shown, which a clock change moves.
    const vite: SessionProcess = { pid: 4242, name: "vite", origin: dev, tab: false, start: 171_234, started: 1_793_699_880_000 };
    const unknown: SessionProcess = { pid: 4320, name: "?", origin: dev, tab: false };
    expect(killParams("s1", [vite, unknown])).toEqual({ id: "s1", pids: [{ pid: 4242, start: 171_234 }, 4320] });
    expect(killParams("s1")).toEqual({ id: "s1" });
  });

  it("says which processes still run after their Stop", () => {
    expect(stillRunningLine({ ended: [4242], skipped: [], gone: [], still_running: [4250, 4251] })).toBe("2 processes still run after SIGKILL: 4250, 4251.");
    expect(stillRunningLine({ ended: [], skipped: [], gone: [], still_running: [4250] })).toBe("1 process still runs after SIGKILL: 4250.");
    expect(stillRunningLine({ ended: [4242], skipped: [], gone: [5151], still_running: [] })).toBeNull();
    // An older daemon says nothing of them.
    expect(stillRunningLine({ ended: [4242], skipped: [] } as unknown as ProcessesKilled)).toBeNull();
    expect(stillRunningLine(true)).toBeNull();
  });

  it("keeps only the latest look at the session shown", () => {
    const looks = processLooks();
    looks.show("local", "s1");
    const first = looks.begin("local", "s1");
    const second = looks.begin("local", "s1");
    // A slow look answering after a newer one is dropped.
    expect(looks.current(first)).toBe(false);
    expect(looks.current(second)).toBe(true);
    // Once another session shows, its looks and a Stop's refresh of s1 are dropped.
    looks.show("local", "s2");
    expect(looks.current(second)).toBe(false);
    const shownLook = looks.begin("local", "s2");
    expect(looks.current(looks.begin("local", "s1"))).toBe(false);
    // ...without dropping the look at s2 under way.
    expect(looks.current(shownLook)).toBe(true);
    expect(looks.current(looks.begin("local", "s2"))).toBe(true);
    // The same session id on another host is another session.
    looks.show("mini", "s2");
    expect(looks.current(looks.begin("local", "s2"))).toBe(false);
  });

  it("works out CPU use from two looks", () => {
    // 1.5 s of CPU in 3 s: half a core.
    expect(cpuPercent({ cpu_ms: 1_000, at: NOW }, { cpu_ms: 2_500, at: NOW + 3_000 })).toBe(50);
    // Two cores busy for the whole 2 s.
    expect(cpuPercent({ cpu_ms: 0, at: NOW }, { cpu_ms: 4_000, at: NOW + 2_000 })).toBe(200);
    // No earlier look, no time between them, or a pid that started again.
    expect(cpuPercent(undefined, { cpu_ms: 2_500, at: NOW })).toBeNull();
    expect(cpuPercent({ cpu_ms: 1_000, at: NOW }, { cpu_ms: 2_500, at: NOW })).toBeNull();
    expect(cpuPercent({ cpu_ms: 9_000, at: NOW }, { cpu_ms: 10, at: NOW + 3_000 })).toBeNull();
  });
});
