import { describe, expect, it } from "vitest";
import { chatContextFiles, chipSection, contextChats, contextPlans, newChatContext, planContextFiles } from "./chatContext";
import type { ChatItem, ChatState, TerminalInfo } from "./protocol";

const term = (id: number, over: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id,
  kind: "agent",
  title: "claude",
  cwd: "/Users/jane/code/app",
  command: ["claude"],
  session_id: "s1",
  agent: "claude",
  agent_state: "idle",
  cols: 120,
  rows: 32,
  pid: 1,
  chat: true,
  created_at: id * 1000,
  last_output_at: id * 1000,
  ...over,
});

const item = (id: string, kind: ChatItem["kind"], text: string, over: Partial<ChatItem> = {}): ChatItem => ({ id, kind, text, ts: 0, ...over });

const chat = (...items: ChatItem[]): ChatState => ({ items, pending: [], status: "idle", cost_usd: 0, input_tokens: 0, output_tokens: 0, slash_commands: [], queued: [] });

describe("contextChats", () => {
  it("lists the session's other chats with a message, newest tab first, named by their first message (X38)", () => {
    const terms = [
      term(1),
      term(2),
      term(3, { session_id: "other" }),
      term(4, { chat: false }),
      term(5, { kind: "shell", agent: undefined, chat: undefined }),
      term(6, { exit: { code: 0, signal: null } }),
      term(7),
    ];
    const chats = {
      1: chat(item("u1", "user", "Fix the login redirect\nIt loops on Safari."), item("a1", "assistant", "Done.")),
      2: chat(),
      3: chat(item("u3", "user", "Elsewhere")),
      6: chat(item("u6", "user", "  Why does CI time out?  ")),
      7: chat(item("u7", "user", "This chat")),
    };
    const rows = contextChats(terms, chats, { session: "s1", self: 7 });
    expect(rows.map((r) => [r.id, r.title, r.agent])).toEqual([
      [6, "Why does CI time out?", "claude"],
      [1, "Fix the login redirect", "claude"],
    ]);
  });
});

// ExitPlanMode inputs: the first as claude 2.1.291 sent it in Plan mode.
const captured = {
  plan: "1. Overwrite `a.txt` (untracked, repo root) content with `goodbye`.\n2. Verify by reading file back. Confidence 90%: trivial edit, current content unread by choice.\n",
  planFilePath: "/Users/me/.claude/plans/plan-changing-a-txt-to-groovy-whale.md",
};
/** An ExitPlanMode call; `summary` is the daemon's title for it. */
const planItem = (id: string, ts: number, input: unknown, summary = ""): ChatItem =>
  item(id, "tool", "", { ts, tool: { name: "ExitPlanMode", summary, input, status: "ok" } });

describe("contextPlans", () => {
  it("lists the session's plans newest first, one per plan file, named as the Plan panel names them (X38)", () => {
    const terms = [term(1), term(2), term(3, { session_id: "other" })];
    const chats = {
      1: chat(
        planItem("p1", 100, captured, "1. Overwrite `a.txt` (untracked, repo root) content with `goodbye`."),
        planItem("p2", 300, { plan: "# Add a dark theme\n\n1. Tokens\n", planFilePath: "/Users/me/.claude/plans/dark.md" }, "Add a dark theme"),
        item("r1", "tool", "", { ts: 350, tool: { name: "Read", summary: "a.txt", input: {}, status: "ok" } }),
      ),
      2: chat(
        planItem("p3", 400, { plan: "# Add a dark theme, revised\n", planFilePath: "/Users/me/.claude/plans/dark.md" }, "Add a dark theme, revised"),
        planItem("p4", 200, { plan: "## Split the settings page\nSteps\n" }),
        planItem("p5", 250, { plan: "   " }),
      ),
      3: chat(planItem("p6", 500, { plan: "# Elsewhere\n" })),
    };
    const rows = contextPlans(terms, chats, "s1");
    expect(rows.map((r) => r.title)).toEqual([
      "Add a dark theme, revised",
      "Plan",
      "1. Overwrite `a.txt` (untracked, repo root) content with `goodbye`.",
    ]);
    expect(rows[0].plan).toBe("# Add a dark theme, revised\n");
  });
});

