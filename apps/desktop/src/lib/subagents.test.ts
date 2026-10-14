import { describe, expect, it } from "vitest";
import { type AgentNote, agentCount, agentNotes, agentRows, agentsHeader, askLine, askerName, launchedRows, agentsTabDot, modelLabel, notesByBlock, retryMessage, stoppable, stripDismissAt, stripRetry, stripView } from "./subagents";
import type { ChatItem, ChatState, PermissionAsk, Subagent } from "./protocol";
import { chatBlocks } from "./chat";

const T0 = 1_791_970_430_000;

// Shaped like the daemon's state for claude-subagents.jsonl (X42).
const write: Subagent = {
  id: "a98344134013d8227",
  tool_use_id: "toolu_01QNjAbPMDQiZwKyCqkmv2VD",
  description: "Write hello file",
  kind: "general-purpose",
  prompt: "Use the Write tool to create hello.txt in the current directory containing the single word hi. Then reply done.",
  status: "running",
  started_at: T0,
  activity: "Writing hello.txt",
  tokens: 9721,
  tool_uses: 1,
  model: "claude-haiku-5-5",
  tools: [{ id: "toolu_01HCnwCanjJxRH3wTnuE1cGa", name: "Write", summary: "/repo/hello.txt", status: "running", added: 1, removed: 0 }],
};
const list: Subagent = {
  id: "a69ffa893ad4d346c",
  tool_use_id: "toolu_01BxCjWGafqjuD8gywbDsWV7",
  description: "List files",
  prompt: "Use the Glob tool with pattern * in the current directory and reply with the file names.",
  status: "done",
  started_at: T0 + 1_000,
  ended_at: T0 + 12_600,
  duration_ms: 11_510,
  activity: "Running List top-level entries in the working directory",
  tokens: 10_779,
  tool_uses: 2,
  report: "The directory `/repo` contains two files: `notes.md` and `hello.txt`.",
  tools: [],
};
const audit: Subagent = {
  id: "a3",
  tool_use_id: "toolu_3",
  description: "Audit SSH key handling",
  prompt: "Audit it.",
  status: "failed",
  started_at: T0,
  ended_at: T0 + 52_000,
  error: "API error 529 · overloaded",
  tokens: 20_000,
  tool_uses: 4,
  tools: [],
};
const bench: Subagent = {
  id: "a4",
  tool_use_id: "toolu_4",
  description: "Benchmark reconnect latency",
  prompt: "Measure it.",
  status: "stopped",
  started_at: T0 + 2_000,
  ended_at: T0 + 11_000,
  tokens: 1_000,
  tool_uses: 1,
  tools: [],
};

// The Write ask as the daemon reports it from the captured can_use_tool line.
const ask: PermissionAsk = {
  id: "eee7fb1b-453f-4303-8690-b9312d5f1b24",
  tool: "Write",
  summary: "/repo/hello.txt",
  input: { file_path: "/repo/hello.txt", content: "hi\n" },
  reason: "hello.txt",
  can_always: true,
  agent: "a98344134013d8227",
};

const chat = (subagents: Subagent[], pending: PermissionAsk[] = []): ChatState => ({
  items: [],
  pending,
  status: pending.length ? "blocked" : "done",
  cost_usd: 0,
  input_tokens: 0,
  output_tokens: 0,
  slash_commands: [],
  queued: [],
  subagents,
});

