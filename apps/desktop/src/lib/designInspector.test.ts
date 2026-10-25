import { describe, expect, it } from "vitest";
import { fieldInput, fieldValue, inspectorSections, pickToken } from "./designInspector";

const labels = (display: string) => inspectorSections(display).map((s) => `${s.title}: ${s.fields.map((f) => f.label).join(", ")}`);

describe("the Inspector (X65)", () => {
  it("has Layout, Spacing, Size, Fill and border and Effects, with direction for flex and columns for grid", () => {
    expect(labels("block")).toEqual(["Layout: Display", "Spacing: Padding, Margin", "Size: Width, Height", "Fill and border: Fill, Border, Radius", "Effects: Shadow, Opacity"]);
    expect(labels("inline-flex")[0]).toBe("Layout: Display, Direction, Gap, Alignment");
    expect(labels("grid")[0]).toBe("Layout: Display, Grid columns, Gap, Alignment");
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

  it("writes a token picked in the popover as var(--token), into a border's colour keeping its width and style", () => {
    const [, border] = inspectorSections("block")[3].fields;
    const [padding] = inspectorSections("block")[1].fields;
    expect(pickToken(padding, "14px 24px", "--space-4")).toBe("var(--space-4)");
    expect(pickToken(border, "2px dashed #ff0000", "--color-border")).toBe("2px dashed var(--color-border)");
    expect(pickToken(border, "", "--color-border")).toBe("1px solid var(--color-border)");
  });
});
