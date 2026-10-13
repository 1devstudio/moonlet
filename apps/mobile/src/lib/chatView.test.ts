import { describe, expect, it } from "vitest";
import { chatFooter, sessionChat, sessionLine, shellTerminals } from "./chatView";
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
