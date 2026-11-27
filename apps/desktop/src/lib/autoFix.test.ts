import { describe, expect, it } from "vitest";
import { autoFixMenu, autoFixMessage, autoFixNotices } from "./autoFix";
import type { Session } from "./protocol";

const session = (id: string, over: Partial<Session> = {}) =>
  ({ id, project_id: "p", name: `Session ${id}`, branch: "b", base: "main", path: "/w", agent: null, archived: false, created_at: 1, terminals: [], layout: null, ...over }) as Session;

describe("auto-fixing a PR (X117)", () => {
  it("shows a message auto-fix sent with its label and without its mark", () => {
    expect(autoFixMessage("[Auto-fix] Checks failed on #12 (abc1234): test.\n- test: https://x")).toBe("Checks failed on #12 (abc1234): test.\n- test: https://x");
    expect(autoFixMessage("Fix the checks please")).toBeNull();
  });

  it("offers Auto-fix this PR only for an open PR, checked as the host says", () => {
    expect(autoFixMenu(session("a"), { state: "merged" })).toBeNull();
    expect(autoFixMenu(session("a"), null)).toBeNull();
    expect(autoFixMenu(session("a"), { state: "open" })).toEqual({ checked: false, hint: null, disabled: false });
    const on = session("a", { auto_fix: { pr: 12, on: true, tries: 1, stopped: false } });
    expect(autoFixMenu(on, { state: "open" })).toEqual({ checked: true, hint: null, disabled: false });
    const stopped = session("a", { auto_fix: { pr: 12, on: true, tries: 3, stopped: true } });
    expect(autoFixMenu(stopped, { state: "open" })).toEqual({ checked: false, hint: "Auto-fix stopped after 3 tries", disabled: false });
    const noChat = session("a", { auto_fix: { pr: 12, on: true, tries: 0, stopped: false, note: "Needs a Claude chat in this session" } });
    expect(autoFixMenu(noChat, { state: "open" })).toEqual({ checked: true, hint: "Needs a Claude chat in this session", disabled: false });
  });

  it("says what auto-fix just sent or that it stopped, once", () => {
    const before = [session("a", { auto_fix: { pr: 12, on: true, tries: 0, stopped: false } }), session("b", { auto_fix: { pr: 7, on: true, tries: 2, stopped: false } })];
    const after = [
      session("a", { auto_fix: { pr: 12, on: true, tries: 1, stopped: false, last: ["checks", 5] } }),
      session("b", { auto_fix: { pr: 7, on: true, tries: 3, stopped: true } }),
    ];
    expect(autoFixNotices(before, after)).toEqual([
      { session: "a", text: "Auto-fix: sent #12's failed checks to Session a" },
      { session: "b", text: "Auto-fix stopped on #7 after 3 tries. Checks still fail." },
    ]);
    expect(autoFixNotices(after, after)).toEqual([]);
  });
});
