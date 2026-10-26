// The render check's rubric (X64), design-sync's: what the measuring script
// found in a rendered card, turned into its flags. The script runs inside the
// card's sandboxed frame; this runs in the app's render page.

/** One cell of a card (a variant), or the whole page for a card without cells. */
export interface CellMeasure {
  /** Its snippet id; null for a page without cells. */
  snippet: string | null;
  /** The mount's markup, whitespace collapsed. */
  html: string;
  /** The mount's text, whitespace collapsed. */
  text: string;
  /** The mount holds no element and no text. */
  empty: boolean;
  /** How tall its least visible text is, in px: the smallest, over its text,
   *  of each text's tallest line box; 0 when some text does not show. Text
   *  never rendered (in `<script>`, `<style>`, `<template>`…) is not text. */
  smallestText: number;
  /** Its elements that paint something: a background, a border, a shadow, an image or a control. */
  painted: number;
  /** How far its content overflows the cell when the page is 680 px wide, in px. */
  overflow680: number;
  /** Its elements positioned fixed or absolute that reach outside it. */
  escaped: number;
}

export interface Measurements {
  /** The card's name, from its `@dsCard` marker. */
  name: string | null;
  /** A floor card (`data-ds-fallback`). */
  fallback: boolean;
  /** Its page errors. */
  errors: string[];
  cells: CellMeasure[];
  /** Visible elements outside every cell, fixed, absolute or in the flow,
   *  as a portal mounts them. */
  outside: number;
}

export type RenderFlag = "rootEmpty" | "errs" | "nameOnly" | "allHollow" | "collapsed" | "variantsIdentical" | "wide" | "escape" | "thin" | "bad";

/** Text under this height, in px, is `collapsed`. */
const COLLAPSED_BELOW = 8;

/** The flags a card raises, in the rubric's order:
 *  - `rootEmpty`: a mount is empty
 *  - `errs`: the page had errors
 *  - `nameOnly`: the only text is the card's name, repeated
 *  - `allHollow`: no text and nothing painted
 *  - `collapsed`: text under 8 px tall, or text that does not show
 *  - `variantsIdentical`: every cell has the same markup
 *  - `wide`: a cell overflows at a 680 px grid; `escape`: fixed or portal content leaves its cell
 *  - `thin`: `nameOnly`, `allHollow` or `collapsed`, never on a floor card
 *  - `bad`: `rootEmpty`, or `errs` on a card that is not a floor card */
export function rubric(m: Measurements): RenderFlag[] {
  const flags = new Set<RenderFlag>();
  const texts = m.cells.map((c) => c.text.trim()).filter(Boolean);
  if (m.cells.some((c) => c.empty)) flags.add("rootEmpty");
  if (m.errors.length > 0) flags.add("errs");
  if (m.name && texts.length > 0) {
    const name = m.name.trim().toLowerCase();
    if (name && texts.every((t) => t.toLowerCase().split(name).join("").trim() === "")) flags.add("nameOnly");
  }
  if (texts.length === 0 && m.cells.every((c) => c.painted === 0)) flags.add("allHollow");
  if (m.cells.some((c) => c.text.trim() !== "" && c.smallestText < COLLAPSED_BELOW)) flags.add("collapsed");
  if (m.cells.length > 1 && m.cells.every((c) => c.html === m.cells[0].html)) flags.add("variantsIdentical");
  if (m.cells.some((c) => c.overflow680 > 1)) flags.add("wide");
  if (m.outside > 0 || m.cells.some((c) => c.escaped > 0)) flags.add("escape");
  if (!m.fallback && (flags.has("nameOnly") || flags.has("allHollow") || flags.has("collapsed"))) flags.add("thin");
  if (flags.has("rootEmpty") || (flags.has("errs") && !m.fallback)) flags.add("bad");
  const order: RenderFlag[] = ["rootEmpty", "errs", "nameOnly", "allHollow", "collapsed", "variantsIdentical", "wide", "escape", "thin", "bad"];
  return order.filter((f) => flags.has(f));
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";

function readCell(v: unknown): CellMeasure | null {
  if (typeof v !== "object" || v === null) return null;
  const c = v as Record<string, unknown>;
  if (!(c.snippet === null || isStr(c.snippet)) || !isStr(c.html) || !isStr(c.text) || typeof c.empty !== "boolean") return null;
  if (!isNum(c.smallestText) || !isNum(c.painted) || !isNum(c.overflow680) || !isNum(c.escaped)) return null;
  return { snippet: c.snippet, html: c.html, text: c.text, empty: c.empty, smallestText: c.smallestText, painted: c.painted, overflow680: c.overflow680, escaped: c.escaped };
}

/** What the measuring script posted, when it has the shape of `Measurements`; null otherwise. */
export function readMeasurements(data: unknown): Measurements | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (!(d.name === null || isStr(d.name)) || typeof d.fallback !== "boolean" || !isNum(d.outside)) return null;
  if (!Array.isArray(d.errors) || !d.errors.every(isStr) || !Array.isArray(d.cells)) return null;
  const cells = d.cells.map(readCell);
  if (cells.some((c) => c === null)) return null;
  return { name: d.name, fallback: d.fallback, errors: d.errors, cells: cells as CellMeasure[], outside: d.outside };
}
