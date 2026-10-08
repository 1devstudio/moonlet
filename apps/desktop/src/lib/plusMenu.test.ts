import { describe, expect, it } from "vitest";
import { fileMention, isAttachShortcut, plusEntries, withMention, withSlashCommand } from "./plusMenu";

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
    expect(plusEntries({ variant: "chat", agents: 2 })).toEqual([["attach"], ["commands", "agents"]]);
  });

  it("hides Subagents when the agent has none", () => {
    expect(plusEntries({ variant: "chat", agents: 0 })).toEqual([["attach"], ["commands"]]);
  });

  it("offers only the file items in the new-session composer", () => {
    expect(plusEntries({ variant: "composer", agents: 3 })).toEqual([["attach"]]);
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
