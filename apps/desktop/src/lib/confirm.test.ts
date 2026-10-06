import { beforeEach, describe, expect, it } from "vitest";
import { answerConfirm, archivePrompt, askConfirm, confirmView } from "./confirm";
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
