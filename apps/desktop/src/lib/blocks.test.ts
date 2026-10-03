import { describe, expect, it } from "vitest";
import { blockChip } from "./terminals";

describe("block chips", () => {
  it("formats status and duration", () => {
    expect(blockChip({})).toBe("…");
    expect(blockChip({ end: {}, exit: 0, startedAt: 0, endedAt: 1200 })).toBe("✓ 1.2s");
    expect(blockChip({ end: {}, exit: 1, startedAt: 0, endedAt: 300 })).toBe("✗ 1 · 300ms");
    expect(blockChip({ end: {}, exit: 2 })).toBe("✗ 2");
    expect(blockChip({ end: {}, startedAt: 0, endedAt: 125_000 })).toBe("✓ 2m 5s");
  });
});
