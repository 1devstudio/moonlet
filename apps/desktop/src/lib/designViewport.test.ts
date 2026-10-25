import { describe, expect, it } from "vitest";
import { VIEWPORTS, canvasKey, canvasScale, canvasZoom, parseViewport, viewportLabel, viewportText } from "./designViewport";

describe("the canvas's viewport (X65)", () => {
  it("is Desktop, Laptop, Tablet or Phone, at their sizes", () => {
    expect(VIEWPORTS.map((v) => `${v.name} ${v.size[0]}×${v.size[1]}`)).toEqual(["Desktop 1440×900", "Laptop 1280×800", "Tablet 834×1112", "Phone 390×844"]);
  });

  it("is saved and read as WxH, and anything else reads as none", () => {
    expect(parseViewport("390x844")).toEqual([390, 844]);
    expect(viewportText([1024, 768])).toBe("1024x768");
    for (const bad of ["phone", "0x844", "390x", "390x844x2", "-1x5", "1e3x800", ""]) expect(parseViewport(bad)).toBeNull();
  });

  it("is named by its preset, or Custom", () => {
    expect(viewportLabel([390, 844])).toEqual({ name: "Phone", size: "390×844" });
    expect(viewportLabel([1024, 768])).toEqual({ name: "Custom", size: "1024×768" });
  });
});

describe("the canvas's zoom (X65)", () => {
  it("fits the viewport into the canvas until zoomed, at most at 200%", () => {
    expect(canvasScale(null, [1440, 900], [720, 900])).toBe(0.5);
    expect(canvasScale(null, [390, 844], [1200, 1688])).toBe(2);
    expect(canvasScale(1.5, [1440, 900], [720, 900])).toBe(1.5);
    // Nothing to fit into yet.
    expect(canvasScale(null, [1440, 900], [0, 0])).toBe(0);
  });

  it("steps from 25% to 200% with − and +", () => {
    expect(canvasZoom(1, 1)).toBe(1.5);
    expect(canvasZoom(1.5, 1)).toBe(2);
    expect(canvasZoom(2, 1)).toBe(2);
    expect(canvasZoom(0.34, 1)).toBe(0.5);
    expect(canvasZoom(0.34, -1)).toBe(0.25);
    expect(canvasZoom(0.25, -1)).toBe(0.25);
  });

  it("takes ⌘0 to fit, ⌘= and ⌘- to zoom, and ⌘\\ to fold the chat", () => {
    expect(["cmd+0", "cmd+=", "shift+cmd+=", "cmd++", "cmd+-", "cmd+\\", "cmd+k"].map(canvasKey)).toEqual(["fit", "in", "in", "in", "out", "chat", null]);
  });
});
