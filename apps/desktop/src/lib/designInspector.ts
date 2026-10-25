// The Inspector tab of the visual editor (X65): its sections and fields
// for the selected element, the value each shows (the element's inline
// style, else what the page computes, which the bridge reports), and the
// style value a field writes from what the user types or picks. Tokens
// are designTokens.ts; the write is a restyle edit (designEdits.ts).

import { BORDER_STYLES, colourParts, isStyleValue, valueParts, type Decl, type StyleSet } from "./designStyle";
import { fieldShown, popoverEntries, resolveValue, tokenOf, tokenRef, tokenRefName, type PopoverEntry, type TokenFamily } from "./designTokens";
import type { DesignToken } from "./protocol";

/** One field: the property it writes, and how its value is typed. */
export interface Field {
  label: string;
  prop: string;
  /** A keyword from `options`; a value that may be a token of `family`;
   *  a size (px, %, auto, fill); an opacity; or free text. */
  kind: "keyword" | "token" | "size" | "opacity" | "text";
  family?: TokenFamily;
  options?: string[];
  /** Other properties the inline style may set it with (`background`). */
  also?: string[];
}

export interface Section {
  title: string;
  fields: Field[];
}

const DISPLAY: Field = { label: "Display", prop: "display", kind: "keyword", options: ["block", "flex", "grid", "inline", "inline-block", "inline-flex", "inline-grid", "none"] };
const DIRECTION: Field = { label: "Direction", prop: "flex-direction", kind: "keyword", options: ["row", "column", "row-reverse", "column-reverse"] };
const GAP: Field = { label: "Gap", prop: "gap", kind: "token", family: "spacing" };
const ALIGN: Field = { label: "Alignment", prop: "align-items", kind: "keyword", options: ["stretch", "start", "center", "end", "baseline"] };
const JUSTIFY: Field = { label: "Justify", prop: "justify-content", kind: "keyword", options: ["start", "center", "end", "space-between", "space-around", "space-evenly", "stretch"] };
const COLUMNS: Field = { label: "Grid columns", prop: "grid-template-columns", kind: "text" };

/** The Inspector's sections for an element whose `display` is `display`:
 *  Layout (display; direction for flex, columns for grid; gap, alignment
 *  and justification for both), Spacing, Size, Fill and border, Effects. */
export function inspectorSections(display: string): Section[] {
  const flex = /flex$/.test(display);
  const grid = /grid$/.test(display);
  return [
    { title: "Layout", fields: [DISPLAY, ...(flex ? [DIRECTION] : []), ...(grid ? [COLUMNS] : []), ...(flex || grid ? [GAP, ALIGN, JUSTIFY] : [])] },
    {
      title: "Spacing",
      fields: [
        { label: "Padding", prop: "padding", kind: "token", family: "spacing" },
        { label: "Margin", prop: "margin", kind: "token", family: "spacing" },
      ],
    },
    {
      title: "Size",
      fields: [
        // No family: a design system's tokens have no sizes (X64).
        { label: "Width", prop: "width", kind: "size" },
        { label: "Height", prop: "height", kind: "size" },
      ],
    },
    {
      title: "Fill and border",
      fields: [
        { label: "Fill", prop: "background-color", kind: "token", family: "color", also: ["background"] },
        { label: "Border", prop: "border", kind: "token", family: "color" },
        { label: "Radius", prop: "border-radius", kind: "token", family: "radius" },
      ],
    },
    {
      title: "Effects",
      fields: [
        { label: "Shadow", prop: "box-shadow", kind: "token", family: "shadow" },
        { label: "Opacity", prop: "opacity", kind: "opacity" },
      ],
    },
  ];
}

/** `fill`: as wide or tall as its container. */
const FILL = "100%";

/** What a field shows: the element's inline value of its property (or one
 *  it may be set with), else the page's computed one, a size of 100% as
 *  `fill` and an opacity as a percentage; `inline` when the style sets it. */
export function fieldValue(field: Field, inline: Decl[], computed: Record<string, string>): { value: string; inline: boolean } {
  const own = inline.find(([p]) => p === field.prop);
  // A shorthand it may be set with (Fill's `background`) gives its colour.
  const short = own ? undefined : inline.find(([p]) => field.also?.includes(p));
  const colour = short ? colourParts(short[1])[0] : undefined;
  const raw = own?.[1] ?? colour ?? computed[field.prop] ?? "";
  const value = field.kind === "size" && raw === FILL ? "fill" : field.kind === "opacity" && raw !== "" && !Number.isNaN(Number(raw)) ? `${Math.round(Number(raw) * 100)}%` : raw;
  return { value, inline: !!own || colour !== undefined };
}