describe("agentRows (X42)", () => {
  it("puts agents that need the user first, then running, failed, done and stopped ones", () => {
    const rows = agentRows([{ id: 7, st: chat([list, bench, audit, write], [ask]) }], T0 + 62_000);
    expect(rows.map((r) => [r.chat, r.agent.description, r.state, r.elapsed, r.line])).toEqual([
      [7, "Write hello file", "needs", "1:02", { tone: "fg", text: "Wants to edit /repo/hello.txt" }],
      [7, "Audit SSH key handling", "failed", "0:52", { tone: "error", text: "API error 529 · overloaded" }],
      [7, "List files", "done", "0:11", null],
      [7, "Benchmark reconnect latency", "stopped", "0:09", { tone: "muted", text: "Stopped" }],
    ]);
    expect(rows[0].ask?.id).toBe("eee7fb1b-453f-4303-8690-b9312d5f1b24");
  });

  it("shows what a running agent does, and Wants to run for a command", () => {
    const run: PermissionAsk = { ...ask, id: "b1", tool: "Bash", summary: "pnpm add @tauri-apps/plugin-os", agent: "a4" };
    const rows = agentRows(
      [
        { id: 7, st: chat([write]) },
        { id: 9, st: chat([{ ...bench, status: "running", ended_at: null }], [run]) },
        { id: 11, st: undefined },
      ],
      T0 + 5_000,
    );
    expect(rows.map((r) => [r.chat, r.state, r.elapsed, r.line])).toEqual([
      [9, "needs", "0:03", { tone: "fg", text: "Wants to run pnpm add @tauri-apps/plugin-os" }],
      [7, "running", "0:05", { tone: "muted", text: "Writing hello.txt" }],
    ]);
  });
});

describe("askLine (X42)", () => {
  it("shows a command in full, every line of it, since Allow sits next to it", () => {
    const run: PermissionAsk = { ...ask, tool: "Bash", summary: "cd /repo", input: { command: "cd /repo\nrm -rf build && pnpm build" } };
    expect(askLine(run)).toBe("Wants to run cd /repo\nrm -rf build && pnpm build");
  });
});

describe("agentsHeader (X42)", () => {
  it("counts agents, times them from the first start and sums their tokens", () => {
    const rows = agentRows([{ id: 7, st: chat([list, bench, audit, write], [ask]) }], T0 + 62_000);
    expect(agentsHeader(rows, T0 + 62_000)).toEqual({ text: "4 agents · 1:02 · 41.5k tokens", running: 1 });
  });

  it("stops the clock at the last end once none runs", () => {
    const rows = agentRows([{ id: 7, st: chat([list]) }], T0 + 99_000);
    expect(agentsHeader(rows, T0 + 99_000)).toEqual({ text: "1 agent · 0:11 · 10.8k tokens", running: 0 });
  });
});

describe("stoppable (X42)", () => {
  it("is every agent Stop all stops: those running or waiting for the user", () => {
    const rows = agentRows([{ id: 7, st: chat([list, bench, audit, write, { ...write, id: "a6", description: "Measure" }], [ask]) }], T0 + 62_000);
    expect(stoppable(rows).map((r) => r.agent.description)).toEqual(["Write hello file", "Measure"]);
  });
});

describe("agentCount (X42)", () => {
  it("counts agents in words", () => {
    expect([agentCount(1), agentCount(5)]).toEqual(["1 agent", "5 agents"]);
  });
});

describe("agentsTabDot (X42)", () => {
  it("shows while an agent needs the user and another tab is open", () => {
    const rows = agentRows([{ id: 7, st: chat([write], [ask]) }], T0);
    expect(agentsTabDot("files", rows)).toBe(true);
    expect(agentsTabDot("agents", rows)).toBe(false);
    expect(agentsTabDot("files", agentRows([{ id: 7, st: chat([write]) }], T0))).toBe(false);
  });
});

describe("retryMessage (X42)", () => {
  it("asks the main agent to run the agents again", () => {
    expect(retryMessage([audit])).toBe('Run the "Audit SSH key handling" agent again.');
    expect(retryMessage([audit, bench])).toBe('Run these agents again: "Audit SSH key handling", "Benchmark reconnect latency".');
  });
});

describe("modelLabel (X42)", () => {
  it("names Claude models the way the model menu does", () => {
    expect(modelLabel("claude-haiku-5-5")).toBe("Haiku 5.5");
    expect(modelLabel("claude-opus-4-1-20250805")).toBe("Opus 4.1");
    expect(modelLabel("gpt-5")).toBe("gpt-5");
  });
});

