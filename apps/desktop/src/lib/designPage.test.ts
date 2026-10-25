import { describe, expect, it } from "vitest";
import { pageFile, pageOfFile, pageOfPath, pagePath } from "./designPage";

describe("a design page's file (X65)", () => {
  it("is <page>.html in the design's pages/, and only such a path names a page", () => {
    expect(pageFile("git-a")).toBe("git-a.html");
    expect(pagePath("git-a")).toBe("pages/git-a.html");
    expect(pageOfPath("pages/git-a.html")).toBe("git-a");
    for (const other of ["pages/notes.txt", "pages/sub/x.html", "assets/logo.svg", "design.toml", "pages/.html"]) expect(pageOfPath(other)).toBeNull();
  });

  it("is named by its file as the daemon takes a page's name, a space included, never a folder or a hidden file", () => {
    expect(pageOfFile("git rows.html")).toBe("git rows");
    expect(pageOfPath("pages/git rows.html")).toBe("git rows");
    for (const other of [".git.html", "a\\b.html", "git.htm", ".html"]) expect(pageOfFile(other)).toBeNull();
  });
});
