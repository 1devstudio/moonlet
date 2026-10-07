import { describe, expect, it } from "vitest";
import { afterRead, afterSave } from "./fileSync";

describe("an editor tab re-reading its file (X26)", () => {
  it("shows a change on disk when there are no unsaved edits", () => {
    expect(afterRead("a\n", "a\n", "b\n")).toEqual({ saved: "b\n", replace: true, dirty: false });
  });

  it("keeps unsaved edits when the file changes on disk", () => {
    expect(afterRead("mine\n", "a\n", "b\n")).toEqual({ saved: "a\n", replace: false, dirty: true });
  });

  it("is saved once the file on disk matches the editor", () => {
    expect(afterRead("b\n", "a\n", "b\n")).toEqual({ saved: "b\n", replace: false, dirty: false });
  });

  it("takes the file as saved before the editor exists", () => {
    expect(afterRead(null, "", "a\n")).toEqual({ saved: "a\n", replace: false, dirty: false });
  });
});

describe("an editor tab saving (X26)", () => {
  it("is saved when nothing was typed during the write", () => {
    expect(afterSave("a\n", "a\n")).toEqual({ saved: "a\n", dirty: false });
  });

  it("stays unsaved when typing went on during the write", () => {
    expect(afterSave("a\n", "a\nmore")).toEqual({ saved: "a\n", dirty: true });
  });
});
