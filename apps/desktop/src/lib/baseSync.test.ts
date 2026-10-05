import { describe, expect, it } from "vitest";
import { aheadText, baseChip, behindHeadline, chipClick, fetchedLabel, justMerged, pullToast, rebaseCommand } from "./baseSync";
import type { BaseStatus } from "./protocol";

const status = (ahead: number, behind: number): BaseStatus => ({
  branch: "main",
  upstream: "origin/main",
  ahead,
  behind,
  commits: [],
  checkout: "/src/jaunt",
  fetch_error: null,
});

describe("baseChip", () => {
  it("counts the commits main is behind origin", () => {
    expect(baseChip(status(0, 3), false)).toEqual({ kind: "behind", text: "3", title: "main is 3 commits behind origin/main" });
    expect(baseChip(status(0, 1), false)?.title).toBe("main is 1 commit behind origin/main");
  });

  it("says pulling while a pull runs", () => {
    expect(baseChip(status(0, 3), true)).toEqual({ kind: "pulling", text: "pulling", title: "Pulling main" });
  });

  it("flags a branch that is both ahead and behind as diverged", () => {
    expect(baseChip(status(1, 3), false)).toEqual({ kind: "diverged", text: "diverged", title: "main can't be fast-forwarded" });
  });

  it("hides when there is nothing to pull", () => {
    expect(baseChip(status(0, 0), false)).toBeNull();
    expect(baseChip(status(2, 0), false)).toBeNull();
    expect(baseChip(null, false)).toBeNull();
    expect(baseChip(undefined, false)).toBeNull();
  });
});

describe("chipClick", () => {
  it("pulls straight away when main is only behind", () => {
    expect(chipClick(baseChip(status(0, 3), false))).toBe("pull");
  });

  it("opens the details for a diverged branch, which jaunt can't pull", () => {
    expect(chipClick(baseChip(status(1, 3), false))).toBe("details");
  });

  it("does nothing while a pull runs", () => {
    expect(chipClick(baseChip(status(0, 3), true))).toBeNull();
  });
});

describe("popover text", () => {
  it("heads the list with how far behind origin the branch is", () => {
    expect(behindHeadline(status(0, 3))).toBe("main is 3 commits behind origin");
    expect(behindHeadline(status(0, 1))).toBe("main is 1 commit behind origin");
  });

  it("explains a divergence with the local-only commits", () => {
    expect(aheadText(status(1, 3))).toBe("1 commit that isn't");
    expect(aheadText(status(2, 3))).toBe("2 commits that aren't");
  });

  it("says when jaunt last fetched and why", () => {
    const now = 1_000_000_000;
    expect(fetchedLabel({ fetchedAt: now - 5_000, reason: "after PR #128 merged", fetchError: null }, now)).toBe("fetched just now · after PR #128 merged");
    expect(fetchedLabel({ fetchedAt: now - 7 * 60_000, reason: null, fetchError: null }, now)).toBe("fetched 7 min ago");
    expect(fetchedLabel({ fetchedAt: now - 3 * 3_600_000, reason: null, fetchError: null }, now)).toBe("fetched 3 h ago");
    expect(fetchedLabel({ fetchedAt: now - 60_000, reason: null, fetchError: "Could not resolve host: github.com" }, now)).toBe("couldn't fetch · fetched 1 min ago");
    expect(fetchedLabel({ fetchedAt: null, reason: null, fetchError: "Could not resolve host: github.com" }, now)).toBe("couldn't fetch");
  });

  it("reports the pull and the commit new sessions start from", () => {
    expect(pullToast("main", { pulled: 3, head: "9c41e2a7d1f0b8c3e4d5a6b7c8d9e0f1a2b3c4d5" })).toBe("Pulled 3 commits into main. New sessions start from 9c41e2a.");
    expect(pullToast("main", { pulled: 1, head: "4b7d010aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).toBe("Pulled 1 commit into main. New sessions start from 4b7d010.");
    expect(pullToast("main", { pulled: 0, head: "4b7d010aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).toBe("main is already up to date.");
  });
});

describe("rebaseCommand", () => {
  it("rebases in the work tree that has the branch checked out", () => {
    expect(rebaseCommand(status(1, 3), "/src/jaunt")).toBe("git -C /src/jaunt pull --rebase");
  });

  it("switches to the branch first when no work tree has it", () => {
    expect(rebaseCommand({ ...status(1, 3), checkout: null }, "/src/jaunt")).toBe("git -C /src/jaunt switch main && git -C /src/jaunt pull --rebase");
  });

  it("quotes a path the shell would split", () => {
    expect(rebaseCommand({ ...status(1, 3), checkout: "/Users/me/My Repos/it's" }, "/x")).toBe("git -C '/Users/me/My Repos/it'\\''s' pull --rebase");
  });
});

describe("justMerged", () => {
  const pr = (state: string) => ({ number: 128, state });

  it("fires when a PR jaunt saw open turns merged", () => {
    expect(justMerged(pr("open"), pr("merged"))).toBe(true);
    expect(justMerged(null, pr("merged"))).toBe(true);
  });

  it("ignores a PR that was already merged or is first seen merged", () => {
    expect(justMerged(pr("merged"), pr("merged"))).toBe(false);
    // First poll after start: the host load already fetched.
    expect(justMerged(undefined, pr("merged"))).toBe(false);
    expect(justMerged(pr("open"), pr("closed"))).toBe(false);
    expect(justMerged(pr("open"), null)).toBe(false);
  });
});
