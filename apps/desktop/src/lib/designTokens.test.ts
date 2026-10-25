import { describe, expect, it } from "vitest";
import { fieldShown, offSystem, offSystemMids, popoverTokens, tokenOf } from "./designTokens";
import { inlineStyles } from "./designEdits";
import type { DesignToken } from "./protocol";

/** A design system's tokens as design.kit gives them, from tokens/*.css. */
const TOKENS: DesignToken[] = [
  { name: "--space-1", value: "4px", family: "spacing" },
  { name: "--space-4", value: "16px", family: "spacing" },
  { name: "--space-5", value: "20px", family: "spacing" },
  { name: "--space-6", value: "24px", family: "spacing" },
  { name: "--space-8", value: "32px", family: "spacing" },
  { name: "--color-panel", value: "#161616", family: "color" },
  { name: "--color-line", value: "#2A2A2A", family: "color" },
  { name: "--color-border", value: "var(--color-line)", family: "color" },
  { name: "--radius-xl", value: "12px", family: "radius" },
  { name: "--shadow-card", value: "0 1px 3px rgb(0 0 0 / 0.3)", family: "shadow" },
  { name: "--text-lg", value: "15px", family: "typography" },
];

describe("a value's token (X65)", () => {
  it("is the token it names, or the first of the field's family whose value it is, colours in any notation", () => {
    expect(tokenOf(TOKENS, "var(--space-4)", "spacing")?.name).toBe("--space-4");
    expect(tokenOf(TOKENS, "16px", "spacing")?.name).toBe("--space-4");
    expect(tokenOf(TOKENS, "rgb(22, 22, 22)", "color")?.name).toBe("--color-panel");
    expect(tokenOf(TOKENS, "rgb(42 42 42)", "color")?.name).toBe("--color-line");
    expect(tokenOf(TOKENS, "#2a2a2a", "color")?.name).toBe("--color-line");
    expect(tokenOf(TOKENS, "12px", "spacing")).toBeNull();
    expect(tokenOf(TOKENS, "var(--nowhere)", "spacing")).toBeNull();
  });

  it("shows on a field as its token and value, a token per part, else the value alone", () => {
    expect(fieldShown(TOKENS, "var(--space-1)", "spacing")).toEqual({ token: "--space-1", value: "4px" });
    expect(fieldShown(TOKENS, "4px", "spacing")).toEqual({ token: "--space-1", value: "4px" });
    expect(fieldShown(TOKENS, "20px var(--space-6)", "spacing")).toEqual({ token: "--space-5 --space-6", value: "20px 24px" });
    expect(fieldShown(TOKENS, "14px 24px", "spacing")).toEqual({ token: null, value: "14px 24px" });
    expect(fieldShown(TOKENS, "rgb(22, 22, 22)", "color")).toEqual({ token: "--color-panel", value: "#161616" });
    expect(fieldShown(TOKENS, "var(--color-border)", "color")).toEqual({ token: "--color-border", value: "#2A2A2A" });
    expect(fieldShown(TOKENS, "auto", "spacing")).toEqual({ token: null, value: "auto" });
  });
});

describe("a token in rem (X65)", () => {
  const REM: DesignToken[] = [
    { name: "--space-2", value: "0.5rem", family: "spacing" },
    { name: "--space-4", value: "1rem", family: "spacing" },
    { name: "--space-8", value: "2rem", family: "spacing" },
  ];

  it("matches the px the page computes, at the root's 16 px, and is ranked by it", () => {
    expect(tokenOf(REM, "16px", "spacing")?.name).toBe("--space-4");
    expect(tokenOf(REM, "1rem", "spacing")?.name).toBe("--space-4");
    expect(fieldShown(REM, "8px 32px", "spacing")).toEqual({ token: "--space-2 --space-8", value: "0.5rem 2rem" });
    expect(popoverTokens(REM, "10px", "spacing").map((t) => t.name)).toEqual(["--space-2", "--space-4", "--space-8"]);
    expect(offSystem(REM, [["padding", "8px 1rem"]])).toEqual([]);
  });
});

describe("the token popover (X65)", () => {
  it("lists the field's family, the tokens its value matches first, then the nearest to it", () => {
    expect(popoverTokens(TOKENS, "14px 24px", "spacing").map((t) => t.name)).toEqual(["--space-6", "--space-4", "--space-5", "--space-1", "--space-8"]);
    expect(popoverTokens(TOKENS, "var(--color-line)", "color").map((t) => t.name)).toEqual(["--color-line", "--color-border", "--color-panel"]);
    expect(popoverTokens(TOKENS, "", "radius").map((t) => t.name)).toEqual(["--radius-xl"]);
  });
});

describe("an off-system element (X65)", () => {
  it("has an inline style value that matches no token, where its property takes tokens; keywords, sizes and places never are", () => {
    const style: [string, string][] = [
      ["padding", "14px 24px"],
      ["margin", "0 auto"],
      ["gap", "var(--space-1)"],
      ["background-color", "#161616"],
      ["border", "1px solid var(--color-border)"],
      ["border-radius", "10px"],
      ["width", "320px"],
      ["left", "37px"],
      ["box-shadow", "none"],
      ["color", "rgb(22 22 22)"],
      ["font-size", "var(--text-lg)"],
      ["opacity", "0.5"],
    ];
    expect(offSystem(TOKENS, style)).toEqual(["padding", "border-radius"]);
    expect(offSystem(TOKENS, [["border", "1px solid #ff0000"], ["box-shadow", "0 2px 4px black"]])).toEqual(["border", "box-shadow"]);
    expect(offSystem(TOKENS, [["padding", "16px 4px"]])).toEqual([]);
  });
});

describe("a page's off-system elements (X65)", () => {
  it("are those whose inline style, as the page's source writes it, has a value that matches no token", () => {
    const page = [
      "<!doctype html>",
      '<body data-mid="m1" style="margin: 0">',
      '<section data-mid="m24" style="padding: 14px 24px; gap: var(--space-1)">',
      "  <h2 data-mid='m25' style='color: #161616'>Git</h2>",
      '  <p data-mid="m30" style="width: 320px; border-radius: 10px">Branch prefix</p>',
      '  <p data-mid="m33" class="hint">Hint</p>',
      "</section>",
      "</body>",
    ].join("\n");
    expect(inlineStyles(page)).toEqual({
      m1: [["margin", "0"]],
      m24: [
        ["padding", "14px 24px"],
        ["gap", "var(--space-1)"],
      ],
      m25: [["color", "#161616"]],
      m30: [
        ["width", "320px"],
        ["border-radius", "10px"],
      ],
    });
    expect([...offSystemMids(TOKENS, inlineStyles(page))]).toEqual(["m24", "m30"]);
  });
});
