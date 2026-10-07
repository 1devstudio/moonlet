import { describe, expect, it } from "vitest";
import { changeCount, groupByDir } from "./changes";
import type { FileChange } from "./protocol";

const change = (path: string, additions: number, deletions: number, binary = false): FileChange => ({
  path,
  status: "modified",
  staged: false,
  unstaged: true,
  additions,
  deletions,
  binary,
});

describe("changed files grouped by folder (X25)", () => {
  it("groups by folder in path order, the root folder first as /", () => {
    const files = [
      change("docs/specs/X25-file-explorer.md", 80, 0),
      change("apps/desktop/src/components/RightPanel.tsx", 40, 12),
      change("package.json", 1, 1),
      change("apps/desktop/src/components/FileIcon.tsx", 90, 0),
    ];
    expect(groupByDir(files).map((g) => [g.dir, g.files.map((f) => f.name)])).toEqual([
      ["/", ["package.json"]],
      ["apps/desktop/src/components", ["RightPanel.tsx", "FileIcon.tsx"]],
      ["docs/specs", ["X25-file-explorer.md"]],
    ]);
  });
});

describe("a changed file's counts (X25)", () => {
  it("shows additions and deletions, or the side that changed", () => {
    expect(changeCount(change("a.ts", 40, 12))).toBe("+40 −12");
    expect(changeCount(change("a.ts", 80, 0))).toBe("+80");
    expect(changeCount(change("a.ts", 0, 7))).toBe("−7");
  });

  it("shows bin for a binary file", () => {
    expect(changeCount(change("logo.png", 0, 0, true))).toBe("bin");
  });
});
