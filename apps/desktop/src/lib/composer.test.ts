import { describe, expect, it } from "vitest";
import { branchRow } from "./composer";

const facts = { base: "main", task: null, taskBranch: null, from: null, worktree: null, pr: null, checkbox: false };
const web = { key: "WEB-279" };

describe("branchRow (X54)", () => {
  it("shows a task's branch from the base", () => {
    expect(branchRow({ ...facts, task: web, taskBranch: "web-279-remove-placeholder-side-nav-menu-items", checkbox: true })).toEqual({
      kind: "branch",
      name: "web-279-remove-placeholder-side-nav-menu-items",
      detail: "from main",
      clear: null,
    });
  });

  it("names a new branch after the prompt without a task, and a task's quietly until it is worked out", () => {
    expect(branchRow(facts)).toEqual({ kind: "branch", name: null, detail: "from main", clear: null });
    expect(branchRow({ ...facts, task: web })).toEqual({ kind: "branch", name: "…", detail: "from main", clear: null });
  });

  it("starts from a ref or on an existing branch, with × back to the base", () => {
    expect(branchRow({ ...facts, from: { ref: "v2.1", existing: false } })).toEqual({ kind: "branch", name: null, detail: "from v2.1", clear: "Start from main instead" });
    expect(branchRow({ ...facts, task: web, taskBranch: "web-279-x", from: { ref: "v2.1", existing: false } })).toEqual({ kind: "branch", name: "web-279-x", detail: "from v2.1", clear: "Start from main instead" });
    expect(branchRow({ ...facts, from: { ref: "feature/login", existing: true } })).toEqual({ kind: "branch", name: "feature/login", detail: "existing branch", clear: "Create a new branch from main instead" });
  });

  it("keeps an adopted worktree's branch, with no way out", () => {
    expect(branchRow({ ...facts, task: web, taskBranch: "web-279-x", worktree: { branch: "12-orphan-fix" } })).toEqual({ kind: "branch", name: "12-orphan-fix", detail: "existing worktree", clear: null });
  });

  const pr214 = { number: 214, head_branch: "fix/side-nav-cleanup" };

  it("turns into the PR row on a picked PR, undone with Use task branch or New branch instead", () => {
    expect(branchRow({ ...facts, pr: pr214 })).toEqual({
      kind: "pr",
      number: 214,
      name: "fix/side-nav-cleanup",
      detail: "existing branch · checks out in a new worktree",
      title: null,
      undo: { label: "New branch instead", title: "Create a new branch from main instead" },
    });
    expect(branchRow({ ...facts, task: web, taskBranch: "web-279-remove-placeholder-side-nav-menu-items", pr: pr214 })).toEqual({
      kind: "pr",
      number: 214,
      name: "fix/side-nav-cleanup",
      detail: "existing branch · checks out in a new worktree",
      title: null,
      undo: { label: "Use task branch", title: "Back to web-279-remove-placeholder-side-nav-menu-items from main" },
    });
  });

  it("moves the PR row's hint into its tooltip when the checkbox needs the room", () => {
    const row = branchRow({ ...facts, task: web, taskBranch: "web-279-x", pr: pr214, checkbox: true });
    expect(row).toMatchObject({ detail: null, title: "fix/side-nav-cleanup · existing branch · checks out in a new worktree" });
  });
});