describe("stripView (X42)", () => {
  const ask2: PermissionAsk = { ...ask, agent: "a5" };
  const user = (ts: number): ChatItem => ({ id: `u${ts}`, kind: "user", text: "Go", ts });
  const running = (id: string, started: number): Subagent => ({ ...write, id, description: id, started_at: started, status: "running" });
  const done = (id: string, started: number, ms: number, tools: Subagent["tools"] = []): Subagent => ({ ...list, id, description: id, started_at: started, duration_ms: ms, ended_at: started + ms, status: "done", tools });
  const withItems = (subagents: Subagent[], pending: PermissionAsk[] = []) => ({ ...chat(subagents, pending), items: [user(T0 - 1_000)] });

  it("counts running and done agents while they work", () => {
    const st = withItems([done("a1", T0, 10_000), done("a2", T0, 20_000), running("a3", T0), running("a4", T0 + 5_000)]);
    expect(stripView(st, T0 + 108_000, 0)).toEqual({
      dots: [
        { key: "a1", state: "done", phase: "gone" },
        { key: "a2", state: "done", phase: "gone" },
        { key: "a3", state: "running", phase: "on" },
        { key: "a4", state: "running", phase: "on" },
      ],
      title: "4 agents",
      counts: [
        { state: "running", text: "2 running" },
        { state: "done", text: "2 done" },
      ],
      flash: false,
      finished: false,
      collapsed: false,
      alert: null,
      clock: "1:48",
      button: null,
      dismissible: false,
      wake: null,
    });
  });

  it("calls out an agent that needs the user", () => {
    const st = withItems([done("a1", T0, 10_000), running("a3", T0), running("a5", T0)], [ask2]);
    expect(stripView(st, T0 + 134_000, 0)).toMatchObject({
      dots: [
        { key: "a1", state: "done", phase: "gone" },
        { key: "a3", state: "running", phase: "on" },
        { key: "a5", state: "needs", phase: "on" },
      ],
      title: "3 agents",
      counts: [
        { state: "running", text: "1 running" },
        { state: "done", text: "1 done" },
      ],
      alert: { tone: "blocked", text: "1 needs you" },
      clock: "2:14",
      button: null,
    });
  });

  it("reads All N done once all finished, then folds away", () => {
    // a1 ends at T0 + 100_000, a2 at T0 + 220_000.
    const st = withItems([done("a1", T0, 100_000), done("a2", T0 + 20_000, 200_000)]);
    expect(stripView(st, T0 + 220_100, 0)).toEqual({
      dots: [
        { key: "a1", state: "done", phase: "gone" },
        { key: "a2", state: "done", phase: "pop" },
      ],
      title: "All 2 done",
      counts: [],
      flash: true,
      finished: true,
      collapsed: false,
      alert: null,
      clock: "3:40",
      button: null,
      dismissible: false,
      wake: T0 + 220_280,
    });
    expect(stripView(st, T0 + 221_200, 0)).toMatchObject({ dots: [{ phase: "gone" }, { phase: "gone" }], collapsed: false, wake: T0 + 221_600 });
    expect(stripView(st, T0 + 221_600, 0)).toMatchObject({ title: "All 2 done", collapsed: true, wake: null });
    expect(stripView(withItems([done("a1", T0, 1_000)]), T0 + 1_100, 0)).toMatchObject({ title: "1 agent done", finished: true, collapsed: false });
  });

  it("does not call stopped agents finished, and can be dismissed", () => {
    const st = withItems([done("a1", T0, 10_000), { ...bench, started_at: T0 + 2_000 }]);
    expect(stripView(st, T0 + 99_000, 0)).toMatchObject({
      dots: [
        { key: "a1", state: "done", phase: "gone" },
        { key: bench.id, state: "stopped", phase: "on" },
      ],
      title: "2 agents",
      counts: [{ state: "done", text: "1 done" }, { state: "stopped", text: "1 stopped" }],
      finished: false,
      collapsed: false,
      alert: null,
      button: "review",
      dismissible: true,
    });
    // Dismissed after the last agent started: hidden until a new one starts.
    expect(stripDismissAt(st)).toBe(T0 + 2_000);
    expect(stripView(st, T0 + 99_000, stripDismissAt(st))).toBeNull();
  });

  it("offers Retry for the failed agents once none still runs", () => {
    const st = withItems([done("a1", T0, 10_000), { ...audit, started_at: T0 }]);
    expect(stripView(st, T0 + 999_000, 0)).toMatchObject({
      dots: [
        { key: "a1", state: "done", phase: "gone" },
        { key: "a3", state: "failed", phase: "on" },
      ],
      title: "2 agents",
      counts: [{ state: "done", text: "1 done" }],
      alert: { tone: "error", text: "1 failed" },
      clock: "0:52",
      button: "retry",
    });
    expect(stripRetry(st)).toBe('Run the "Audit SSH key handling" agent again.');
    expect(stripRetry(withItems([done("a1", T0, 10_000)]))).toBeNull();
  });

  it("pops a finished agent's dot green, then hides it, waking for each change", () => {
    // a1 ends at T0 + 10_000; a2 still runs.
    const st = withItems([done("a1", T0, 10_000), running("a2", T0)]);
    const at = (now: number) => stripView(st, now, 0)!;
    // The daemon's clock may run a little ahead of this one.
    expect(at(T0 + 9_900)).toMatchObject({ dots: [{ key: "a1", state: "done", phase: "pop" }, { phase: "on" }], flash: true });
    expect(at(T0 + 10_100)).toMatchObject({ dots: [{ key: "a1", state: "done", phase: "pop" }, { key: "a2", state: "running", phase: "on" }], wake: T0 + 10_280 });
    expect(at(T0 + 10_500)).toMatchObject({ dots: [{ key: "a1", state: "done", phase: "on" }, { phase: "on" }], wake: T0 + 10_900 });
    expect(at(T0 + 11_000)).toMatchObject({ dots: [{ key: "a1", state: "done", phase: "on" }, { phase: "on" }], wake: T0 + 11_200 });
    expect(at(T0 + 11_200)).toMatchObject({ dots: [{ key: "a1", state: "done", phase: "gone" }, { phase: "on" }], wake: null });
  });

  it("shows the done count green for a moment after an agent finishes", () => {
    const st = withItems([done("a1", T0, 10_000), running("a2", T0)]);
    expect(stripView(st, T0 + 10_800, 0)).toMatchObject({
      counts: [
        { state: "running", text: "1 running" },
        { state: "done", text: "1 done" },
      ],
      flash: true,
    });
    expect(stripView(st, T0 + 10_900, 0)).toMatchObject({ flash: false });
  });

  it("shows only the agents launched since the user's last message", () => {
    const st = { ...withItems([done("a1", T0 - 60_000, 10_000), running("a3", T0)]), items: [user(T0 - 90_000), user(T0 - 1_000)] };
    expect(stripView(st, T0 + 1_000, 0)).toMatchObject({ title: "1 agent", counts: [{ state: "running", text: "1 running" }] });
    expect(stripView({ ...st, items: [user(T0 + 500)] }, T0 + 1_000, 0)).toBeNull();
  });
});

