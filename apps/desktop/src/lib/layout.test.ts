import { describe, expect, it } from "vitest";
import { addTab, allSessions, cycleFocus, emptyLayout, leaves, parseLayout, reconcile, removeSession, splitLeaf } from "./layout";

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
