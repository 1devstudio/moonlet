import { describe, expect, it } from "vitest";
import { dropTarget, nameProblem, offersFileActions, renameSelection, terminalFolder } from "./fileActions";

describe("nameProblem (X98)", () => {
  it("accepts a plain name, a dotfile and a name with spaces", () => {
    expect(nameProblem("util.ts")).toBeNull();
    expect(nameProblem(".env.local")).toBeNull();
    expect(nameProblem("Release notes.md")).toBeNull();
  });

  it("refuses an empty name, . and .., and a slash, with a reason", () => {
    expect(nameProblem("")).toBe("A name is needed");
    expect(nameProblem("   ")).toBe("A name is needed");
    expect(nameProblem(".")).toBe("“.” can't be a name");
    expect(nameProblem("..")).toBe("“..” can't be a name");
    expect(nameProblem("src/util.ts")).toBe("A name can't have a “/”");
  });
});

describe("renameSelection (X98)", () => {
  it("selects a file's name up to its last extension", () => {
    expect(renameSelection("util.ts", false)).toEqual([0, 4]);
    expect(renameSelection("archive.tar.gz", false)).toEqual([0, 11]);
  });

  it("selects a dotfile, a name without an extension and a folder whole", () => {
    expect(renameSelection(".env", false)).toEqual([0, 4]);
    expect(renameSelection("Makefile", false)).toEqual([0, 8]);
    expect(renameSelection("v1.2", true)).toEqual([0, 4]);
  });
});

describe("dropTarget (X98)", () => {
  const root = "/w/shop";
  it("moves a dragged entry into the folder it is dropped on", () => {
    expect(dropTarget("/w/shop/src/util.ts", "/w/shop/lib")).toBe("/w/shop/lib/util.ts");
    expect(dropTarget("/w/shop/src/util.ts", root)).toBe("/w/shop/util.ts");
    expect(dropTarget("/w/shop/src", "/w/shop/lib")).toBe("/w/shop/lib/src");
  });

  it("refuses a drop on the entry itself, on its own folder and inside a dragged folder", () => {
    expect(dropTarget("/w/shop/src", "/w/shop/src")).toBeNull();
    expect(dropTarget("/w/shop/src/util.ts", "/w/shop/src")).toBeNull();
    expect(dropTarget("/w/shop/src", "/w/shop/src/lib")).toBeNull();
    // A sibling whose name starts the same is not inside.
    expect(dropTarget("/w/shop/src", "/w/shop/src2")).toBe("/w/shop/src2/src");
  });
});

describe("terminalFolder (X98)", () => {
  it("opens a terminal in a folder, or in a file's folder", () => {
    expect(terminalFolder({ path: "/w/shop/src", is_dir: true })).toBe("/w/shop/src");
    expect(terminalFolder({ path: "/w/shop/src/util.ts", is_dir: false })).toBe("/w/shop/src");
  });
});

describe("offersFileActions (X98)", () => {
  it("offers the actions on this Mac and on a remote host, not in another member's session", () => {
    expect(offersFileActions("local")).toBe(true);
    expect(offersFileActions("studio-mini")).toBe(true);
    expect(offersFileActions("studio-mini#copy:5e7f9a1b3c5d")).toBe(false);
  });
});
