import { describe, expect, it } from "vitest";
import { chatBlocks } from "@desktop/lib/chat";
import type { ChatItem } from "@desktop/lib/protocol";
import { agentStrip, asideStep, blockKey, chatFooter, queuedActions, sessionChat, sessionLine, shellTerminals } from "./chatView";
import { NOW, chat, data, project, session, terminal } from "./fixtures";

describe("sessionChat", () => {
  it("is the session's first chat terminal", () => {
    const d = data({
      terminals: {
        9: terminal(9, "s1", { chat: true, created_at: NOW - 10 }),
        4: terminal(4, "s1", { chat: true, created_at: NOW - 20 }),
        2: terminal(2, "s1", { kind: "shell", chat: false, agent: undefined, created_at: NOW - 30 }),
        1: terminal(1, "other", { chat: true, created_at: NOW - 40 }),
      },
    });
    expect(sessionChat(d, "s1")).toBe(4);
    expect(sessionChat(d, "none")).toBeNull();
  });
});

describe("shellTerminals", () => {
  it("lists the session's shell, run and setup terminals, oldest first", () => {
    const d = data({
      terminals: {
        5: terminal(5, "s1", { kind: "run", title: "pnpm dev", chat: false, created_at: NOW - 5 }),
        3: terminal(3, "s1", { kind: "shell", title: "zsh", chat: false, created_at: NOW - 9 }),
        4: terminal(4, "s1", { kind: "agent", chat: true }),
        6: terminal(6, "s2", { kind: "shell", chat: false }),
      },
    });
    expect(shellTerminals(d, "s1").map((t) => t.title)).toEqual(["zsh", "pnpm dev"]);
  });
});

describe("sessionLine", () => {
  it("is project · branch · host", () => {
    expect(sessionLine(session("add-search", "x", { branch: "moonlet/add-search" }), project("storefront", "storefront"), "This Mac")).toBe(
      "storefront · moonlet/add-search · This Mac",
    );
  });
});

describe("chatFooter", () => {
  it("shows the context used, the cost, model and effort, and the mode", () => {
    const st = { ...chat([]), cost_usd: 1.837, model: "opus", effort: "high", mode: "manual", context: { used: 68_000, max: 200_000, categories: [] } };
    expect(chatFooter(st)).toEqual({ context: 34, cost: "$1.84", model: "Opus 5.5 · High", mode: "Manual" });
  });

  it("leaves out what the agent has not said yet", () => {
    expect(chatFooter(chat([]))).toEqual({ context: null, cost: null, model: "Default model", mode: "Manual" });
    expect(chatFooter({ ...chat([]), model: "claude-sonnet-5-5", mode: "acceptEdits" })).toEqual({ context: null, cost: null, model: "claude-sonnet-5-5", mode: "Accept edits" });
  });
});

describe("blockKey", () => {
  it("keys a run of tool calls and a run of subagent launches by their first call, an item by its id", () => {
    const tool = (id: string, name: string): ChatItem => ({ id, kind: "tool", text: "", ts: NOW, tool: { name, summary: "", input: {}, status: "running" } });
    const items: ChatItem[] = [
      { id: "u1", kind: "user", text: "Look around", ts: NOW },
      tool("toolu_read", "Read"),
      tool("toolu_agent1", "Agent"),
      tool("toolu_agent2", "Agent"),
    ];
    expect(chatBlocks(items, "collapsed").map(blockKey)).toEqual(["u1", "toolu_read", "toolu_agent1"]);
  });
});

describe("queuedActions (X49)", () => {
  const q = (id: string, text: string, sending = false) => ({ id, text, sending });

  it("offers Send now for every queued message, and Ask aside on the last one", () => {
    expect(queuedActions([q("m1", "also run the linter")])).toEqual({ sendNow: "Send now", params: { message: "m1" }, aside: q("m1", "also run the linter") });
    expect(queuedActions([q("m1", "also run the linter"), q("m2", "why is search slow?")])).toEqual({ sendNow: "Send 2 now", params: {}, aside: q("m2", "why is search slow?") });
  });

  it("offers nothing after Send now, or with nothing queued", () => {
    expect(queuedActions([q("m1", "also run the linter", true)])).toBeNull();
    expect(queuedActions([])).toBeNull();
  });
});

describe("asideStep (X49)", () => {
  const asked = { id: "m2", text: "why is search slow?", sending: false };
  const st = (queued: { id: string; text: string; sending: boolean }[], items: { id: string }[] = []) => ({ queued, items: items as never[] });

  it("waits while Claude still has the message, then asks it aside once Claude gave it back", () => {
    expect(asideStep(st([asked]), asked)).toEqual({ kind: "wait" });
    expect(asideStep(st([]), asked)).toEqual({ kind: "ask", question: "why is search slow?" });
  });

  it("says so when Claude read the message first", () => {
    expect(asideStep(st([], [{ id: "m2" }]), asked)).toEqual({ kind: "note", text: "Claude read the message before it could be asked aside" });
  });
});

describe("agentStrip (X57)", () => {
  const agent = (id: string, status: "running" | "done" | "failed" | "stopped") => ({ id, tool_use_id: `t-${id}`, description: id, prompt: "", status, started_at: NOW - 60_000, tokens: 0, tool_uses: 0, tools: [] });
  it("shows a bar per subagent in its state, how many are done, and whether one needs the user", () => {
    const st = { subagents: [agent("a1", "done"), agent("a2", "done"), agent("a3", "running"), agent("a4", "running"), agent("a5", "stopped")], pending: [{ id: "p", tool: "Bash", summary: "", input: {}, can_always: true, agent: "a4" }] };
    expect(agentStrip(st, NOW)).toEqual({ bars: ["done", "done", "running", "needs", "stopped"], progress: "2/5", word: "1 needs you" });
    expect(agentStrip({ ...st, pending: [] }, NOW)?.word).toBe("all running");
    expect(agentStrip({ subagents: [agent("a1", "done")], pending: [] }, NOW)).toEqual({ bars: ["done"], progress: "1/1", word: "all done" });
    expect(agentStrip({ subagents: [], pending: [] }, NOW)).toBeNull();
  });
});
