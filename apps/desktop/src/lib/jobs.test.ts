import { describe, expect, it } from "vitest";
import { bashChip, chipFromJob, chipFromOutput, jobRowLine, jobStateLine, jobTabLine, jobsSummary, jobsTabCount, outputLines, phaseBar, phaseList, shownCommand, shownLines, workerFacts, workerLine } from "./jobs";
import type { Job } from "./protocol";

const job = (extra: Partial<Job> = {}): Job => ({
  id: "j1",
  session: "s1",
  command: "pnpm test",
  tool_use_id: "toolu_1",
  state: { kind: "running", worker: "Alex's MacBook Pro" },
  started_at: 1000,
  ended_at: null,
  phases: [],
  timeline: [],
  worker: { name: "Alex's MacBook Pro", kind: "mac", load: 1.2, cores: 10, slot: 1, slots: 2, rtt_ms: 6, copy: null },
  brought: [],
  outputs: [],
  leftovers: [],
  env: [],
  summary: null,
  output_bytes: 0,
  ...extra,
});

const done = (ms: number, exit = 0, extra: Partial<Job> = {}) => job({ state: { kind: "done", exit }, started_at: 0, ended_at: ms, ...extra });

describe("the Jobs tab (X62)", () => {
  it("the tab counts every job", () => {
    expect(jobsTabCount([job(), done(1000), done(2000, 1)])).toBe(3);
  });

  it("the summary line, as in the worked examples", () => {
    expect(jobsSummary([], 0)).toBeNull();
    expect(jobsSummary([job({ started_at: 0 })], 42_000)).toBe("1 running · 42s on workers");
    expect(jobsSummary([job({ state: { kind: "waiting", for: "moonlet-shop-m3x9" }, started_at: 0 }), done(38_000), done(72_000), done(123_000)], 70_000)).toBe(
      "1 waiting · 3 done · 3m 53s on workers",
    );
    expect(jobsSummary([done(59_000), done(1_000)], 0)).toBe("2 done · 1m 00s on workers");
  });

  it("a row's second line, as in the worked examples", () => {
    expect(jobRowLine(done(1, 0, { leftovers: ["src/cart.ts"] }), 0)).toEqual({ tone: "muted", icon: "mac", text: "Alex's MacBook Pro · exit 0 · 1 leftover" });
    const rerun = done(1, 0, { timeline: [{ at: 1, text: "Alex's MacBook Pro went away" }], worker: { name: "studio-mini", kind: "central", load: 1, cores: 12, slot: 1, slots: 2 } });
    expect(jobRowLine(rerun, 0)).toEqual({ tone: "blocked", icon: "rerun", text: "Ran again on studio-mini · exit 0" });
    const central = { name: "studio-mini", kind: "central", load: 1, cores: 12, slot: 1, slots: 2 };
    expect(jobRowLine(done(1, 1, { worker: central }), 0)).toEqual({ tone: "error", icon: "central", text: "studio-mini · exit 1" });
    expect(jobRowLine(done(1, 1, { worker: central, summary: "Type error in src/cart.ts:41" }), 0)).toEqual({
      tone: "error",
      icon: "central",
      text: "studio-mini · exit 1 · Type error in src/cart.ts:41",
    });
    expect(jobRowLine(job({ state: { kind: "waiting", for: "moonlet-shop-m3x9" } }), 0)).toEqual({ tone: "accent", icon: "cloud", text: "Waiting for moonlet-shop-m3x9" });
    const cloud = { name: "moonlet-shop-7k2q", kind: "cloud", load: 1, cores: 8, slot: 1, slots: 2 };
    expect(jobRowLine(job({ state: { kind: "running", worker: "moonlet-shop-7k2q" }, started_at: 0, worker: cloud }), 31_000)).toEqual({
      tone: "accent",
      icon: "cloud",
      text: "Running on moonlet-shop-7k2q · 0:31",
    });
    expect(jobRowLine(job({ state: { kind: "stopped", exit: 143 } }), 0)).toEqual({ tone: "muted", icon: "mac", text: "Stopped · Alex's MacBook Pro" });
  });

  it("the state line for each state", () => {
    expect(jobStateLine(job({ started_at: 0 }), 42_000, "fix-cart")).toEqual({ tone: "accent", text: "Running · 0:42 · Claude in fix-cart" });
    expect(jobStateLine(done(38_000, 0, { summary: "457 tests passed" }), 0, "fix-cart")).toEqual({ tone: "done", text: "Done · exit 0 · 38s · Claude in fix-cart · 457 tests passed" });
    expect(jobStateLine(done(72_000, 1), 0, "fix-cart")).toEqual({ tone: "error", text: "Failed · exit 1 · 1m 12s · Claude in fix-cart" });
    expect(jobStateLine(job({ state: { kind: "stopped", exit: 143 }, started_at: 0, ended_at: 5000 }), 0, "fix-cart")).toEqual({ tone: "muted", text: "Stopped · exit 143 · 5s · Claude in fix-cart" });
    expect(jobStateLine(job({ state: { kind: "lost" } }), 0, "fix-cart")).toEqual({ tone: "error", text: "Lost: the central host's daemon stopped during it" });
    expect(jobStateLine(job({ tool_use_id: null, started_at: 0 }), 1000, "fix-cart").text).toBe("Running · 0:01 · in fix-cart");
  });

  it("the phase checklist", () => {
    const running = job({ phases: [{ name: "Copy matched the session", took_ms: 2100 }] });
    expect(phaseList(running, 40_000)).toEqual([
      { name: "Copy matched the session", state: "done", took: "2.1s", detail: null },
      { name: "Running", state: "running", took: "0:39", detail: null },
      { name: "Bring changes back", state: "pending", took: null, detail: null },
      { name: "Exit status to Claude", state: "pending", took: null, detail: null },
    ]);
    // Run on the central host itself: nothing to bring back.
    const here = job({ started_at: 0, worker: { name: "studio-mini", kind: "central", load: 1, cores: 12, slot: 1, slots: 2 } });
    expect(phaseList(here, 5000).map((p) => p.name)).toEqual(["Running", "Exit status to Claude"]);
    const finished = done(10, 0, {
      phases: [
        { name: "Copy matched the session", took_ms: 2100 },
        { name: "Ran on Alex's MacBook Pro", took_ms: 66_000 },
        { name: "Brought back", took_ms: 3800 },
        { name: "Exit status to Claude", took_ms: 0 },
      ],
    });
    expect(phaseList(finished, 0).map((p) => [p.name, p.state, p.took])).toEqual([
      ["Copy matched the session", "done", "2.1s"],
      ["Ran on Alex's MacBook Pro", "done", "1m 06s"],
      ["Brought back", "done", "3.8s"],
      ["Exit status to Claude", "done", null],
    ]);
  });

  it("the rerun timeline", () => {
    const at = new Date(2026, 9, 22, 10, 41, 58).getTime();
    const rerun = done(1, 0, {
      timeline: [
        { at, text: "Started on Alex's MacBook Pro" },
        { at: at + 22_000, text: "Alex's MacBook Pro went away", detail: "It missed 3 pings. That run's changes were dropped." },
      ],
    });
    expect(phaseList(rerun, 0)).toEqual([
      { name: "Started on Alex's MacBook Pro", state: "done", took: "10:41:58", detail: null },
      { name: "Alex's MacBook Pro went away", state: "warn", took: "10:42:20", detail: "It missed 3 pings. That run's changes were dropped." },
    ]);
  });
});

