import { describe, expect, it } from "vitest";
import { pageFile, pageOfPath, pagePath } from "./designPage";

describe("a design page's file (X65)", () => {
  it("is <page>.html in the design's pages/, and only such a path names a page", () => {
    expect(pageFile("git-a")).toBe("git-a.html");
    expect(pagePath("git-a")).toBe("pages/git-a.html");
    expect(pageOfPath("pages/git-a.html")).toBe("git-a");
    for (const other of ["pages/notes.txt", "pages/sub/x.html", "assets/logo.svg", "design.toml", "pages/.html"]) expect(pageOfPath(other)).toBeNull();
  });
});
