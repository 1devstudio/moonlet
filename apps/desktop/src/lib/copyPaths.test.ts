import { describe, expect, it } from "vitest";
import { fileCopies } from "./copyPaths";

describe("copying a file's path from a header", () => {
  it("offers the path relative to the worktree and the full path, from a path in the worktree", () => {
    expect(fileCopies("/Users/alex/wt/acme", "src/app/main.ts")).toEqual([
      { label: "Copy path", text: "src/app/main.ts" },
      { label: "Copy full path", text: "/Users/alex/wt/acme/src/app/main.ts" },
    ]);
  });

  it("offers the same two from a full path inside the worktree", () => {
    expect(fileCopies("/Users/alex/wt/acme/", "/Users/alex/wt/acme/README.md")).toEqual([
      { label: "Copy path", text: "README.md" },
      { label: "Copy full path", text: "/Users/alex/wt/acme/README.md" },
    ]);
  });

  it("offers only the full path for a file outside the worktree, or with no worktree", () => {
    expect(fileCopies("/Users/alex/wt/acme", "/Users/alex/.zshrc")).toEqual([{ label: "Copy full path", text: "/Users/alex/.zshrc" }]);
    expect(fileCopies(null, "/tmp/notes.md")).toEqual([{ label: "Copy full path", text: "/tmp/notes.md" }]);
  });
});
