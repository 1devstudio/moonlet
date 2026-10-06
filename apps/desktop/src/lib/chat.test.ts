import { describe, expect, it, vi } from "vitest";
import {
  activeToken,
  joinDraft,
  askQuestions,
  chatBlocks,
  chatKey,
  diffStat,
  fuzzyFilter,
  loadChat,
  mergeItem,
  onChatItem,
  onChatState,
  planAnswer,
  planOf,
  questionAnswers,
  thinkingPreview,
  toolCommand,
  toolGroupLabel,
  toolGroupStatus,
  transcript,
  turnFooter,
  useChat,
} from "./chat";

const rpcReply = vi.hoisted(() => ({ release: (_v: unknown) => {} }));
vi.mock("./daemon", () => ({ rpc: () => new Promise((r) => (rpcReply.release = r)) }));
import type { ChatItem } from "./protocol";

const item = (id: string, text: string, kind: ChatItem["kind"] = "assistant"): ChatItem => ({ id, kind, text, ts: 0 });

describe("chat helpers", () => {
  it("merges streamed items in place", () => {
    const a = [item("a", "he"), item("b", "x")];
    const b = mergeItem(a, item("a", "hello"));
    expect(b.map((i) => i.text)).toEqual(["hello", "x"]);
    expect(mergeItem(b, item("c", "new")).length).toBe(3);
  });

  it("counts diff lines", () => {
    expect(diffStat("--- a\n+++ b\n@@\n-old\n+new\n+more\n")).toEqual({ add: 2, del: 1 });
  });

  it("finds @ and / tokens at the caret", () => {
    expect(activeToken("look at @src/ma", 15)).toEqual({ kind: "@", start: 8, query: "src/ma" });
    expect(activeToken("/rev", 4)).toEqual({ kind: "/", start: 0, query: "rev" });
    expect(activeToken("run /rev", 8)).toBeNull();
    expect(activeToken("email a@b", 9)).toBeNull();
  });

  it("ranks fuzzy file matches by name", () => {
    const files = ["docs/main.md", "src/main.rs", "src/lib/manager.rs"];
    expect(fuzzyFilter(files, "main")[0]).toBe("src/main.rs");
    expect(fuzzyFilter(files, "mgr")).toEqual(["src/lib/manager.rs"]);
  });

  it("writes a transcript without thinking", () => {
    const t = transcript([item("1", "hi", "user"), item("2", "secret", "thinking"), { ...item("3", "", "tool"), tool: { name: "Bash", summary: "ls", input: {}, status: "denied" } }, item("4", "done")]);
    expect(t).toBe("> hi\n\n[Bash] ls (denied)\n\ndone");
  });

  it("keeps events that arrive while the state loads", async () => {
    const p = loadChat("h", 1);
    onChatItem("h", 1, { id: "a", kind: "assistant", text: "late", ts: 0 });
    onChatState("h", 1, { items: [], pending: [], status: "done", cost_usd: 1, input_tokens: 0, output_tokens: 0, slash_commands: [], queued: [] });
    rpcReply.release({ items: [{ id: "a", kind: "assistant", text: "ear", ts: 0 }], pending: [], status: "working", cost_usd: 0, input_tokens: 0, output_tokens: 0, slash_commands: [], queued: [] });
    await p;
    const st = useChat.getState().chats[chatKey("h", 1)];
    expect(st.status).toBe("done");
    expect(st.items[0].text).toBe("late");
  });

  it("folds runs of tool calls into groups and leaves text and thinking out", () => {
    const tool = (id: string, status: "running" | "ok" | "error" | "denied" = "ok"): ChatItem => ({ ...item(id, "", "tool"), tool: { name: "Bash", summary: id, input: {}, status } });
    const items = [item("u", "check it", "user"), item("t1", "The resume URL is session-bound", "thinking"), tool("b1"), item("t2", "", "thinking"), tool("b2"), item("a1", "Found it."), tool("b3"), item("e", "", "assistant")];

    expect(chatBlocks(items, "collapsed").map((b) => (b.kind === "tools" ? `[${b.tools.map((t) => t.id).join(",")}]` : b.item.id))).toEqual(["u", "t1", "[b1,b2]", "a1", "[b3]"]);
    expect(chatBlocks(items, "expanded").map((b) => (b.kind === "tools" ? "group" : b.item.id))).toEqual(["u", "t1", "b1", "b2", "a1", "b3"]);
  });

  it("does not let a tool item without a call split a group", () => {
    const tool = (id: string): ChatItem => ({ ...item(id, "", "tool"), tool: { name: "Bash", summary: id, input: {}, status: "ok" } });
    const items = [tool("b1"), item("x", "", "tool"), tool("b2")];
    expect(chatBlocks(items, "collapsed").map((b) => (b.kind === "tools" ? `[${b.tools.map((t) => t.id).join(",")}]` : b.item.id))).toEqual(["[b1,b2]"]);
    expect(chatBlocks(items, "expanded").map((b) => (b.kind === "tools" ? "group" : b.item.id))).toEqual(["b1", "b2"]);
  });

  it("labels a tool group and sums up its status", () => {
    const tool = (status: "running" | "ok" | "error" | "denied"): ChatItem => ({ ...item(status, "", "tool"), tool: { name: "Bash", summary: "", input: {}, status } });
    expect(toolGroupLabel(1)).toBe("1 tool call");
    expect(toolGroupLabel(2)).toBe("2 tool calls");
    expect(toolGroupStatus([tool("ok"), tool("ok")])).toBe("ok");
    expect(toolGroupStatus([tool("denied"), tool("error")])).toBe("error");
    expect(toolGroupStatus([tool("ok"), tool("denied")])).toBe("denied");
    expect(toolGroupStatus([tool("error"), tool("running")])).toBe("running");
  });

  it("shows a turn's response time and when it ended", () => {
    // Monday 5 October 2026, 4:30 PM.
    const now = new Date(2026, 9, 5, 16, 30).getTime();
    const turn = (end: Date, secs: number) => ({ started_at: end.getTime() - secs * 1000, ended_at: end.getTime() });
    expect(turnFooter(turn(new Date(2026, 9, 5, 16, 0), 14), now, "en-US")).toBe("14s · 4:00 PM");
    expect(turnFooter(turn(new Date(2026, 9, 4, 23, 59), 14), now, "en-US")).toBe("14s · Sun 11:59 PM");
    expect(turnFooter(turn(new Date(2026, 8, 29, 16, 0), 65), now, "en-US")).toBe("1m 05s · Tue 4:00 PM");
    expect(turnFooter(turn(new Date(2026, 8, 28, 16, 0), 14), now, "en-US")).toBe("14s · Sep 28, 4:00 PM");
    expect(turnFooter(turn(new Date(2025, 11, 30, 9, 5), 14), now, "en-US")).toBe("14s · Dec 30, 2025, 9:05 AM");
  });

  it("previews thinking on one line", () => {
    expect(thinkingPreview("\n  It's odd that the no-connection case\n  jumps straight from /authorize.  ")).toBe("It's odd that the no-connection case jumps straight from /authorize.");
  });

  it("gives the whole command of a shell call for its opened row", () => {
    const bash = (input: unknown, name = "Bash") => ({ name, summary: "", input, status: "ok" as const });
    expect(toolCommand(bash({ command: "git tag --list 'v*' --sort=-creatordate | head -5; exe/release prod --draft-notes --skip-build --tag v0.1.9 2>&1 | tail -40", description: "List tags and dry-run the release" }))).toBe(
      "git tag --list 'v*' --sort=-creatordate | head -5; exe/release prod --draft-notes --skip-build --tag v0.1.9 2>&1 | tail -40",
    );
    expect(toolCommand(bash({ command: "cd /tmp &&\\\n  curl -s https://example.com\n" }))).toBe("cd /tmp &&\\\n  curl -s https://example.com");
    expect(toolCommand(bash({ command: "ls -la", cwd: "/repo" }, "shell"))).toBe("ls -la");
    expect(toolCommand(bash({ cmd: "pnpm test" }, "command"))).toBe("pnpm test");
    expect(toolCommand(bash({ file_path: "/repo/README.md" }, "Read"))).toBeNull();
    expect(toolCommand(bash({ command: null }))).toBeNull();
    expect(toolCommand(bash(null))).toBeNull();
  });

  it("reads AskUserQuestion input and builds its answers", () => {
    const qs = askQuestions({
      questions: [
        { question: "Which colours?", header: "Colours", multiSelect: false, options: [{ label: "GitHub", description: "Green" }, { label: "Mono" }] },
        { question: "Which checks?", header: "Checks", multiSelect: true, options: [{ label: "Lint", description: "" }, { label: "Tests", description: "" }] },
        { header: "broken" },
      ],
    });
    expect(qs.map((q) => q.question)).toEqual(["Which colours?", "Which checks?"]);
    expect(qs[0].options[1]).toEqual({ label: "Mono", description: "" });
    expect(askQuestions(null)).toEqual([]);

    expect(questionAnswers(qs, [{ labels: ["GitHub"], other: "" }, { labels: [], other: "" }])).toBeNull();
    expect(questionAnswers(qs, [{ labels: ["GitHub"], other: "" }, { labels: ["Lint", "Tests"], other: "" }])).toEqual({ "Which colours?": "GitHub", "Which checks?": "Lint, Tests" });
    expect(questionAnswers(qs, [{ labels: ["GitHub"], other: " Solarized " }, { labels: ["Lint"], other: "Types" }])).toEqual({ "Which colours?": "Solarized", "Which checks?": "Lint, Types" });
  });
});

