import { describe, expect, it } from "vitest";
import { chatContextFiles, contextChats, contextPlans, planContextFiles } from "./chatContext";
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
const planItem = (id: string, ts: number, input: unknown): ChatItem =>
  item(id, "tool", "", { ts, tool: { name: "ExitPlanMode", summary: "", input, status: "ok" } });

describe("contextPlans", () => {
  it("lists the session's plans newest first, one per plan file, named by their heading or first line (X38)", () => {
    const terms = [term(1), term(2), term(3, { session_id: "other" })];
    const chats = {
      1: chat(
        planItem("p1", 100, captured),
        planItem("p2", 300, { plan: "# Add a dark theme\n\n1. Tokens\n", planFilePath: "/Users/me/.claude/plans/dark.md" }),
        item("r1", "tool", "", { ts: 350, tool: { name: "Read", summary: "a.txt", input: {}, status: "ok" } }),
      ),
      2: chat(
        planItem("p3", 400, { plan: "# Add a dark theme, revised\n", planFilePath: "/Users/me/.claude/plans/dark.md" }),
        planItem("p4", 200, { plan: "## Split the settings page\nSteps\n" }),
        planItem("p5", 250, { plan: "   " }),
      ),
      3: chat(planItem("p6", 500, { plan: "# Elsewhere\n" })),
    };
    const rows = contextPlans(terms, chats, "s1");
    expect(rows.map((r) => r.title)).toEqual([
      "Add a dark theme, revised",
      "Split the settings page",
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
      mention: ".moonlet/context/chat-fix-the-login-redirect.md",
      writes: [
        { root: "/Users/jane/code/app", path: "/Users/jane/code/app/.moonlet/context/.gitignore", content: "*\n" },
        {
          root: "/Users/jane/code/app",
          path: "/Users/jane/code/app/.moonlet/context/chat-fix-the-login-redirect.md",
          content: "# Chat transcript: Fix the login redirect\n\n> Fix the login redirect\n> It loops on Safari.\n\n[Edit] src/auth.ts\n\nDone.\n",
        },
      ],
    });
  });

  it("writes a plan's text and keeps file names inside the context folder (X38)", () => {
    const files = planContextFiles("/Users/jane/code/app/", { key: "k", title: "../../etc/passwd Ünïcode!!", plan: "# Steps\n1. Go\n" });
    expect(files).toEqual({
      mention: ".moonlet/context/plan-etc-passwd-n-code.md",
      writes: [
        { root: "/Users/jane/code/app", path: "/Users/jane/code/app/.moonlet/context/.gitignore", content: "*\n" },
        { root: "/Users/jane/code/app", path: "/Users/jane/code/app/.moonlet/context/plan-etc-passwd-n-code.md", content: "# Steps\n1. Go\n" },
      ],
    });
    expect(planContextFiles("/r", { key: "k", title: "!!!", plan: "x" }).mention).toBe(".moonlet/context/plan-untitled.md");
    expect(planContextFiles("/r", { key: "k", title: "a".repeat(80), plan: "x" }).mention).toBe(`.moonlet/context/plan-${"a".repeat(48)}.md`);
  });
});
