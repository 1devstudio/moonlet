import { describe, expect, it } from "vitest";
import { deletePrompt, dirtyUnder, dropTarget, movedDirty, nameProblem, offersFileActions, renameSelection, terminalFolder } from "./fileActions";

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

describe("unsaved marks after a rename or a delete (X98)", () => {
  const dirty = { "local|/w/shop/src/a.ts": true, "local|/w/shop/src2/b.ts": true, "studio-mini|/w/shop/src/a.ts": true } as const;

  it("moves the unsaved marks of the files in a renamed folder, on its host only", () => {
    expect(movedDirty(dirty, "local", "/w/shop/src", "/w/shop/app")).toEqual({
      "local|/w/shop/app/a.ts": true,
      "local|/w/shop/src2/b.ts": true,
      "studio-mini|/w/shop/src/a.ts": true,
    });
  });

  it("names the unsaved files a delete would lose", () => {
    expect(dirtyUnder(dirty, "local", "/w/shop/src")).toEqual(["local|/w/shop/src/a.ts"]);
    expect(dirtyUnder(dirty, "local", "/w/shop/src2/b.ts")).toEqual(["local|/w/shop/src2/b.ts"]);
    expect(dirtyUnder(dirty, "local", "/w/shop/lib")).toEqual([]);
  });
});

describe("deletePrompt (X98)", () => {
  it("asks to move a file to the Trash where the host has one", () => {
    expect(deletePrompt({ name: "util.ts", dir: false, trash: true, unsaved: 0 })).toEqual({
      title: "Delete file",
      message: "Move util.ts to the Trash?",
      action: "Move to Trash",
      variant: "danger",
    });
  });

  it("warns that a delete can't be undone where the host has no Trash", () => {
    expect(deletePrompt({ name: "src", dir: true, trash: false, unsaved: 0 })).toEqual({
      title: "Delete folder",
      message: "Delete src? This can't be undone.",
      action: "Delete",
      variant: "danger",
    });
  });

  it("says unsaved edits in open tabs are lost", () => {
    expect(deletePrompt({ name: "src", dir: true, trash: true, unsaved: 2 }).message).toBe("Move src to the Trash? Unsaved edits in 2 open files are lost.");
    expect(deletePrompt({ name: "util.ts", dir: false, trash: false, unsaved: 1 }).message).toBe("Delete util.ts? This can't be undone. Unsaved edits in 1 open file are lost.");
  });
});