describe("text sent to the composer (T8)", () => {
  it("fills an empty composer", () => {
    expect(joinDraft("  ", "```\n$ ls\n```\n")).toBe("```\n$ ls\n```\n");
  });

  it("follows what is already typed, after a blank line", () => {
    expect(joinDraft("Why does this fail?\n", "```\n$ false\n```\n")).toBe("Why does this fail?\n\n```\n$ false\n```\n");
  });
});

describe("plan approval (X20)", () => {
  // The input of an ExitPlanMode ask as claude 2.1.291 sent it.
  const input = {
    plan: "1. Overwrite `a.txt` (untracked, repo root) content with `goodbye`.\n2. Verify by reading file back.\n",
    planFilePath: "/Users/me/.claude/plans/plan-changing-a-txt-to-groovy-whale.md",
  };

  it("reads the plan and its file out of an ExitPlanMode ask", () => {
    expect(planOf({ tool: "ExitPlanMode", input })).toEqual({
      plan: "1. Overwrite `a.txt` (untracked, repo root) content with `goodbye`.\n2. Verify by reading file back.\n",
      file: "/Users/me/.claude/plans/plan-changing-a-txt-to-groovy-whale.md",
    });
    expect(planOf({ tool: "ExitPlanMode", input: { plan: "# Plan" } })).toEqual({ plan: "# Plan", file: null });
    // Without a plan, or for another tool, the plain permission card is used.
    expect(planOf({ tool: "ExitPlanMode", input: { plan: "  " } })).toBeNull();
    expect(planOf({ tool: "ExitPlanMode", input: {} })).toBeNull();
    expect(planOf({ tool: "Bash", input: { plan: "# Plan" } })).toBeNull();
  });

  it("maps each choice to its chat.permission parameters", () => {
    expect(planAnswer("acceptEdits")).toEqual({ decision: "allow", mode: "acceptEdits" });
    expect(planAnswer("ask")).toEqual({ decision: "allow" });
    expect(planAnswer("keepPlanning", "  Use a feature flag instead \n")).toEqual({ decision: "deny", message: "Use a feature flag instead" });
    // Empty feedback sends nothing.
    expect(planAnswer("keepPlanning", " ")).toBeNull();
  });
});
