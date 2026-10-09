import { describe, expect, it } from "vitest";
import { canMentionFiles, fileMention, isAttachShortcut, mcpCard, mcpSummary, plusEntries, withMention, withSlashCommand } from "./plusMenu";
import type { McpServer } from "./protocol";

describe("+ menu: slash commands (X29)", () => {
  it("puts the command at the start of an empty input", () => {
    expect(withSlashCommand("", "review")).toEqual({ text: "/review ", caret: 8 });
  });

  it("keeps what was typed after the command", () => {
    expect(withSlashCommand("the login page", "review")).toEqual({ text: "/review the login page", caret: 8 });
  });

  it("replaces a command already at the start", () => {
    expect(withSlashCommand("/compact keep the plan", "review")).toEqual({ text: "/review keep the plan", caret: 8 });
  });

  it("keeps the line breaks after a replaced command", () => {
    expect(withSlashCommand("/compact\n\nkeep the plan", "review")).toEqual({ text: "/review \n\nkeep the plan", caret: 8 });
  });
});

describe("+ menu: subagents (X29)", () => {
  it("inserts the mention at the caret with a space after it", () => {
    expect(withMention("", 0, "agent-Plan")).toEqual({ text: "@agent-Plan ", caret: 12 });
  });

  it("separates the mention from the word before the caret", () => {
    expect(withMention("ask the", 7, "agent-Plan")).toEqual({ text: "ask the @agent-Plan ", caret: 20 });
  });

  it("keeps the text after the caret", () => {
    expect(withMention("ask  to plan it", 4, "agent-Plan")).toEqual({ text: "ask @agent-Plan  to plan it", caret: 16 });
  });
});

describe("+ menu: entries (X29)", () => {
  it("offers files, then the agent's commands and subagents, in a session", () => {
    expect(plusEntries({ variant: "chat", agents: 2 })).toEqual([["attach", "add-dir"], ["commands", "mcp", "agents"]]);
  });

  it("hides Subagents when the agent has none", () => {
    expect(plusEntries({ variant: "chat", agents: 0 })).toEqual([["attach", "add-dir"], ["commands", "mcp"]]);
  });

  it("offers only the file items in the new-session composer", () => {
    expect(plusEntries({ variant: "composer", agents: 3 })).toEqual([["attach", "add-dir"]]);
  });
});

describe("+ menu: ⌘U attaches (X29)", () => {
  it("matches ⌘U and nothing else", () => {
    const key = (over: object) => ({ key: "u", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });
    expect(isAttachShortcut(key({ metaKey: true }))).toBe(true);
    expect(isAttachShortcut(key({ metaKey: true, key: "U" }))).toBe(true);
    expect(isAttachShortcut(key({}))).toBe(false);
    expect(isAttachShortcut(key({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isAttachShortcut(key({ ctrlKey: true }))).toBe(false);
  });
});

describe("+ menu: attached files become mentions (X29)", () => {
  it("is relative to the session's directory when inside it", () => {
    expect(fileMention("/Users/me/repo/src/login.ts", "/Users/me/repo")).toBe("src/login.ts");
  });

  it("stays absolute outside it", () => {
    expect(fileMention("/Users/me/notes/plan.md", "/Users/me/repo")).toBe("/Users/me/notes/plan.md");
    expect(fileMention("/Users/me/repo-old/a.ts", "/Users/me/repo")).toBe("/Users/me/repo-old/a.ts");
  });

  it("quotes a path with spaces", () => {
    expect(fileMention("/Users/me/repo/docs/Release notes.md", "/Users/me/repo")).toBe('"docs/Release notes.md"');
  });
});

describe("+ menu: files on a remote host (X29)", () => {
  it("mentions this Mac's files only in a local session", () => {
    expect(canMentionFiles("local")).toBe(true);
    expect(canMentionFiles("devbox")).toBe(false);
  });
});

const mcp = (name: string, status: string, over: Partial<McpServer> = {}): McpServer => ({ name, status, transport: "http", tools: [], ...over });

describe("+ menu: MCP servers (X29)", () => {
  // The servers Claude Code 2.1.292 reported in a captured session.
  const servers = [
    mcp("claude.ai Slack", "connected", { transport: "claude.ai" }),
    mcp("claude.ai Linear", "needs-auth", { transport: "claude.ai" }),
    mcp("claude.ai Gmail", "authing", { transport: "claude.ai" }),
    mcp("broken", "failed", { transport: "stdio" }),
    mcp("everything", "connected", { transport: "stdio" }),
  ];

  it("counts connected servers and those waiting for sign-in", () => {
    expect(mcpSummary(servers)).toEqual({ header: "MCP servers · 2/5", needsAuth: 2 });
    expect(mcpSummary([])).toEqual({ header: "MCP servers · 0/0", needsAuth: 0 });
  });

  it("labels each status and picks its dot", () => {
    const card = (status: string) => mcpCard(mcp("x", status));
    expect([card("connected"), card("needs-auth"), card("authing"), card("failed"), card("pending"), card("disabled")].map((c) => [c.label, c.glyph])).toEqual([
      ["Connected", "done"],
      ["Needs authentication", "blocked"],
      ["Signing in…", "working"],
      ["Failed to connect", "error"],
      ["Starting…", "idle"],
      ["Disabled", "idle"],
    ]);
  });

  it("shows up to six tools and how many more there are", () => {
    const tools = ["create_issue", "search_code", "get_pull_request", "list_commits", "create_branch", "add_comment", "merge_pr", "list_repos"];
    expect(mcpCard(mcp("github", "connected", { tools })).tools).toEqual({
      summary: "8 tools",
      chips: ["create_issue", "search_code", "get_pull_request", "list_commits", "create_branch", "add_comment", "+2 more"],
    });
    expect(mcpCard(mcp("context7", "connected", { tools: ["resolve-library-id"] })).tools).toEqual({ summary: "1 tool", chips: ["resolve-library-id"] });
    expect(mcpCard(mcp("linear", "needs-auth", { tools: ["list_issues"] })).tools).toBeNull();
  });
});