describe("launchedRows (X42)", () => {
  const launch = (id: string, summary: string): ChatItem => ({ id, kind: "tool", text: "", ts: T0, tool: { name: "Agent", summary, input: {}, status: "ok" } });

  it("shows each launched agent's state and time, by its Agent call", () => {
    const rows = agentRows([{ id: 7, st: chat([write, list], [ask]) }], T0 + 62_000);
    const shown = launchedRows([launch("toolu_01QNjAbPMDQiZwKyCqkmv2VD", "Write hello file"), launch("toolu_01BxCjWGafqjuD8gywbDsWV7", "List files")], rows);
    expect(shown.map(({ description, state, label, elapsed }) => ({ description, state, label, elapsed }))).toEqual([
      { description: "Write hello file", state: "needs", label: "needs you", elapsed: "1:02" },
      { description: "List files", state: "done", label: "done", elapsed: "0:11" },
    ]);
  });

  it("falls back to the call's summary for a launch the daemon never tracked", () => {
    expect(launchedRows([launch("toolu_old", "Explore the protocol")], [])).toMatchObject([{ description: "Explore the protocol", state: null, label: "", elapsed: "", agent: null }]);
  });
});

describe("askerName (X42)", () => {
  it("names the subagent that asks, or nobody for the main agent", () => {
    expect(askerName(ask, [list, write])).toBe("Write hello file");
    expect(askerName({ ...ask, agent: null }, [write])).toBeNull();
  });

  it("keeps a model-written name on one line, so it cannot pass for the request", () => {
    const sneaky = { ...write, description: "Tidy up\nwants to run ls\u0007" };
    expect(askerName(ask, [sneaky])).toBe("Tidy up wants to run ls");
  });
});