describe("routed Bash rows in the chat (X62)", () => {
  it("the chip from a job", () => {
    expect(chipFromJob(job())).toEqual({ icon: "mac", text: "on Alex's MacBook Pro", rerun: false });
    const rerun = done(1, 0, { timeline: [{ at: 1, text: "Alex's MacBook Pro went away" }], worker: { name: "studio-mini", kind: "central", load: 1, cores: 12, slot: 1, slots: 2 } });
    expect(chipFromJob(rerun)).toEqual({ icon: "rerun", text: "ran again on studio-mini", rerun: true });
  });

  it("the chip from a result's first line", () => {
    expect(chipFromOutput("moonlet: running on Alex's MacBook Pro\n ✓ src/cart.test.ts")).toEqual({ icon: "worker", text: "on Alex's MacBook Pro", rerun: false });
    expect(chipFromOutput("moonlet: running on Alex's MacBook Pro\nx\nmoonlet: Alex's MacBook Pro went away. Running again on studio-mini.\n")).toEqual({
      icon: "rerun",
      text: "ran again on studio-mini",
      rerun: true,
    });
    expect(chipFromOutput("plain output")).toBeNull();
  });

  it("the chip comes from the row's job, and falls back to the result's first line", () => {
    expect(bashChip(job(), "moonlet: running on studio-mini\nok")).toEqual({ icon: "mac", text: "on Alex's MacBook Pro", rerun: false });
    expect(bashChip(undefined, "moonlet: running on studio-mini\nok")).toEqual({ icon: "worker", text: "on studio-mini", rerun: false });
    expect(bashChip(undefined, "ok")).toBeNull();
  });

  it("a rewritten command shows without moonlet exec", () => {
    expect(shownCommand("'/Applications/moonlet.app/Contents/MacOS/moonlet' exec --tool-use toolu_01 -- pnpm test")).toBe("pnpm test");
    expect(shownCommand("'/Users/al'\\''ex/moonlet' exec -- pnpm test --run")).toBe("pnpm test --run");
    expect(shownCommand("pnpm test")).toBe("pnpm test");
  });
});

