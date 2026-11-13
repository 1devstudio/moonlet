import { describe, expect, it } from "vitest";
import { fitViews } from "./viewOverflow";

// The right panel's views from the design "Right column — narrow widths":
// Task, Plan, Agents, Files, Changes (with its 131 badge, shown) and Review.
const widths = [48, 48, 64, 48, 96, 64];
const CHANGES = 4;
const MORE = 72;

describe("fitViews (X94)", () => {
  it("keeps every view in the row when they fit, with no More", () => {
    expect(fitViews(widths, CHANGES, 432, MORE)).toEqual({ shown: [0, 1, 2, 3, 4, 5], more: [] });
  });

  it("puts the last views into More, keeping the one shown in its place", () => {
    // The design's 360 px panel: Task, Plan, Agents, Changes; Files and Review in More.
    expect(fitViews(widths, CHANGES, 352, MORE)).toEqual({ shown: [0, 1, 2, 4], more: [3, 5] });
  });

  it("gives up more views before the one shown when narrower still", () => {
    // The design's 300 px panel: Task, Plan, Changes; Agents, Files and Review in More.
    expect(fitViews(widths, CHANGES, 292, MORE)).toEqual({ shown: [0, 1, 4], more: [2, 3, 5] });
  });

  it("puts nothing before the shown view when only it fits", () => {
    expect(fitViews(widths, CHANGES, 170, MORE)).toEqual({ shown: [4], more: [0, 1, 2, 3, 5] });
  });

  it("keeps the first views when the one shown is among them", () => {
    expect(fitViews(widths, 0, 292, MORE)).toEqual({ shown: [0, 1, 2, 3], more: [4, 5] });
  });

  it("counts the gaps between the views, and before More", () => {
    // 368 px of views fit 372 px, but not with five 2 px gaps between them.
    expect(fitViews(widths, CHANGES, 372, MORE)).toEqual({ shown: [0, 1, 2, 3, 4, 5], more: [] });
    expect(fitViews(widths, CHANGES, 372, MORE, 2)).toEqual({ shown: [0, 1, 2, 4], more: [3, 5] });
  });
});
