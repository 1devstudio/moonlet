import { describe, expect, it } from "vitest";
import { fieldInput, fieldShows, fieldValue, inspectorSections, pickToken } from "./designInspector";

const labels = (display: string) => inspectorSections(display).map((s) => `${s.title}: ${s.fields.map((f) => f.label).join(", ")}`);

describe("the Inspector (X65)", () => {
  it("has Layout, Spacing, Size, Fill and border and Effects, with direction for flex and columns for grid, and alignment and justification for both", () => {
    expect(labels("block")).toEqual(["Layout: Display", "Spacing: Padding, Margin", "Size: Width, Height", "Fill and border: Fill, Border, Radius", "Effects: Shadow, Opacity"]);
    expect(labels("inline-flex")[0]).toBe("Layout: Display, Direction, Gap, Alignment, Justify");
    expect(labels("grid")[0]).toBe("Layout: Display, Grid columns, Gap, Alignment, Justify");
    expect(inspectorSections("flex")[0].fields.map((f) => f.prop)).toEqual(["display", "flex-direction", "gap", "align-items", "justify-content"]);
  });

  it("takes a size as px, %, auto or fill, a number alone as px", () => {
    const width = inspectorSections("block")[2].fields[0];
    expect(["320", "320px", " 12.5px ", "50%", "auto", "fill", "var(--space-8)", ""].map((t) => fieldInput(width, t))).toEqual([
      { set: "320px" },
      { set: "320px" },
      { set: "12.5px" },
      { set: "50%" },
      { set: "auto" },
      { set: "100%" },
      { set: "var(--space-8)" },
      { set: null },
    ]);
    expect(fieldInput(width, "wide")).toEqual({ error: "A size is px, %, auto or fill" });
    expect(fieldValue(width, [["width", "100%"]], {})).toEqual({ value: "fill", inline: true });
  });

  it("takes an opacity as a percentage or a fraction, and shows it as a percentage", () => {
    const opacity = inspectorSections("block")[4].fields[1];
    expect(["50%", "0.5", "100%", "1"].map((t) => fieldInput(opacity, t))).toEqual([{ set: "0.5" }, { set: "0.5" }, { set: "1" }, { set: "1" }]);
    expect(fieldInput(opacity, "150%")).toEqual({ error: "An opacity is 0% to 100%" });
    expect(fieldValue(opacity, [], { opacity: "0.35" })).toEqual({ value: "35%", inline: false });
  });

  it("shows a field's inline value, else what the page computes, and refuses a free value that could break out of the style", () => {
    const [padding] = inspectorSections("block")[1].fields;
    expect(fieldValue(padding, [["padding", "var(--space-4)"]], { padding: "16px" })).toEqual({ value: "var(--space-4)", inline: true });
    expect(fieldValue(padding, [], { padding: "14px 24px" })).toEqual({ value: "14px 24px", inline: false });
    expect(fieldValue(padding, [], {})).toEqual({ value: "", inline: false });
    expect(fieldInput(padding, '4px" onclick="x')).toEqual({ error: "Not a value the editor writes" });
    const fill = inspectorSections("block")[3].fields[0];
    expect(fieldValue(fill, [["background", "#161616"]], {})).toEqual({ value: "#161616", inline: true });
  });

  it("writes a token picked in the popover as var(--token), a token per part as their var()s, into a border's colour keeping its width and style", () => {
    const [, border] = inspectorSections("block")[3].fields;
    const [padding] = inspectorSections("block")[1].fields;
    expect(pickToken(padding, "14px 24px", ["--space-4"])).toBe("var(--space-4)");
    expect(pickToken(padding, "14px 24px", ["--space-4", "--space-6"])).toBe("var(--space-4) var(--space-6)");
    expect(pickToken(border, "2px dashed #ff0000", ["--color-border"])).toBe("2px dashed var(--color-border)");
    expect(pickToken(border, "", ["--color-border"])).toBe("1px solid var(--color-border)");
  });
});

describe("an Inspector field's token (X65)", () => {
  it("is shown in a border as its width and style with its colour's token, as the page computes it too", () => {
    const tokens = [
      { name: "--color-border", value: "#2a2a2a", family: "color" as const },
      { name: "--space-4", value: "16px", family: "spacing" as const },
    ];
    const [, border] = inspectorSections("block")[3].fields;
    const [padding] = inspectorSections("block")[1].fields;
    expect(fieldShows(border, tokens, "1px solid rgb(42, 42, 42)")).toEqual({ token: "1px solid --color-border", value: "#2a2a2a" });
    expect(fieldShows(border, tokens, "1px solid #ff0000")).toEqual({ token: null, value: "1px solid #ff0000" });
    expect(fieldShows(border, tokens, "none")).toEqual({ token: null, value: "none" });
    expect(fieldShows(padding, tokens, "16px")).toEqual({ token: "--space-4", value: "16px" });
  });
});
