import { describe, expect, it } from "vitest";
import { firstActive, moveActive } from "./menuNav";

// A menu as the board switcher shows it: a workspace label, two boards, a
// divider, then New board and Manage.
const kinds = ["label", "item", "item", "divider", "item", "item"] as const;

describe("moveActive (X50 board switcher: ↑ and ↓)", () => {
  it("steps over labels and dividers, and wraps at either end", () => {
    expect(moveActive(kinds, 1, 1)).toBe(2);
    expect(moveActive(kinds, 2, 1)).toBe(4);
    expect(moveActive(kinds, 5, 1)).toBe(1);
    expect(moveActive(kinds, 1, -1)).toBe(5);
    // Nothing active yet: ↓ takes the first item, ↑ the last.
    expect(moveActive(kinds, null, 1)).toBe(1);
    expect(moveActive(kinds, null, -1)).toBe(5);
    expect(moveActive(["label", "divider"], null, 1)).toBe(null);
  });
});

describe("firstActive (X50 board switcher)", () => {
  it("starts on the checked item, else the first one", () => {
    expect(firstActive(kinds, [false, false, true, false, false, false])).toBe(2);
    expect(firstActive(kinds, [false, false, false, false, false, false])).toBe(1);
    expect(firstActive(["label"], [false])).toBe(null);
  });
});