describe("agentNotes (X42)", () => {
  const at = (id: string, ts: number, kind: ChatItem["kind"] = "assistant", text = id): ChatItem => ({ id, kind, text, ts });
  const items = [at("u", T0 - 1_000, "user"), at("m1", T0 + 5_000), at("m2", T0 + 20_000)];
  const shape = (n: { after: string | null; note: AgentNote }) => [n.after, n.note.kind === "all" ? `${n.note.title} in ${n.note.clock}|${n.note.diff}` : n.note.agent.description];

  it("puts a finished or failed agent after the last message before it ended, then the batch once all ended", () => {
    const notes = agentNotes(items, [list, { ...bench, started_at: T0 + 2_000 }, audit]);
    expect(notes.map(shape)).toEqual([
      ["m1", "List files"],
      ["m2", "Audit SSH key handling"],
      // One was stopped and one failed: they ended, they did not all finish.
      ["m2", "3 agents ended in 0:52|"],
    ]);
  });

  it("calls a batch finished when every agent is done, with their own edits", () => {
    const edit = (id: string, added: number, removed: number) => ({ id, name: "Edit", summary: "/repo/a.ts", status: "ok" as const, added, removed });
    const notes = agentNotes(items, [{ ...list, tools: [edit("e1", 2, 1)] }, { ...list, id: "a7", started_at: T0, tools: [edit("e2", 1, 0)] }]);
    expect(notes.map(shape).at(-1)).toEqual(["m1", "2 agents finished in 0:12|+3 −1 in 1 file"]);
  });

  it("leaves reads and denied edits out of the batch's diff", () => {
    const edit = (id: string, path: string, added: number, removed: number, status: "ok" | "denied" = "ok") => ({ id, name: "Edit", summary: path, status, added, removed });
    const notes = agentNotes(items, [
      { ...list, tools: [edit("e1", "/repo/a.ts", 10, 0), edit("e2", "/repo/b.ts", 3, 1), { id: "r1", name: "Read", summary: "/repo/c.ts", status: "ok" }] },
      { ...list, id: "a7", started_at: T0, tools: [edit("e3", "/repo/b.ts", 2, 2), edit("e4", "/repo/d.ts", 5, 5, "denied")] },
    ]);
    expect(notes.map(shape).at(-1)).toEqual(["m1", "2 agents finished in 0:12|+15 −3 in 2 files"]);
  });

  it("only follows messages that show", () => {
    // An empty assistant item renders nothing, so a note after it would never show.
    const notes = agentNotes([...items, at("blank", T0 + 10_000, "assistant", "")], [list]);
    expect(notes.map(shape)).toEqual([["m1", "List files"]]);
  });

  it("waits for every agent of a batch before the batch note", () => {
    const notes = agentNotes(items, [list, write]);
    expect(notes.map((n) => n.note.kind)).toEqual(["finished"]);
  });
});

describe("notesByBlock (X42)", () => {
  it("places each note after the block holding its message", () => {
    const tool = (id: string): ChatItem => ({ id, kind: "tool", text: "", ts: T0, tool: { name: "Bash", summary: id, input: {}, status: "ok" } });
    const blocks = chatBlocks([{ id: "u", kind: "user", text: "Go", ts: T0 }, tool("b1"), tool("b2"), { id: "m", kind: "assistant", text: "Done.", ts: T0 }], "collapsed");
    const note = (after: string | null, id: string) => ({ after, note: { kind: "finished" as const, agent: { ...list, id } } });
    const placed = notesByBlock(blocks, [note(null, "x0"), note("b2", "x1"), note("m", "x2"), note("b1", "x3")]);
    expect(placed.lead.map((n) => n.kind === "finished" && n.agent.id)).toEqual(["x0"]);
    expect(Object.fromEntries(Object.entries(placed.after).map(([k, v]) => [k, v.map((n) => n.kind === "finished" && n.agent.id)]))).toEqual({ b1: ["x1", "x3"], m: ["x2"] });
  });
});
