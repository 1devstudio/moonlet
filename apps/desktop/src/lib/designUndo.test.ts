import { describe, expect, it } from "vitest";
import { NO_UNDO, dropPage, pendingAfter, pushStep, redoStep, undoStep, type Step } from "./designUndo";
import { editLines } from "./designEdits";

const step = (id: number, page: string, before: string, after: string): Step => ({
  id,
  page,
  before,
  after,
  edit: { page, mid: "m30", tag: "div", change: { kind: "deleted" } },
  selectBefore: "m30",
  selectAfter: "m31",
});

describe("undo and redo of the editor's changes (X65)", () => {
  it("undoes the latest change back to its page as it was, redoes it, and a new change clears what was undone", () => {
    let u = pushStep(pushStep(NO_UNDO, step(1, "index", "<p>a</p>", "<p>b</p>")), step(2, "git-a", "<p>x</p>", "<p>y</p>"));
    const back = undoStep(u)!;
    expect([back.step.page, back.step.before]).toEqual(["git-a", "<p>x</p>"]);
    u = back.undo;
    const again = undoStep(u)!;
    expect([again.step.page, again.step.before]).toEqual(["index", "<p>a</p>"]);
    expect(undoStep(again.undo)).toBeNull();
    const forth = redoStep(again.undo)!;
    expect([forth.step.page, forth.step.after]).toEqual(["index", "<p>b</p>"]);
    u = pushStep(forth.undo, step(3, "index", "<p>b</p>", "<p>c</p>"));
    expect(redoStep(u)).toBeNull();
    expect(undoStep(u)!.step.id).toBe(3);
  });

  it("forgets a page's changes once the page changed on disk under them, keeping the other pages'", () => {
    const u = pushStep(pushStep(pushStep(NO_UNDO, step(1, "index", "a", "b")), step(2, "git-a", "x", "y")), step(3, "index", "b", "c"));
    const back = undoStep(u)!.undo;
    expect(dropPage(back, "index")).toEqual({ done: [step(2, "git-a", "x", "y")], undone: [] });
  });
});

describe("edits by hand not told to the agent yet (X65)", () => {
  const del = step(1, "index", "a", "b");
  const wrap: Step = { ...step(2, "index", "b", "c"), edit: { page: "index", mid: "m25", tag: "h2", change: { kind: "wrapped", box: "m41" } } };

  it("are the changes made since the last message; one undone before it was told goes untold, one told goes as undone", () => {
    let pending = pendingAfter([], del, "do");
    pending = pendingAfter(pending, wrap, "do");
    expect(editLines(pending)).toEqual(["index.html m30 div: deleted", "index.html m25 h2: wrapped in div m41"]);
    pending = pendingAfter(pending, wrap, "undo");
    expect(editLines(pending)).toEqual(["index.html m30 div: deleted"]);
    pending = pendingAfter(pending, wrap, "redo");
    expect(editLines(pending)).toEqual(["index.html m30 div: deleted", "index.html m25 h2: wrapped in div m41"]);
    // Told with the next message: undoing one now is news to the agent.
    pending = pendingAfter([], del, "undo");
    expect(editLines(pending)).toEqual(["index.html m30 div: undid deleted"]);
    expect(pendingAfter(pending, del, "redo")).toEqual([]);
  });
});

