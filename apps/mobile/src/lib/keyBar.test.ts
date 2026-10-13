import { describe, expect, it } from "vitest";
import { KEYS, ctrlBytes, keyBytes } from "./keyBar";

describe("the key bar", () => {
  it("offers the design's keys in order", () => {
    expect(KEYS.map((k) => k.label)).toEqual(["esc", "tab", "ctrl", "↑", "↓", "←", "→", "|", "~"]);
  });

  it("sends what a keyboard sends", () => {
    expect(["esc", "tab", "up", "down", "left", "right", "pipe", "tilde"].map((k) => keyBytes(k))).toEqual([
      "\x1b",
      "\t",
      "\x1b[A",
      "\x1b[B",
      "\x1b[D",
      "\x1b[C",
      "|",
      "~",
    ]);
  });

  it("turns the next letter into its control character", () => {
    expect(ctrlBytes("c")).toBe("\x03");
    expect(ctrlBytes("C")).toBe("\x03");
    expect(ctrlBytes("d")).toBe("\x04");
    expect(ctrlBytes("[")).toBe("\x1b");
    expect(ctrlBytes("1")).toBeNull();
  });
});
