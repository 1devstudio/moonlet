import { describe, expect, it } from "vitest";
import { bulkArchivePrompt } from "./bulkArchive";
import { confirmView } from "./confirmOptions";
import type { ArchivePlan } from "./gitSettings";

const removeKeep: ArchivePlan = { removeWorktree: true, branch: "keep", why: "policy", remote: false };
const removeAsk: ArchivePlan = { removeWorktree: true, branch: "ask", why: "policy", remote: false };

describe("bulkArchivePrompt (X106)", () => {
  it("lists each session with a note, and pushes the one with commits only here first", () => {
    // The design's archive.html: three sessions, one with 2 commits not pushed.
    const o = bulkArchivePrompt([
      { name: "Dark mode for account pages", state: "done", plan: removeKeep, work: { files: [], commits: 0, upstream: null }, running: null },
      { name: "Idempotent refund endpoint", state: "working", plan: removeKeep, work: { files: [], commits: 0, upstream: null }, running: null },
      { name: "Rate-limit webhook retries", state: "error", plan: removeKeep, work: { files: [], commits: 2, upstream: "origin/moonlet/webhooks" }, running: null },
    ]);
    expect(o.title).toBe("Archive 3 sessions");
    expect(confirmView(o, false)).toEqual({ message: "Their terminals stop and their worktree folders are removed. Branches are kept.", variant: "danger" });
    expect(o.action).toBe("Archive anyway");
    expect(o.alt).toEqual({ label: "Push 1, then archive all" });
    expect(o.checkbox).toBeUndefined();
    expect(o.sessions).toEqual([
      { name: "Dark mode for account pages", state: "done", note: "done", warn: false },
      { name: "Idempotent refund endpoint", state: "working", note: "agent working, stops", warn: true },
      { name: "Rate-limit webhook retries", state: "error", note: "2 commits not pushed", warn: true },
    ]);
  });

  it("archives plainly when nothing would be lost, and asks about the branches when the settings ask", () => {
    const o = bulkArchivePrompt([
      { name: "Changelog page", state: "done", plan: removeAsk, work: { files: [], commits: 0, upstream: null }, running: null },
      { name: "Fix footer links", state: null, plan: removeKeep, work: null, running: null },
    ]);
    expect(o.action).toBe("Archive 2");
    expect(o.alt).toBeUndefined();
    expect(o.checkbox).toEqual({ label: "Also delete the branches" });
    expect(confirmView(o, false)).toEqual({ message: "Their terminals stop and their worktree folders are removed. Branches are kept.", variant: "primary" });
    // Only Changelog's settings ask: Fix footer links keeps its branch.
    expect(confirmView(o, true)).toEqual({ message: "Their terminals stop and their worktree folders are removed. 1 of their branches is deleted, the others kept.", variant: "danger" });
    expect(o.sessions).toEqual([
      { name: "Changelog page", state: "done", note: "done", warn: false },
      { name: "Fix footer links", state: null, note: "", warn: false },
    ]);
  });

  it("can't push first while a session has uncommitted files", () => {
    const o = bulkArchivePrompt([
      { name: "Fix checkout button on mobile", state: "blocked", plan: removeKeep, work: { files: [{ status: "M", path: "src/Cart.tsx" }, { status: "?", path: "src/new.ts" }], commits: 1, upstream: null }, running: null },
      { name: "Changelog page", state: "idle", plan: { removeWorktree: false, branch: "keep", why: "policy", remote: false }, work: { files: [], commits: 0, upstream: null }, running: { processes: [{ pid: 9, name: "vite", origin: { kind: "run", id: 3, title: "pnpm dev" }, tab: false }], leftovers: [] } },
    ]);
    expect(o.alt).toEqual({ label: "Push 1, then archive all", disabled: "Commit the changes first" });
    expect(confirmView(o, false).message).toBe("Their terminals stop; worktree folders are removed or kept by each host's Git settings. Branches are kept.");
    expect(o.sessions).toEqual([
      { name: "Fix checkout button on mobile", state: "blocked", note: "2 uncommitted files, 1 commit not pushed", warn: true },
      { name: "Changelog page", state: "idle", note: "vite still runs, stops", warn: false },
    ]);
  });
});
