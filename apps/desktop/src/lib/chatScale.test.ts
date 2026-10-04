import { describe, expect, it } from "vitest";
import { chatScale } from "./terminals";

describe("chat text scale", () => {
  it("follows the terminal font size, 1 at the default 13px", () => {
    expect(chatScale(13)).toBe(1);
    expect(chatScale(26)).toBe(2);
    expect(chatScale(19.5)).toBe(1.5);
  });

  it("falls back to 1 for a size that is not a positive number", () => {
    expect(chatScale(0)).toBe(1);
    expect(chatScale(-4)).toBe(1);
    expect(chatScale(Number.NaN)).toBe(1);
  });
});
