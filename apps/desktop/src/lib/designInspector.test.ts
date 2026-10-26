import { describe, expect, it } from "vitest";
import { displayOf, fieldEntries, fieldInput, fieldOff, fieldSet, fieldShows, fieldValue, inspectorSections, pickToken, selectionOf } from "./designInspector";

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

describe("a size field (X65)", () => {
  it("takes no token, as a design system has no size family: no popover tokens and no token shown", () => {
    const tokens = [{ name: "--space-8", value: "32px", family: "spacing" as const }];
    const [width, height] = inspectorSections("block")[2].fields;
    const [padding] = inspectorSections("block")[1].fields;
    expect(fieldEntries(width, tokens, "32px")).toEqual([]);
    expect(fieldEntries(height, tokens, "")).toEqual([]);
    expect(fieldShows(width, tokens, "32px")).toEqual({ token: null, value: "32px" });
    expect(fieldEntries(padding, tokens, "32px")).toEqual([{ names: ["--space-8"], value: "32px" }]);
  });
});

describe("the Fill field (X65)", () => {
  const fill = inspectorSections("block")[3].fields[0];

  it("writes background-color, and takes away a background shorthand that holds only a colour, so it never overrides the write or comes back", () => {
    expect(fieldSet(fill, [], "var(--color-panel)")).toEqual({ "background-color": "var(--color-panel)" });
    expect(fieldSet(fill, [["background", "#161616"]], "var(--color-panel)")).toEqual({ background: null, "background-color": "var(--color-panel)" });
    expect(fieldSet(fill, [["background", "#161616"]], null)).toEqual({ background: null, "background-color": null });
  });

  it("writes its colour into a background shorthand with an image, keeping the image and the rest as written", () => {
    const style: [string, string][] = [["background", 'url("grain.png") no-repeat #161616']];
    expect(fieldValue(fill, style, {})).toEqual({ value: "#161616", inline: true });
    expect(fieldSet(fill, style, "var(--color-panel)")).toEqual({ background: 'url("grain.png") no-repeat var(--color-panel)', "background-color": null });
    expect(fieldSet(fill, style, null)).toEqual({ background: 'url("grain.png") no-repeat', "background-color": null });
    expect(fieldSet(fill, [["background", 'url("grain.png")']], "#fff")).toEqual({ background: 'url("grain.png") #fff', "background-color": null });
  });

  it("writes any other field's property alone", () => {
    const [padding] = inspectorSections("block")[1].fields;
    expect(fieldSet(padding, [["background", "#161616"]], "4px")).toEqual({ padding: "4px" });
  });
});

describe("the Inspector's selection (X65)", () => {
  it("is the selected element's tag from the tree, its inline style from the source, and its properties off-system", () => {
    const layers = [{ mid: "m1", tag: "body", depth: 0, text: "" }, { mid: "m24", tag: "section", depth: 1, text: "Git" }];
    const tokens = [{ name: "--space-4", value: "16px", family: "spacing" as const }];
    const styles = { m24: [["padding", "14px"], ["gap", "16px"], ["background", "#ff0000"]] as [string, string][] };
    expect(selectionOf(layers, styles, tokens, "m24")).toEqual({ tag: "section", inline: styles.m24, off: ["padding", "background"] });
    expect(selectionOf(layers, styles, tokens, "m1")).toEqual({ tag: "body", inline: [], off: [] });
    expect(selectionOf(layers, styles, tokens, null)).toEqual({ tag: null, inline: [], off: [] });
  });

  it("is laid out by its display, inline else computed, else block", () => {
    expect(displayOf([["display", "grid"]], { display: "flex" })).toBe("grid");
    expect(displayOf([], { display: "flex" })).toBe("flex");
    expect(displayOf([], {})).toBe("block");
  });

  it("marks a field off-system when its property is, or one it may be set with", () => {
    const [fill, border] = inspectorSections("block")[3].fields;
    expect(fieldOff(fill, ["background"])).toBe(true);
    expect(fieldOff(fill, ["background-color"])).toBe(true);
    expect(fieldOff(border, ["background"])).toBe(false);
  });
});
