import { describe, expect, it } from "vitest";
import { type CellMeasure, type Measurements, readMeasurements, rubric } from "./renderRubric";

const cell = (snippet: string, over: Partial<CellMeasure> = {}): CellMeasure => ({
  snippet,
  html: `<button class="btn btn--${snippet.split("/").pop()}">Create PR</button>`,
  text: "Create PR",
  empty: false,
  textHeight: 17,
  painted: 1,
  overflow680: 0,
  escaped: 0,
  ...over,
});

const card = (cells: CellMeasure[], over: Partial<Measurements> = {}): Measurements => ({
  name: "Button",
  fallback: false,
  errors: [],
  cells,
  fixedOutside: 0,
  ...over,
});

describe("the render rubric (X64)", () => {
  it("passes a card whose cells are styled, have text and differ", () => {
    expect(rubric(card([cell("buttons/button/primary"), cell("buttons/button/ghost")]))).toEqual([]);
  });

  it("is bad when a mount is empty", () => {
    const empty = cell("forms/field/default", { html: "", text: "", empty: true, textHeight: 0, painted: 0 });
    expect(rubric(card([cell("forms/field/filled"), empty], { name: "Field" }))).toEqual(["rootEmpty", "bad"]);
  });

  it("is bad with page errors, but a floor card's errors are not bad", () => {
    const errors = ["link did not load: ../../../styles.css"];
    expect(rubric(card([cell("buttons/button/primary")], { errors }))).toEqual(["errs", "bad"]);
    const floor = cell("buttons/button/default", { html: "<p>Button: preview not yet written</p>", text: "Button: preview not yet written", painted: 0 });
    expect(rubric(card([floor], { errors, fallback: true }))).toEqual(["errs"]);
  });

  it("is thin when the only text is the card's name, nothing shows, or its text is under 8 px tall", () => {
    const named = cell("buttons/button/primary", { html: "<span>Button</span>", text: "Button", painted: 0 });
    expect(rubric(card([named]))).toEqual(["nameOnly", "thin"]);
    const hollow = cell("custom/divider/default", { html: "<div class=\"divider\"></div>", text: "", textHeight: 0, painted: 0 });
    expect(rubric(card([hollow], { name: "Divider" }))).toEqual(["allHollow", "thin"]);
    const tiny = cell("data/badge/count", { html: "<span class=\"badge\">3</span>", text: "3", textHeight: 4 });
    expect(rubric(card([tiny], { name: "Badge" }))).toEqual(["collapsed", "thin"]);
    // Text that does not show at all is collapsed too.
    const hidden = cell("data/badge/count", { html: "<span class=\"badge\" hidden>3</span>", text: "3", textHeight: 0, painted: 1 });
    expect(rubric(card([hidden], { name: "Badge" }))).toEqual(["collapsed", "thin"]);
  });

  it("never finds a floor card thin", () => {
    const floor = cell("buttons/button/default", { html: "<p>Button</p>", text: "Button", painted: 0 });
    expect(rubric(card([floor], { fallback: true }))).toEqual(["nameOnly"]);
  });

  it("says when every cell has the same markup", () => {
    const same = (s: string) => cell(s, { html: '<button class="btn">Run</button>', text: "Run" });
    expect(rubric(card([same("buttons/button/primary"), same("buttons/button/ghost")]))).toEqual(["variantsIdentical"]);
    // One cell has nothing to be identical to.
    expect(rubric(card([same("buttons/button/primary")]))).toEqual([]);
  });

  it("says when a cell is too wide for a 680 px grid, or its content escapes it", () => {
    expect(rubric(card([cell("data/table/default", { overflow680: 240 })], { name: "Table" }))).toEqual(["wide"]);
    // A pixel of rounding is not wide.
    expect(rubric(card([cell("data/table/default", { overflow680: 1 })], { name: "Table" }))).toEqual([]);
    expect(rubric(card([cell("menus/menu/open", { escaped: 2 })], { name: "Menu" }))).toEqual(["escape"]);
    expect(rubric(card([cell("menus/menu/open")], { name: "Menu", fixedOutside: 1 }))).toEqual(["escape"]);
  });

  it("reads only what has the shape of measurements", () => {
    const m = card([cell("buttons/button/primary")]);
    expect(readMeasurements(JSON.parse(JSON.stringify(m)))).toEqual(m);
    for (const bad of [null, "metrics", { ...m, cells: "none" }, { ...m, errors: [1] }, { ...m, cells: [{ ...cell("x"), textHeight: "17" }] }]) {
      expect(readMeasurements(bad)).toBeNull();
    }
  });
});
