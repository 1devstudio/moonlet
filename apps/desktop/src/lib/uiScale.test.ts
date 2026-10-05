import { describe, expect, it } from "vitest";
import { editorFont, uiScale } from "./uiScale";

describe("UI text scale", () => {
  it("follows the terminal font size, 1 at the default 13px", () => {
    expect(uiScale(13)).toBe(1);
    expect(uiScale(26)).toBe(2);
    expect(uiScale(19.5)).toBe(1.5);
  });

  it("falls back to 1 for a size that is not a positive number", () => {
    expect(uiScale(0)).toBe(1);
    expect(uiScale(-4)).toBe(1);
    expect(uiScale(Number.NaN)).toBe(1);
  });
});

describe("code editor font", () => {
  it("is 12.5px on 19px lines at the default 13px", () => {
    expect(editorFont(13)).toEqual({ fontSize: 12.5, lineHeight: 19 });
  });

  it("grows with the font size, on whole-pixel lines", () => {
    expect(editorFont(26)).toEqual({ fontSize: 25, lineHeight: 38 });
    expect(editorFont(19.5)).toEqual({ fontSize: 18.75, lineHeight: 29 });
  });

  it("stays at the default for a size that is not a positive number", () => {
    expect(editorFont(0)).toEqual({ fontSize: 12.5, lineHeight: 19 });
  });
});
