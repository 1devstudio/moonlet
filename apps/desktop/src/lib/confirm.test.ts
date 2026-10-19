import { beforeEach, describe, expect, it } from "vitest";
import { answerConfirm, archivePrompt, askConfirm, confirmView } from "./confirm";
import { archiveFlags, archivePlan, DEFAULT_GIT_SETTINGS } from "./gitSettings";
import type { GitSettings } from "./protocol";
import { useStore } from "./store";

const discard = { title: "Discard hunk", message: "Discard this hunk from the working tree?", action: "Discard" };

describe("askConfirm", () => {
  beforeEach(() => useStore.setState({ confirm: null }));

  it("opens the modal with the given options", () => {
    void askConfirm(discard);
    expect(useStore.getState().confirm?.options).toEqual(discard);
  });

  it("resolves with the checkbox state when confirmed, and closes", async () => {
    const answer = askConfirm(archivePrompt("s1"));
    answerConfirm(true, true);
    await expect(answer).resolves.toEqual({ checked: true });
    expect(useStore.getState().confirm).toBeNull();
  });

  it("resolves null when cancelled", async () => {
    const answer = askConfirm(discard);
    answerConfirm(false, false);
    await expect(answer).resolves.toBeNull();
    expect(useStore.getState().confirm).toBeNull();
  });

  it("cancels a confirm still open when another one is asked", async () => {
    const first = askConfirm(discard);
    const second = askConfirm(archivePrompt("s1"));
    await expect(first).resolves.toBeNull();
    expect(useStore.getState().confirm?.options.title).toBe("Archive session");
    answerConfirm(true, false);
    await expect(second).resolves.toEqual({ checked: false });
  });
});

describe("archivePrompt", () => {
  it("keeps the branch by default, with a primary Archive button", () => {
    const prompt = archivePrompt("Fix checkout button on mobile");
    expect(prompt.title).toBe("Archive session");
    expect(prompt.action).toBe("Archive");
    expect(prompt.checkbox?.label).toBe("Also delete the branch");
    expect(confirmView(prompt, false)).toEqual({
      message: 'Archive "Fix checkout button on mobile"? Its terminals stop and the worktree folder is removed. The branch is kept.',
      variant: "primary",
    });
  });

  it("turns the button to danger and says so when the branch is deleted too", () => {
    expect(confirmView(archivePrompt("Fix checkout button on mobile"), true)).toEqual({
      message: 'Archive "Fix checkout button on mobile"? Its terminals stop and the worktree folder is removed. The branch is deleted too.',
      variant: "danger",
    });
  });
});

describe("archiving as the host's Git settings say (X55)", () => {
  const git = (patch: Partial<GitSettings>): GitSettings => ({ ...DEFAULT_GIT_SETTINGS, ...patch });
  const name = "Fix checkout button on mobile";
  const branch = "moonlet/fix-checkout-button";

  it("deletes the branch when its PR merged, and keeps it otherwise", () => {
    const merged = archivePlan(git({ archive_branch: "merged" }), "merged", branch, "main");
    expect(confirmView(archivePrompt(name, merged), false)).toEqual({
      message: 'Archive "Fix checkout button on mobile"? Its terminals stop and the worktree folder is removed. Its PR merged, so the branch is deleted.',
      variant: "danger",
    });
    expect(archivePrompt(name, merged).checkbox).toBeUndefined();
    expect(archiveFlags(merged, false)).toEqual({ remove_worktree: true, delete_branch: true, delete_remote: false });

    const open = archivePlan(git({ archive_branch: "merged" }), "open", branch, "main");
    expect(confirmView(archivePrompt(name, open), false).message).toBe(
      'Archive "Fix checkout button on mobile"? Its terminals stop and the worktree folder is removed. The branch is kept: its PR hasn\'t merged.',
    );
    expect(archiveFlags(open, false)).toEqual({ remove_worktree: true, delete_branch: false, delete_remote: false });
    expect(archiveFlags(archivePlan(git({ archive_branch: "merged" }), null, branch, "main"), false).delete_branch).toBe(false);
  });

  it("deletes the branch on origin too only when its PR merged", () => {
    const g = git({ archive_branch: "always", delete_remote_branch: true });
    const merged = archivePlan(g, "merged", branch, "main");
    expect(confirmView(archivePrompt(name, merged), false).message).toBe(
      'Archive "Fix checkout button on mobile"? Its terminals stop and the worktree folder is removed. The branch is deleted, on origin too.',
    );
    expect(archiveFlags(merged, false)).toEqual({ remove_worktree: true, delete_branch: true, delete_remote: true });
    expect(archiveFlags(archivePlan(g, "open", branch, "main"), false)).toEqual({ remove_worktree: true, delete_branch: true, delete_remote: false });
  });

  it("asks with the checkbox, as before, when set to Ask each time", () => {
    const ask = archivePlan(git({ archive_branch: "ask", delete_remote_branch: true }), "merged", branch, "main");
    expect(archivePrompt(name, ask).checkbox?.label).toBe("Also delete the branch");
    expect(archiveFlags(ask, false)).toEqual({ remove_worktree: true, delete_branch: false, delete_remote: false });
    expect(archiveFlags(ask, true)).toEqual({ remove_worktree: true, delete_branch: true, delete_remote: true });
  });

  it("keeps the folder and its branch when the folder is kept", () => {
    const keep = archivePlan(git({ archive_worktree: "keep", archive_branch: "always" }), "merged", branch, "main");
    expect(confirmView(archivePrompt(name, keep), false)).toEqual({
      message: 'Archive "Fix checkout button on mobile"? Its terminals stop; the worktree folder stays on disk. The branch is kept.',
      variant: "primary",
    });
    expect(archiveFlags(keep, false)).toEqual({ remove_worktree: false, delete_branch: false, delete_remote: false });
  });

  it("never deletes the project's base branch", () => {
    const base = archivePlan(git({ archive_branch: "always" }), "merged", "main", "main");
    expect(archiveFlags(base, true)).toEqual({ remove_worktree: true, delete_branch: false, delete_remote: false });
    expect(archivePrompt(name, base).checkbox).toBeUndefined();
  });
});
