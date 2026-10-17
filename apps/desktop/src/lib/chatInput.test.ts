import { describe, expect, it } from "vitest";
import { inputLayout } from "./chatInput";

// The design's boards: Wide 760, Medium 560, Narrow 420, Compact 320 (X51).
describe("chat input layout (X51)", () => {
  it("picks the tier from the chat column's width", () => {
    expect(inputLayout(760).tier).toBe("wide");
    expect(inputLayout(640).tier).toBe("wide");
    expect(inputLayout(639).tier).toBe("medium");
    expect(inputLayout(500).tier).toBe("medium");
    expect(inputLayout(499).tier).toBe("narrow");
    expect(inputLayout(380).tier).toBe("narrow");
    expect(inputLayout(379).tier).toBe("compact");
    expect(inputLayout(260).tier).toBe("compact");
  });

  it("shows everything when wide: the full spend, effort, esc to stop and ⌥↵", () => {
    expect(inputLayout(760)).toEqual({ tier: "wide", padX: 24, insetX: 16, escHint: true, asideHint: true, percent: true, cost: "full", effort: true, modeLabel: true, longPlaceholder: true });
  });

  it("keeps only the dollars of the spend at medium", () => {
    expect(inputLayout(560)).toEqual({ tier: "medium", padX: 24, insetX: 16, escHint: true, asideHint: true, percent: true, cost: "short", effort: true, modeLabel: true, longPlaceholder: true });
  });

  it("drops the spend, effort and hints when narrow", () => {
    expect(inputLayout(420)).toEqual({ tier: "narrow", padX: 16, insetX: 16, escHint: false, asideHint: false, percent: true, cost: null, effort: false, modeLabel: true, longPlaceholder: false });
  });

  it("keeps the ring and the mode's icon alone when compact", () => {
    expect(inputLayout(320)).toEqual({ tier: "compact", padX: 12, insetX: 12, escHint: false, asideHint: false, percent: false, cost: null, effort: false, modeLabel: false, longPlaceholder: false });
  });
});
