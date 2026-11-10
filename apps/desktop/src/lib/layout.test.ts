import { describe, expect, it } from "vitest";
import { addTab, allSessions, closeDiff, closeFile, closeJob, cycleFocus, emptyLayout, leaves, openDiff, openFile, openJob, parseLayout, reconcile, removeSession, splitLeaf } from "./layout";

describe("layout", () => {
  it("opens a tab per unseen session and drops dead ones", () => {
    let l = reconcile(emptyLayout(), [1, 2]);
    expect(l.tabs).toHaveLength(2);
    expect(l.focused).toBe(1);
    l = reconcile(l, [2, 3]);
    expect(allSessions(l)).toEqual([2, 3]);
    expect(l.focused).toBe(2);
  });

  it("splits and collapses panes", () => {
    let l = addTab(emptyLayout(), 1);
    const tab = l.tabs[0];
    tab.root = splitLeaf(tab.root, 1, 2, "row");
    tab.root = splitLeaf(tab.root, 2, 3, "row");
    expect(leaves(tab.root)).toEqual([1, 2, 3]);
    expect(tab.root.type === "split" && tab.root.children).toHaveLength(3);
    tab.root = splitLeaf(tab.root, 3, 4, "col");
    expect(leaves(tab.root)).toEqual([1, 2, 3, 4]);
    l = { ...l, focused: 3 };
    l = removeSession(l, 3);
    expect(leaves(l.tabs[0].root)).toEqual([1, 2, 4]);
    expect(l.focused).toBe(1);
    l = removeSession(removeSession(l, 2), 4);
    expect(l.tabs[0].root).toEqual({ type: "leaf", session: 1 });
    l = removeSession(l, 1);
    expect(l.tabs).toHaveLength(0);
    expect(l.active).toBeNull();
  });

  it("keeps the active tab when a background session appears", () => {
    let l = reconcile(emptyLayout(), [1]);
    const active = l.active;
    l = reconcile(l, [1, 5]);
    expect(l.active).toBe(active);
    expect(l.tabs).toHaveLength(2);
  });

  it("rejects malformed stored layouts", () => {
    expect(parseLayout(null).tabs).toEqual([]);
    expect(parseLayout({ tabs: [{ id: "a", root: { type: "leaf" } }] }).tabs).toEqual([]);
    const ok = parseLayout({ tabs: [{ id: "a", root: { type: "leaf", session: 3 } }], active: "a" });
    expect(ok.tabs).toHaveLength(1);
  });

  it("cycles focus", () => {
    let l = addTab(emptyLayout(), 1);
    l.tabs[0].root = splitLeaf(l.tabs[0].root, 1, 2, "row");
    expect(cycleFocus(l, 1)).toBe(2);
    expect(cycleFocus({ ...l, focused: 2 }, 1)).toBe(1);
  });
});

describe("file tabs (X26)", () => {
  const file = "/Users/me/.moonlet/worktrees/moonlet/s1/package.json";

  it("opens a file as a new active tab after the others", () => {
    const l = openFile(reconcile(emptyLayout(), [1]), file);
    expect(l.tabs).toHaveLength(2);
    expect(l.tabs[1].root).toEqual({ type: "file", path: file });
    expect(l.active).toBe(l.tabs[1].id);
    expect(l.focused).toBeNull();
  });

  it("switches to a file's tab when the file is already open", () => {
    const opened = openFile(reconcile(emptyLayout(), [1]), file);
    const back = { ...opened, active: opened.tabs[0].id, focused: 1 };
    const again = openFile(back, file);
    expect(again.tabs).toHaveLength(2);
    expect(again.active).toBe(opened.tabs[1].id);
  });

  it("opens an open file at a new line", () => {
    const l = openFile(openFile(emptyLayout(), file), file, 42);
    expect(l.tabs).toHaveLength(1);
    expect(l.tabs[0].root).toEqual({ type: "file", path: file, line: 42 });
  });

  it("opens a file at a range of lines, and an open one at a new range (X96)", () => {
    const l = openFile(emptyLayout(), file, 49, 53);
    expect(l.tabs[0].root).toEqual({ type: "file", path: file, line: 49, endLine: 53 });
    const again = openFile(l, file, 12);
    expect(again.tabs).toHaveLength(1);
    expect(again.tabs[0].root).toEqual({ type: "file", path: file, line: 12 });
  });

  it("reads a file tab's range back from a stored layout (X96)", () => {
    const stored = { tabs: [{ id: "a", root: { type: "file", path: file, line: 49, endLine: 53 } }], active: "a", focused: null };
    expect(parseLayout(stored).tabs).toEqual([{ id: "a", root: { type: "file", path: file, line: 49, endLine: 53 } }]);
  });

  it("keeps file tabs when the terminals are synced", () => {
    const l = reconcile(openFile(reconcile(emptyLayout(), [1]), file), [1, 2]);
    expect(l.tabs.map((t) => t.root)).toEqual([
      { type: "leaf", session: 1 },
      { type: "file", path: file },
      { type: "leaf", session: 2 },
    ]);
    expect(allSessions(l)).toEqual([1, 2]);
  });

  it("reads file tabs back from a stored layout", () => {
    const stored = { tabs: [{ id: "a", root: { type: "file", path: file } }, { id: "b", root: { type: "file" } }], active: "a", focused: null };
    expect(parseLayout(stored).tabs).toEqual([{ id: "a", root: { type: "file", path: file } }]);
  });

  it("closes a file tab and activates its neighbour", () => {
    const opened = openFile(reconcile(emptyLayout(), [1]), file);
    const l = closeFile(opened, file);
    expect(l.tabs.map((t) => t.root)).toEqual([{ type: "leaf", session: 1 }]);
    expect(l.active).toBe(l.tabs[0].id);
    expect(l.focused).toBe(1);
  });
});

