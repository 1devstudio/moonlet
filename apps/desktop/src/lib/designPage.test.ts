import { describe, expect, it } from "vitest";
import { pageCopies, pageFile, pageOfFile, pageOfPath, pagePath } from "./designPage";

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

  it("is never named with an @, as the daemon takes none: designs/<slug>@<n>/ is a snapshot's folder", () => {
    expect(pageOfFile("git@2.html")).toBeNull();
    expect(pageOfPath("pages/git@2.html")).toBeNull();
  });
});

describe("copying the path above a design's page", () => {
  it("offers the path it shows and the page's full path on disk", () => {
    expect(pageCopies("docs/design/approval/pages/after.html", "/Users/alex/wt/acme/docs/design/approval", "after")).toEqual([
      { label: "Copy path", text: "docs/design/approval/pages/after.html" },
      { label: "Copy full path", text: "/Users/alex/wt/acme/docs/design/approval/pages/after.html" },
    ]);
    expect(pageCopies("index.html", "/Users/alex/.moonlet/design/systems/acme/designs/home/", "index")).toEqual([
      { label: "Copy path", text: "index.html" },
      { label: "Copy full path", text: "/Users/alex/.moonlet/design/systems/acme/designs/home/pages/index.html" },
    ]);
  });

  it("offers one copy when the path shown is already the full path", () => {
    expect(pageCopies("/tmp/home/pages/index.html", "/tmp/home", "index")).toEqual([{ label: "Copy path", text: "/tmp/home/pages/index.html" }]);
  });
});
