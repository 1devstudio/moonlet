import { describe, expect, it } from "vitest";
import { firstActive, menuKey, moveActive, sameItem } from "./menuNav";

// A menu as the board switcher shows it: a workspace label, two boards, a
// divider, then New board and Manage.
const items = [{ kind: "label", label: "Acme · this workspace" }, { label: "OPS" }, { label: "WEB", checked: true }, { kind: "divider" }, { label: "New board" }, { label: "Manage" }] as const;

describe("moveActive (X50 board switcher: ↑ and ↓)", () => {
  it("steps over labels and dividers, and wraps at either end", () => {
    expect(moveActive(items, 1, 1)).toBe(2);
    expect(moveActive(items, 2, 1)).toBe(4);
    expect(moveActive(items, 5, 1)).toBe(1);
    expect(moveActive(items, 1, -1)).toBe(5);
    // Nothing active yet: ↓ takes the first item, ↑ the last.
    expect(moveActive(items, null, 1)).toBe(1);
    expect(moveActive(items, null, -1)).toBe(5);
    expect(moveActive([{ kind: "label", label: "x" }, { kind: "divider" }], null, 1)).toBe(null);
  });
});

describe("firstActive (X50 board switcher)", () => {
  it("starts on the checked item when the menu opens, and on the first match once the search changes", () => {
    expect(firstActive(items, "open")).toBe(2);
    expect(firstActive(items, "search")).toBe(1);
    expect(firstActive([{ label: "OPS" }], "open")).toBe(0);
    expect(firstActive([{ kind: "label", label: "x" }], "open")).toBe(null);
  });
});

describe("sameItem (a menu whose items change while open)", () => {
  it("follows the active item to where it is now, else starts over", () => {
    const fewer = [{ kind: "label", label: "Acme · this workspace" }, { label: "WEB", checked: true }, { kind: "divider" }, { label: "New board" }] as const;
    expect(sameItem(fewer, 4, "New board")).toBe(3);
    expect(sameItem(fewer, 1, "WEB")).toBe(1);
    expect(sameItem(fewer, 1, "OPS")).toBe(1);
    expect(sameItem(items, null, null)).toBe(null);
  });
});

describe("menuKey (X50 board switcher: ↑ ↓ ↵)", () => {
  const key = (k: string, isComposing = false) => ({ key: k, isComposing });

  it("moves with ↑ and ↓ and picks with ↵, leaving text being composed alone", () => {
    expect(menuKey(key("ArrowDown"), items, 2)).toEqual({ move: 4 });
    expect(menuKey(key("ArrowUp"), items, 2)).toEqual({ move: 1 });
    expect(menuKey(key("Enter"), items, 4)).toEqual({ pick: 4 });
    // ↵ with nothing active, or on a label, picks nothing.
    expect(menuKey(key("Enter"), items, null)).toBe(null);
    expect(menuKey(key("Enter"), items, 0)).toBe(null);
    // An input method's ↵ and ↓ confirm or pick its own candidates.
    expect(menuKey(key("Enter", true), items, 4)).toBe(null);
    expect(menuKey(key("ArrowDown", true), items, 2)).toBe(null);
    expect(menuKey(key("a"), items, 2)).toBe(null);
  });
});
