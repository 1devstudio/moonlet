import { describe, expect, it } from "vitest";
import { chipModel, uncommitted } from "./chips";

const file = (over: object) => ({ staged: false, unstaged: false, status: "modified", additions: 0, deletions: 0, ...over });

describe("input editor chips (T8)", () => {
  it("shows node, directory, branch and uncommitted changes, in that order", () => {
    expect(
      chipModel({
        nodeVersion: "v24.19.0",
        cwd: "/Users/me/src/app",
        home: "/Users/me",
        branch: "main",
        files: [
          file({ staged: true, additions: 100, deletions: 20 }),
          file({ unstaged: true, additions: 13, deletions: 10 }),
          file({ status: "untracked" }),
          file({ additions: 7 }),
        ],
      }),
    ).toEqual([
      { kind: "node", text: "v24.19.0" },
      { kind: "dir", text: "~/src/app" },
      { kind: "branch", text: "main" },
      { kind: "changes", text: "3 • +113 -30", files: 3, additions: 113, deletions: 30 },
    ]);
  });

  it("leaves out what is not known", () => {
    expect(chipModel({ cwd: "/tmp", home: "/Users/me" })).toEqual([{ kind: "dir", text: "/tmp" }]);
  });

  it("shows 0 • +0 -0 for a clean worktree", () => {
    expect(chipModel({ cwd: "/tmp", home: null, files: [file({ additions: 5 })] }).at(-1)).toEqual({ kind: "changes", text: "0 • +0 -0", files: 0, additions: 0, deletions: 0 });
  });

  it("counts a file staged and changed again once", () => {
    expect(chipModel({ cwd: "/tmp", home: null, files: [file({ staged: true, unstaged: true, additions: 2 })] }).at(-1)?.text).toBe("1 • +2 -0");
  });
});

describe("uncommitted changes (T8)", () => {
  it("sums the files with uncommitted changes, not the ones only committed on the branch", () => {
    expect(uncommitted([file({ staged: true, additions: 4, deletions: 1 }), file({ additions: 50, deletions: 9 })])).toEqual({ files: 1, additions: 4, deletions: 1 });
  });
});
