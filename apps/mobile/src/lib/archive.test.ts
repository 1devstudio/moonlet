import { describe, expect, it } from "vitest";
import { DEFAULT_GIT_SETTINGS } from "@desktop/lib/gitSettings";
import { archiveSheet } from "./archive";
import { session } from "./fixtures";

const checkout = session("checkout", "Fix checkout button on mobile");
const clean = { files: [], commits: 0, upstream: "origin/moonlet/checkout" };

describe("archiveSheet (X55)", () => {
  it("keeps the worktree folder and the branch when the host's settings say so", () => {
    const sheet = archiveSheet({ session: checkout, base: "main", git: { ...DEFAULT_GIT_SETTINGS, archive_worktree: "keep" }, prState: "merged", work: clean, hostLabel: "studio" });
    expect(sheet.message(false)).toBe('Archive "Fix checkout button on mobile"? Its terminals stop; the worktree folder stays on disk. The branch is kept.');
    expect(sheet.checkbox).toBeNull();
    expect(sheet.flags(false)).toEqual({ remove_worktree: false, delete_branch: false, delete_remote: false });
  });

  it("deletes a merged PR's branch, on origin too when the host says so", () => {
    const sheet = archiveSheet({ session: checkout, base: "main", git: { ...DEFAULT_GIT_SETTINGS, delete_remote_branch: true }, prState: "merged", work: clean, hostLabel: "studio" });
    expect(sheet.message(false)).toBe('Archive "Fix checkout button on mobile"? Its terminals stop and the worktree folder is removed. The branch is deleted, on origin too.');
    expect(sheet.danger(false)).toBe(true);
    expect(sheet.flags(false)).toEqual({ remove_worktree: true, delete_branch: true, delete_remote: true });
  });

  it("asks about the branch with a checkbox under Ask each time", () => {
    const sheet = archiveSheet({ session: checkout, base: "main", git: { ...DEFAULT_GIT_SETTINGS, archive_branch: "ask" }, prState: null, work: clean, hostLabel: "studio" });
    expect(sheet.checkbox).toBe("Also delete the branch");
    expect(sheet.flags(true)).toEqual({ remove_worktree: true, delete_branch: true, delete_remote: false });
    expect(sheet.flags(false).delete_branch).toBe(false);
  });

  it("warns about commits only on the host, and offers to push them first", () => {
    const sheet = archiveSheet({ session: checkout, base: "main", git: null, prState: "open", work: { ...clean, commits: 2 }, hostLabel: "studio" });
    expect(sheet.action).toBe("Archive anyway");
    expect(sheet.unpushed?.heading).toBe("This work is only on studio");
    expect(sheet.unpushed?.summary).toBe("2 commits not pushed to origin/moonlet/checkout");
    expect(sheet.push).toEqual({ label: "Push, then archive" });
  });

  it("cannot push uncommitted files", () => {
    const sheet = archiveSheet({ session: checkout, base: "main", git: null, prState: null, work: { files: [{ status: "M", path: "src/cart.ts" }], commits: 1, upstream: null }, hostLabel: "studio" });
    expect(sheet.unpushed?.summary).toBe("1 uncommitted file · 1 commit not pushed to origin/moonlet/checkout");
    expect(sheet.push).toEqual({ label: "Push, then archive", disabled: "Commit the changes first" });
  });

  it("archives without a warning when nothing is lost", () => {
    const sheet = archiveSheet({ session: checkout, base: "main", git: null, prState: null, work: clean, hostLabel: "studio" });
    expect(sheet.action).toBe("Archive");
    expect(sheet.unpushed).toBeNull();
    expect(sheet.push).toBeNull();
  });
});

describe("archiveSheet without the unpushed warning (X55)", () => {
  it("archives at once when the host's settings turn the warning off", () => {
    const sheet = archiveSheet({ session: checkout, base: "main", git: { ...DEFAULT_GIT_SETTINGS, warn_unpushed: false }, prState: null, work: { ...clean, commits: 3 }, hostLabel: "studio" });
    expect(sheet.action).toBe("Archive");
    expect(sheet.unpushed).toBeNull();
  });
});
