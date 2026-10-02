import { describe, expect, it } from "vitest";
import { commentPrompt, hunkForNewLine, hunkPatch, parseFileDiff } from "./patch";

const DIFF = `diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 one
-two
+2
 three
@@ -10,2 +10,3 @@ fn x() {
 ten
+ten-and-a-half
 eleven
`;

describe("patch", () => {
  it("parses hunks and rebuilds a single-hunk patch", () => {
    const d = parseFileDiff(DIFF);
    expect(d.header).toHaveLength(4);
    expect(d.hunks).toHaveLength(2);
    expect(d.hunks[1]).toMatchObject({ oldStart: 10, oldLines: 2, newStart: 10, newLines: 3 });
    const p = hunkPatch(d, 1);
    expect(p).toContain("+ten-and-a-half");
    expect(p).not.toContain("-two");
    expect(p.startsWith("diff --git")).toBe(true);
    expect(p.endsWith("\n")).toBe(true);
  });

  it("maps new-file lines to hunks", () => {
    const d = parseFileDiff(DIFF);
    expect(hunkForNewLine(d, 2)).toBe(0);
    expect(hunkForNewLine(d, 11)).toBe(1);
    expect(hunkForNewLine(d, 7)).toBe(-1);
  });

  it("formats review comments for the agent", () => {
    expect(commentPrompt("src/a.ts", 4, " rename this ", "const x = 1;")).toBe(
      "Review comment on src/a.ts:4:\n\n```\nconst x = 1;\n```\n\nrename this",
    );
  });
});
