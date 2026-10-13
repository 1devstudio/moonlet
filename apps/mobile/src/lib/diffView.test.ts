import { describe, expect, it } from "vitest";
import { parseFileDiff } from "@desktop/lib/patch";
import type { FileChange } from "@desktop/lib/protocol";
import { commitLabel, diffRows, folderGroups, statusLetter } from "./diffView";

const file = (path: string, patch: Partial<FileChange> = {}): FileChange => ({
  path,
  status: "modified",
  staged: false,
  unstaged: true,
  additions: 1,
  deletions: 0,
  binary: false,
  ...patch,
});

describe("folderGroups", () => {
  it("groups changed files by folder, folders and files by name", () => {
    const groups = folderGroups([file("src/lib/filter.ts"), file("src/components/SearchBox.tsx"), file("README.md"), file("src/components/ProductList.tsx")]);
    expect(groups.map((g) => [g.dir, g.files.map((f) => f.name)])).toEqual([
      ["", ["README.md"]],
      ["src/components", ["ProductList.tsx", "SearchBox.tsx"]],
      ["src/lib", ["filter.ts"]],
    ]);
  });
});

describe("statusLetter", () => {
  it("is git's letter for the change", () => {
    expect(["modified", "added", "deleted", "renamed", "untracked", "conflicted"].map((s) => statusLetter(file("a", { status: s as FileChange["status"] })))).toEqual([
      "M",
      "A",
      "D",
      "R",
      "?",
      "U",
    ]);
  });
});

describe("commitLabel", () => {
  it("counts the staged files", () => {
    expect(commitLabel([file("a", { staged: true }), file("b", { staged: true }), file("c"), file("d", { staged: true })])).toBe("Commit 3 staged");
    expect(commitLabel([file("a", { staged: true })])).toBe("Commit 1 staged");
    expect(commitLabel([file("a")])).toBe("Nothing staged");
  });
});

// `git diff` of ProductList.tsx in the design's review.
const DIFF = `diff --git a/src/components/ProductList.tsx b/src/components/ProductList.tsx
index 3b18e51..a9c2f04 100644
--- a/src/components/ProductList.tsx
+++ b/src/components/ProductList.tsx
@@ -12,4 +12,6 @@ ProductList
 export function ProductList({ products }: Props) {
-  const items = products;
+  const [query, setQuery] = useState("");
+  const items = filterProducts(products, query);
+  // SKU and name
   return (
@@ -40,2 +44,3 @@
   );
+}
\\ No newline at end of file
`;

describe("diffRows", () => {
  it("numbers old and new lines through each hunk", () => {
    const rows = diffRows(parseFileDiff(DIFF));
    expect(rows.map((r) => (r.kind === "hunk" ? `@@ ${r.index}` : `${r.old ?? "-"} ${r.new ?? "-"} ${r.sign}${r.text}`))).toEqual([
      "@@ 0",
      "12 12  export function ProductList({ products }: Props) {",
      "13 - -  const items = products;",
      "- 13 +  const [query, setQuery] = useState(\"\");",
      "- 14 +  const items = filterProducts(products, query);",
      "- 15 +  // SKU and name",
      "14 16    return (",
      "@@ 1",
      "40 44    );",
      "- 45 +}",
    ]);
  });
});
