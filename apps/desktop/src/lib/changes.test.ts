import { describe, expect, it } from "vitest";
import { changeCount, changeList, changeTree, type ChangeNode } from "./changes";
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

/** A tree as nested literals: a folder is `[name, children]`, a file its name. */
const shape = (nodes: ChangeNode[]): unknown[] => nodes.map((n) => (n.kind === "dir" ? [n.name, shape(n.children)] : n.name));

describe("changed files as a tree (X28)", () => {
  it("nests folders before files, and folds single-folder chains into one row", () => {
    const files = [
      change("core/services/console/package.json", 1, 0),
      change("core/services/console/src/sources/grants.ts", 100, 0),
      change("README.md", 3, 1),
      change("core/services/console/src/deploy/route.platform.test.ts", 2, 0),
      change("core/services/console/src/app.ts", 13, 0),
      change("core/services/console/src/sources/schema-import/merge.ts", 192, 0),
    ];
    expect(shape(changeTree(files))).toEqual([
      [
        "core/services/console",
        [
          [
            "src",
            [
              ["deploy", ["route.platform.test.ts"]],
              ["sources", [["schema-import", ["merge.ts"]], "grants.ts"]],
              "app.ts",
            ],
          ],
          "package.json",
        ],
      ],
      "README.md",
    ]);
  });
});

describe("changed files as a list (X28)", () => {
  it("sorts by path and splits each into its folder and its name", () => {
    const files = [
      change("core/services/console/src/sources/route.ts", 224, 0),
      change("README.md", 3, 1),
      change("core/services/console/src/sources/route.test.ts", 565, 2),
      change("core/services/console/package.json", 1, 0),
    ];
    expect(changeList(files).map((f) => [f.dir, f.name])).toEqual([
      ["core/services/console/", "package.json"],
      ["core/services/console/src/sources/", "route.test.ts"],
      ["core/services/console/src/sources/", "route.ts"],
      ["", "README.md"],
    ]);
  });
});