describe("context files", () => {
  it("writes a chat's transcript to a git-ignored file and mentions it (X38)", () => {
    const files = chatContextFiles("/Users/jane/code/app", {
      id: 1,
      title: "Fix the login redirect",
      agent: "claude",
      items: [
        item("u1", "user", "Fix the login redirect\nIt loops on Safari."),
        item("t1", "tool", "", { tool: { name: "Edit", summary: "src/auth.ts", input: {}, status: "ok" } }),
        item("a1", "assistant", "Done."),
      ],
    });
    expect(files).toEqual({
      mention: ".moonlet/context/chat-fix-the-login-redirect-1.md",
      writes: [
        { root: "/Users/jane/code/app", path: "/Users/jane/code/app/.moonlet/context/.gitignore", content: "*\n" },
        {
          root: "/Users/jane/code/app",
          path: "/Users/jane/code/app/.moonlet/context/chat-fix-the-login-redirect-1.md",
          content: "# Chat transcript: Fix the login redirect\n\n> Fix the login redirect\n> It loops on Safari.\n\n[Edit] src/auth.ts\n\nDone.\n",
        },
      ],
    });
  });

  it("writes a plan's text and keeps file names inside the context folder (X38)", () => {
    const files = planContextFiles("/Users/jane/code/app/", { key: "k", title: "../../etc/passwd Ünïcode!!", plan: "# Steps\n1. Go\n" });
    expect(files).toEqual({
      mention: ".moonlet/context/plan-etc-passwd-n-code-ee0c38ea.md",
      writes: [
        { root: "/Users/jane/code/app", path: "/Users/jane/code/app/.moonlet/context/.gitignore", content: "*\n" },
        { root: "/Users/jane/code/app", path: "/Users/jane/code/app/.moonlet/context/plan-etc-passwd-n-code-ee0c38ea.md", content: "# Steps\n1. Go\n" },
      ],
    });
    expect(planContextFiles("/r", { key: "k", title: "!!!", plan: "x" }).mention).toBe(".moonlet/context/plan-untitled-ee0c38ea.md");
    expect(planContextFiles("/r", { key: "k", title: "a".repeat(80), plan: "x" }).mention).toBe(`.moonlet/context/plan-${"a".repeat(48)}-ee0c38ea.md`);
  });

  it("gives chats and plans with the same title their own files (X38)", () => {
    const a = chatContextFiles("/r", { id: 1, title: "Fix it", items: [] });
    const b = chatContextFiles("/r", { id: 2, title: "Fix it", items: [] });
    expect([a.mention, b.mention]).toEqual([".moonlet/context/chat-fix-it-1.md", ".moonlet/context/chat-fix-it-2.md"]);
    const p = planContextFiles("/r", { key: "k", title: "修复", plan: "x" });
    const q = planContextFiles("/r", { key: "/Users/me/.claude/plans/dark.md", title: "修复", plan: "y" });
    expect([p.mention, q.mention]).toEqual([".moonlet/context/plan-untitled-ee0c38ea.md", ".moonlet/context/plan-untitled-b7f59371.md"]);
  });
});

describe("chipSection", () => {
  it("shows four chips and counts the rest, or all of them once asked (X38)", () => {
    expect(chipSection(["a", "b", "c", "d", "e", "f"], false)).toEqual({ shown: ["a", "b", "c", "d"], more: 2 });
    expect(chipSection(["a", "b", "c", "d", "e", "f"], true)).toEqual({ shown: ["a", "b", "c", "d", "e", "f"], more: 0 });
    expect(chipSection(["a", "b", "c"], false)).toEqual({ shown: ["a", "b", "c"], more: 0 });
  });

  it("hides a section with nothing in it (X38)", () => {
    expect(chipSection([], false)).toBeNull();
  });
});

describe("newChatContext", () => {
  const terms = [term(1), term(7)];
  const chats = { 1: chat(item("u1", "user", "Fix the login redirect"), planItem("p1", 100, captured, "1. Overwrite `a.txt` (untracked, repo root) content with `goodbye`.")), 7: chat() };

  it("offers the session's other chats and plans (X38)", () => {
    const ctx = newChatContext(terms, chats, { session: "s1", self: 7, cwd: "/Users/jane/code/app" });
    expect(ctx.transcripts.map((c) => c.title)).toEqual(["Fix the login redirect"]);
    expect(ctx.plans.map((p) => p.title)).toEqual(["1. Overwrite `a.txt` (untracked, repo root) content with `goodbye`."]);
  });

  it("offers nothing while the chat has no folder to write to (X38)", () => {
    expect(newChatContext(terms, chats, { session: "s1", self: 7, cwd: "" })).toEqual({ transcripts: [], plans: [] });
  });
});
