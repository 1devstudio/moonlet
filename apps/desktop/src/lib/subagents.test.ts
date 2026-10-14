import { describe, expect, it } from "vitest";
import { agentCount, agentRows, agentsHeader, askLine, agentsTabDot, modelLabel, retryMessage, stoppable, stripDismissAt, stripRetry, stripView } from "./subagents";
import type { ChatItem, ChatState, PermissionAsk, Subagent } from "./protocol";

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
  const edit = (id: string, path: string, added: number, removed: number, status: "ok" | "denied" = "ok") => ({ id, name: "Edit", summary: path, status, added, removed });

  it("counts running and done agents while they work", () => {
    const st = withItems([done("a1", T0, 10_000), done("a2", T0, 20_000), running("a3", T0), running("a4", T0 + 5_000)]);
    expect(stripView(st, T0 + 108_000, 0)).toEqual({
      dots: ["done", "done", "running", "running"],
      title: "4 agents",
      detail: "2 running · 2 done",
      alert: null,
      clock: "1:48",
      button: null,
      dismissible: false,
    });
  });

  it("calls out an agent that needs the user", () => {
    const st = withItems([done("a1", T0, 10_000), running("a3", T0), running("a5", T0)], [ask2]);
    expect(stripView(st, T0 + 134_000, 0)).toMatchObject({
      dots: ["done", "running", "needs"],
      title: "3 agents",
      detail: "1 running · 1 done",
      alert: { tone: "blocked", text: "1 needs you" },
      clock: "2:14",
      button: null,
    });
  });

  it("offers Review changes once all finished, with the agents' own edits, and can be dismissed", () => {
    const st = withItems([
      done("a1", T0, 100_000, [edit("e1", "/repo/a.ts", 10, 0), edit("e2", "/repo/b.ts", 3, 1), { id: "r1", name: "Read", summary: "/repo/c.ts", status: "ok" }]),
      done("a2", T0 + 20_000, 200_000, [edit("e3", "/repo/b.ts", 2, 2), edit("e4", "/repo/d.ts", 5, 5, "denied")]),
    ]);
    expect(stripView(st, T0 + 999_000, 0)).toEqual({
      dots: ["done", "done"],
      title: "2 agents finished",
      detail: "+15 −3 in 2 files",
      alert: null,
      clock: "3:40",
      button: "review",
      dismissible: true,
    });
    expect(stripView(withItems([done("a1", T0, 1_000)]), T0 + 9_000, 0)).toMatchObject({ title: "1 agent finished", detail: "" });
    // Dismissed after the last agent started: hidden until a new one starts.
    expect(stripDismissAt(st)).toBe(T0 + 20_000);
    expect(stripView(st, T0 + 999_000, stripDismissAt(st))).toBeNull();
  });

  it("does not call stopped agents finished", () => {
    const st = withItems([done("a1", T0, 10_000), { ...bench, started_at: T0 }]);
    expect(stripView(st, T0 + 99_000, 0)).toMatchObject({ title: "2 agents", detail: "1 done · 1 stopped", alert: null, button: "review", dismissible: true });
  });

  it("offers Retry for the failed agents once none still runs", () => {
    const st = withItems([done("a1", T0, 10_000), { ...audit, started_at: T0 }]);
    expect(stripView(st, T0 + 999_000, 0)).toMatchObject({
      dots: ["done", "failed"],
      title: "2 agents",
      detail: "1 done",
      alert: { tone: "error", text: "1 failed" },
      clock: "0:52",
      button: "retry",
    });
    expect(stripRetry(st)).toBe('Run the "Audit SSH key handling" agent again.');
    expect(stripRetry(withItems([done("a1", T0, 10_000)]))).toBeNull();
  });

  it("shows only the agents launched since the user's last message", () => {
    const st = { ...withItems([done("a1", T0 - 60_000, 10_000), running("a3", T0)]), items: [user(T0 - 90_000), user(T0 - 1_000)] };
    expect(stripView(st, T0 + 1_000, 0)).toMatchObject({ title: "1 agent", detail: "1 running" });
    expect(stripView({ ...st, items: [user(T0 + 500)] }, T0 + 1_000, 0)).toBeNull();
  });
});
