import { describe, expect, it } from "vitest";
import { chipModel } from "./chips";

const file = (over: object) => ({ staged: false, unstaged: false, status: "modified", ...over });

describe("input editor chips (T8)", () => {
  it("shows node, directory, branch and uncommitted changes, in that order", () => {
    expect(
      chipModel({
        nodeVersion: "v24.19.0",
        cwd: "/Users/me/src/app",
        home: "/Users/me",
        branch: "main",
        files: [file({ staged: true }), file({ unstaged: true }), file({ status: "untracked" }), file({})],
      }),
    ).toEqual([
      { kind: "node", text: "v24.19.0" },
      { kind: "dir", text: "~/src/app" },
      { kind: "branch", text: "main" },
      { kind: "changes", text: "± 3" },
    ]);
  });

  it("leaves out what is not known", () => {
    expect(chipModel({ cwd: "/tmp", home: "/Users/me" })).toEqual([{ kind: "dir", text: "/tmp" }]);
  });

  it("shows ± 0 for a clean worktree", () => {
    expect(chipModel({ cwd: "/tmp", home: null, files: [file({})] }).at(-1)).toEqual({ kind: "changes", text: "± 0" });
  });

  it("counts a file staged and changed again once", () => {
    expect(chipModel({ cwd: "/tmp", home: null, files: [file({ staged: true, unstaged: true })] }).at(-1)?.text).toBe("± 1");
  });
});
