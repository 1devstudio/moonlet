import { beforeEach, describe, expect, it } from "vitest";
import { answerConfirm, archivePrompt, askConfirm, confirmView, unpushedPrompt } from "./confirm";
import { archiveFlags, archivePlan, DEFAULT_GIT_SETTINGS, unpushedView } from "./gitSettings";
import type { GitSettings, UnpushedWork } from "./protocol";
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

describe("warning before losing unpushed work (X55)", () => {
  const plan = archivePlan(DEFAULT_GIT_SETTINGS, "open", "moonlet/add-search-to-the-product-list", "main");
  const branch = "moonlet/add-search-to-the-product-list";
  const work: UnpushedWork = {
    files: [
      { status: "M", path: "src/search/index.ts" },
      { status: "M", path: "src/components/ProductList.tsx" },
      { status: "?", path: "src/search/ranking.test.ts" },
    ],
    commits: 2,
    upstream: null,
  };

  it("lists the files and the commits only on this machine", () => {
    expect(unpushedView(work, plan, branch, "this Mac")).toEqual({
      heading: "This work is only on this Mac",
      files: work.files,
      more: 0,
      summary: "3 uncommitted files · 2 commits not pushed to origin/moonlet/add-search-to-the-product-list",
      canPush: false,
    });
    expect(unpushedView({ files: [], commits: 1, upstream: "origin/moonlet/x" }, plan, "moonlet/x", "devbox")).toEqual({
      heading: "This work is only on devbox",
      files: [],
      more: 0,
      summary: "1 commit not pushed to origin/moonlet/x",
      canPush: true,
    });
  });

  it("shows at most 8 files and counts the rest", () => {
    const many = { files: Array.from({ length: 11 }, (_, i) => ({ status: "M", path: `f${i}.ts` })), commits: 0, upstream: null };
    const view = unpushedView(many, plan, branch, "this Mac")!;
    expect(view.files.map((f) => f.path)).toEqual(["f0.ts", "f1.ts", "f2.ts", "f3.ts", "f4.ts", "f5.ts", "f6.ts", "f7.ts"]);
    expect(view.more).toBe(3);
    expect(view.summary).toBe("11 uncommitted files");
  });

  it("warns of nothing when nothing would go", () => {
    expect(unpushedView({ files: [], commits: 0, upstream: null }, plan, branch, "this Mac")).toBeNull();
    // A kept folder keeps its files and its branch.
    const kept = archivePlan({ ...DEFAULT_GIT_SETTINGS, archive_worktree: "keep" }, "open", branch, "main");
    expect(unpushedView(work, kept, branch, "this Mac")).toBeNull();
  });

  it("offers Push, then archive only when commits are all there is", () => {
    const prompt = unpushedPrompt("Add search to the product list", plan, unpushedView(work, plan, branch, "this Mac")!);
    expect(prompt.action).toBe("Archive anyway");
    expect(confirmView(prompt, false).variant).toBe("danger");
    expect(prompt.alt).toEqual({ label: "Push, then archive", disabled: "Commit the changes first" });
    expect(confirmView(prompt, false).message).toBe(
      'Archive "Add search to the product list"? Its terminals stop and the worktree folder is removed. The branch is kept: its PR hasn\'t merged.',
    );
    const commitsOnly = unpushedView({ files: [], commits: 2, upstream: null }, plan, branch, "this Mac")!;
    expect(unpushedPrompt("Add search", plan, commitsOnly).alt).toEqual({ label: "Push, then archive" });
  });

  it("tells a push from Archive anyway", async () => {
    const pushed = askConfirm(unpushedPrompt("s1", plan, unpushedView({ files: [], commits: 2, upstream: null }, plan, branch, "this Mac")!));
    answerConfirm(true, false, true);
    expect(await pushed).toEqual({ checked: false, alt: true });
    const anyway = askConfirm(archivePrompt("s1"));
    answerConfirm(true, false);
    expect(await anyway).toEqual({ checked: false });
  });
});