describe("job tabs (X62)", () => {
  it("opens a job as a new active tab, and switches to it when open", () => {
    const l = openJob(reconcile(emptyLayout(), [1]), "j7");
    expect(l.tabs.map((t) => t.root)).toEqual([
      { type: "leaf", session: 1 },
      { type: "job", job: "j7" },
    ]);
    expect(l.active).toBe(l.tabs[1].id);
    expect(l.focused).toBeNull();
    const again = openJob({ ...l, active: l.tabs[0].id, focused: 1 }, "j7");
    expect(again.tabs).toHaveLength(2);
    expect(again.active).toBe(l.tabs[1].id);
  });

  it("keeps job tabs when the terminals are synced, and reads them back", () => {
    const l = reconcile(openJob(reconcile(emptyLayout(), [1]), "j7"), [1, 2]);
    expect(allSessions(l)).toEqual([1, 2]);
    const stored = { tabs: [{ id: "a", root: { type: "job", job: "j7" } }, { id: "b", root: { type: "job" } }], active: "a", focused: null };
    expect(parseLayout(stored).tabs).toEqual([{ id: "a", root: { type: "job", job: "j7" } }]);
  });

  it("closes a job tab and activates its neighbour", () => {
    const l = closeJob(openJob(reconcile(emptyLayout(), [1]), "j7"), "j7");
    expect(l.tabs.map((t) => t.root)).toEqual([{ type: "leaf", session: 1 }]);
    expect(l.focused).toBe(1);
  });
});

describe("diff tabs (X77)", () => {
  const path = "src/app.ts";

  it("opens a changed file's diff as a new active tab after the others", () => {
    const l = openDiff(reconcile(emptyLayout(), [1]), path, "base");
    expect(l.tabs.map((t) => t.root)).toEqual([
      { type: "leaf", session: 1 },
      { type: "diff", path, mode: "base" },
    ]);
    expect(l.active).toBe(l.tabs[1].id);
    expect(l.focused).toBeNull();
  });

  it("switches to the diff's tab when that file and mode are already open", () => {
    const opened = openDiff(reconcile(emptyLayout(), [1]), path, "base");
    const back = { ...opened, active: opened.tabs[0].id, focused: 1 };
    const again = openDiff(back, path, "base");
    expect(again.tabs).toHaveLength(2);
    expect(again.active).toBe(opened.tabs[1].id);
  });

  it("keeps one tab per file and mode", () => {
    const l = openDiff(openDiff(emptyLayout(), path, "base"), path, "head");
    expect(l.tabs.map((t) => t.root)).toEqual([
      { type: "diff", path, mode: "base" },
      { type: "diff", path, mode: "head" },
    ]);
  });

  it("keeps a file's editor tab and its diff tab apart", () => {
    const l = openDiff(openFile(emptyLayout(), path), path, "base");
    expect(l.tabs).toHaveLength(2);
  });

  it("keeps diff tabs when the terminals are synced", () => {
    const l = reconcile(openDiff(reconcile(emptyLayout(), [1]), path, "head"), [1, 2]);
    expect(l.tabs.map((t) => t.root)).toEqual([
      { type: "leaf", session: 1 },
      { type: "diff", path, mode: "head" },
      { type: "leaf", session: 2 },
    ]);
    expect(allSessions(l)).toEqual([1, 2]);
  });

  it("reads diff tabs back from a stored layout and drops ones without a mode", () => {
    const stored = {
      tabs: [
        { id: "a", root: { type: "diff", path, mode: "head" } },
        { id: "b", root: { type: "diff", path, mode: "sideways" } },
        { id: "c", root: { type: "diff", mode: "base" } },
      ],
      active: "a",
      focused: null,
    };
    expect(parseLayout(stored).tabs).toEqual([{ id: "a", root: { type: "diff", path, mode: "head" } }]);
  });

  it("closes a diff tab and activates its neighbour", () => {
    const opened = openDiff(reconcile(emptyLayout(), [1]), path, "base");
    const l = closeDiff(opened, path, "base");
    expect(l.tabs.map((t) => t.root)).toEqual([{ type: "leaf", session: 1 }]);
    expect(l.active).toBe(l.tabs[0].id);
    expect(l.focused).toBe(1);
  });
});
