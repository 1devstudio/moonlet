import { describe, expect, it } from "vitest";
import { menuTop, submenuLeft } from "./menuPlace";

describe("menuTop (X112)", () => {
  it("opens a right-click menu at the pointer, moved up to fit the window, and never above its top margin", () => {
    expect(menuTop(200, 300, 900)).toBe(200);
    expect(menuTop(800, 300, 900)).toBe(592);
    expect(menuTop(100, 1000, 900)).toBe(8);
  });
});

describe("submenuLeft (X112)", () => {
  it("opens a submenu right of its item, or left of it when the window has no room on the right", () => {
    expect(submenuLeft(40, 280, 200, 1440)).toBe(284);
    expect(submenuLeft(1100, 1340, 200, 1440)).toBe(896);
    expect(submenuLeft(100, 1300, 200, 1440)).toBe(8);
  });
});