/** The style value a field writes from what the user typed: `set` (null:
 *  the property removed, for an empty field), or why it cannot be. A size
 *  is px (a number alone too), %, auto or fill; an opacity a percentage or
 *  a fraction; any other value one the editor writes (designStyle). */
export function fieldInput(field: Field, typed: string): { set: string | null } | { error: string } {
  const text = typed.trim();
  if (!text) return { set: null };
  if (field.kind === "size") {
    if (text === "fill") return { set: FILL };
    if (text === "auto" || tokenRefName(text)) return { set: text };
    const m = /^(\d+(?:\.\d+)?)(px|%)?$/.exec(text);
    return m ? { set: `${m[1]}${m[2] ?? "px"}` } : { error: "A size is px, %, auto or fill" };
  }
  if (field.kind === "opacity") {
    const m = /^(\d+(?:\.\d+)?)(%)?$/.exec(text);
    const n = m ? Number(m[1]) / (m[2] ? 100 : 1) : NaN;
    return n >= 0 && n <= 1 ? { set: String(n) } : { error: "An opacity is 0% to 100%" };
  }
  return isStyleValue(text) ? { set: text } : { error: "Not a value the editor writes" };
}

/** The value tokens picked in a field's popover write: `var(--token)`,
 *  one per part of the value for several (`var(--space-4) var(--space-6)`);
 *  in a border, its colour, keeping the width and style it has. */
export function pickToken(field: Field, current: string, names: string[]): string {
  if (field.prop !== "border") return names.map(tokenRef).join(" ");
  const token = names[0];
  const parts = valueParts(current);
  const width = parts.find((p) => /^-?[\d.]+[a-z]*$/.test(p) || /^(thin|medium|thick)$/.test(p)) ?? "1px";
  const style = parts.find((p) => (BORDER_STYLES as readonly string[]).includes(p)) ?? "solid";
  return `${width} ${style} ${tokenRef(token)}`;
}

/** What a field shows of `value`, its token and the token's value
 *  (designTokens' fieldShown); a border as its width and style with its
 *  colour's token (`1px solid --color-border`, `#2a2a2a`). Free text and
 *  keywords show no token. */
export function fieldShows(field: Field, tokens: DesignToken[], value: string): { token: string | null; value: string } {
  const family = tokensOf(field);
  if (!family) return { token: null, value };
  if (field.prop !== "border") return fieldShown(tokens, value, family);
  const parts = valueParts(value);
  const at = parts.findIndex((p) => tokenOf(tokens, p, "color") !== null);
  if (at < 0) return { token: null, value };
  const t = tokenOf(tokens, parts[at], "color")!;
  return { token: parts.map((p, i) => (i === at ? t.name : p)).join(" "), value: resolveValue(tokens, t.value) };
}

/** The family of tokens a field takes; null for one that takes none (a
 *  keyword, free text, a size or an opacity). */
function tokensOf(field: Field): TokenFamily | null {
  return field.kind === "token" && field.family ? field.family : null;
}

/** A field's popover entries (designTokens' popoverEntries); none for a
 *  field that takes no tokens, whose popover has only the free value. */
export function fieldEntries(field: Field, tokens: DesignToken[], value: string): PopoverEntry[] {
  const family = tokensOf(field);
  return family ? popoverEntries(tokens, value, family) : [];
}

/** The properties a field writes `value` with (null: clears it). Fill
 *  writes `background-color`; an inline `background` shorthand that holds
 *  only a colour is taken away, so it neither overrides the write nor
 *  comes back once Fill is cleared; one that also has an image or other
 *  parts gets the colour in place of its own, those parts kept as written. */
export function fieldSet(field: Field, inline: Decl[], value: string | null): StyleSet {
  const short = field.also ? inline.find(([p]) => field.also!.includes(p)) : undefined;
  if (!short) return { [field.prop]: value };
  const rest = valueParts(short[1]).filter((p) => !colourParts(short[1]).includes(p));
  if (!rest.length) return { [short[0]]: null, [field.prop]: value };
  return { [short[0]]: [...rest, ...(value === null ? [] : [value])].join(" "), [field.prop]: null };
}