describe("a job's output (X62)", () => {
  const chunks = [
    { stream: 1 as const, text: "moonlet: running on studio-mini\n> vit" },
    { stream: 1 as const, text: "est run\n \u001b[32m\u2713\u001b[39m src/cart.test.ts (38 tests)\n" },
    { stream: 2 as const, text: "(node:4211) DeprecationWarning: fs.rmdir\n" },
    { stream: 1 as const, text: "moonlet: Alex's MacBook Pro went away. Running again on studio-mini.\n" },
  ];

  it("reads chunks as numbered lines, stdout and stderr apart, without colours", () => {
    expect(outputLines(chunks)).toEqual([
      { n: 1, stream: 1, text: "moonlet: running on studio-mini", tone: "moonlet" },
      { n: 2, stream: 1, text: "> vitest run", tone: null },
      { n: 3, stream: 1, text: " \u2713 src/cart.test.ts (38 tests)", tone: null },
      { n: 4, stream: 2, text: "(node:4211) DeprecationWarning: fs.rmdir", tone: "stderr" },
      { n: 5, stream: 1, text: "moonlet: Alex's MacBook Pro went away. Running again on studio-mini.", tone: "warn" },
    ]);
  });

  it("filters by stream and by what was typed in Find, keeping line numbers", () => {
    const lines = outputLines(chunks);
    expect(shownLines(lines, "stderr", "").map((l) => l.n)).toEqual([4]);
    expect(shownLines(lines, "stdout", "").map((l) => l.n)).toEqual([1, 2, 3, 5]);
    expect(shownLines(lines, "all", "STUDIO").map((l) => l.n)).toEqual([1, 5]);
  });
});

describe("the job tab's phase bar (X62)", () => {
  it("lays the phases out at their lengths, as in job-tab.png", () => {
    const j = done(75_000, 0, {
      phases: [
        { name: "Copy matched the session", took_ms: 2100 },
        { name: "Ran on Alex's MacBook Pro", took_ms: 66_000 },
        { name: "Brought back", took_ms: 3800 },
        { name: "Exit status to Claude", took_ms: 10 },
      ],
      leftovers: ["src/cart.ts"],
    });
    expect(phaseBar(j, 75_000)).toEqual([
      { label: "Copy matched", took: "2.1s", percent: 3, tone: "done" },
      { label: "Ran on Alex's MacBook Pro", took: "1m 06s", percent: 90, tone: "done" },
      { label: "Brought back", took: "3.8s", percent: 5, tone: "blocked" },
      { label: "To Claude", took: null, percent: 2, tone: "done" },
    ]);
  });

  it("ends with the run going on while a job runs", () => {
    const j = job({ started_at: 0, phases: [{ name: "Copy matched the session", took_ms: 2000 }] });
    expect(phaseBar(j, 42_000)).toEqual([
      { label: "Copy matched", took: "2.0s", percent: 5, tone: "done" },
      { label: "Running", took: "0:40", percent: 95, tone: "accent" },
    ]);
  });
});

describe("the worker a job ran on (X62)", () => {
  const w = { name: "Alex's MacBook Pro", kind: "mac", load: 1.2, cores: 10, slot: 1, slots: 2, rtt_ms: 6, copy: "~/.moonlet/runs/studio-mini/shop/fix-cart" };

  it("the panel's worker card line, as in job-running.png", () => {
    expect(workerLine(w)).toBe("load 1.2 / 10 · slot 1 of 2 · 6 ms");
    expect(workerLine({ ...w, kind: "central", rtt_ms: null })).toBe("load 1.2 / 10 · slot 1 of 2");
  });

  it("the job tab's Worker facts, as in job-tab.png", () => {
    expect(workerFacts(w)).toEqual([
      ["Load at start", "1.2 / 10"],
      ["Slot", "1 of 2"],
      ["Round trip", "6 ms"],
      ["Copy", "~/.moonlet/runs/studio-mini/shop/fix-cart"],
    ]);
    expect(workerFacts({ ...w, rtt_ms: null, copy: null })).toEqual([
      ["Load at start", "1.2 / 10"],
      ["Slot", "1 of 2"],
    ]);
  });
});

describe("the job tab's state line (X62)", () => {
  it("adds when it ran, and who ran it, as in job-tab.png", () => {
    const start = new Date(2026, 9, 22, 10, 40, 46).getTime();
    const j = done(0, 0, { started_at: start, ended_at: start + 72_000, summary: "457 tests passed" });
    expect(jobTabLine(j, 0, "fix-cart")).toEqual({ tone: "done", text: "Done · exit 0 · 1m 12s · 10:40:46 – 10:41:58 · run by Claude in fix-cart · 457 tests passed" });
    expect(jobTabLine(job({ started_at: 0 }), 42_000, "fix-cart")).toEqual({ tone: "accent", text: "Running · 0:42 · run by Claude in fix-cart" });
  });
});
