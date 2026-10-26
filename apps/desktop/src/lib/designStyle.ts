// An element's inline `style` as the visual editor reads and writes it
// (X65): its declarations, read and rewritten in this one place, and the
// check of every property and value the editor writes, which go into an
// attribute of the page's source. A rewrite splices only the declarations
// of the properties it sets, so every other one, with its comments, case,
// spacing, duplicates and `!important`, stays as written.

/** A declaration of an inline style: its property and value. */
export type Decl = [prop: string, value: string];

/** Properties to set (a value) or remove (null), in the order set. */
export type StyleSet = Record<string, string | null>;

/** A declaration as a `style` attribute's text writes it: its property (in
 *  lowercase, a custom property's as written), its value without comments,
 *  whether it is `!important`, and where it is: from its property to the
 *  end of its part, before the `;` that ends it (`end`). */
interface Written {
  prop: string;
  value: string;
  important: boolean;
  from: number;
  end: number;
}

/** A comment with the space around it, read as one space. */
const COMMENT = /\s*\/\*[\s\S]*?(\*\/|$)\s*/g;

/** The declarations of a `style` attribute's text, each part between
 *  semicolons outside parentheses, quotes and comments that is `property:
 *  value`; a part that is none is left out. `open`: what the text leaves
 *  open at its end (a comment, a quote or parentheses), as their closing. */
function written(text: string): { decls: Written[]; open: string } {
  const decls: Written[] = [];
  let depth = 0;
  let quote: string | null = null;
  let comment = false;
  let start = 0;
  const take = (end: number) => {
    // The property after any space and comments the part starts with.
    let from = start;
    for (;;) {
      while (from < end && /\s/.test(text[from])) from++;
      if (!text.startsWith("/*", from)) break;
      const close = text.indexOf("*/", from + 2);
      from = close < 0 || close + 2 > end ? end : close + 2;
    }
    const m = /^(--[\w-]+|-?[A-Za-z_][\w-]*)\s*:/.exec(text.slice(from, end));
    if (!m) return;
    const value = text.slice(from + m[0].length, end).replace(COMMENT, " ").trim();
    if (!value) return;
    const prop = m[1].startsWith("--") ? m[1] : m[1].toLowerCase();
    decls.push({ prop, value, important: /!\s*important$/i.test(value), from, end });
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (comment) {
      if (c === "*" && text[i + 1] === "/") (comment = false), i++;
    } else if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === "/" && text[i + 1] === "*") (comment = true), i++;
    else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) {
      take(i);
      start = i + 1;
    }
  }
  take(text.length);
  return { decls, open: comment ? "*/" : (quote ?? "") + ")".repeat(depth) };
}

/** The declarations of a `style` attribute's text that count, one per
 *  property in the place of its first: the last one `!important`, else the
 *  last. Text that is no declaration is left out. */
export function parseStyle(text: string): Decl[] {
  const out: Decl[] = [];
  const counts = new Map<string, Written>();
  for (const d of written(text).decls) {
    const was = counts.get(d.prop);
    if (!was) out.push([d.prop, ""]);
    if (!was || d.important || !was.important) counts.set(d.prop, d);
  }
  return out.map(([prop]) => [prop, counts.get(prop)!.value]);
}

/** A `style` attribute's text with `set` made, spliced: a property set is
 *  written in the place of its first declaration, its others taken away,
 *  or last when it has none; one set to null has each of its declarations
 *  taken away with its `;`. Everything else stays as written. */
export function restyled(text: string, set: StyleSet): string {
  let out = text;
  for (const [prop, value] of Object.entries(set)) {
    const { decls, open } = written(out);
    const mine = decls.filter((d) => d.prop === prop);
    // Taken away last first, so the places before stay right.
    for (const d of mine.slice(value === null ? 0 : 1).reverse()) out = without(out, d);
    if (value === null) continue;
    const decl = `${prop}: ${value}`;
    if (mine.length) out = out.slice(0, mine[0].from) + decl + out.slice(mine[0].end);
    else {
      const body = out.trimEnd();
      const sep = !body ? "" : open || !body.endsWith(";") ? `${open}; ` : " ";
      out = body + sep + decl + out.slice(body.length);
    }
  }
  return out;
}

/** `text` less declaration `d`: with the `;` after it and the space after
 *  that, or, when it is last, with the space and the `;` before it. */
function without(text: string, d: Written): string {
  let from = d.from;
  let to = d.end;
  if (text[to] === ";") {
    to++;
    while (to < text.length && /\s/.test(text[to])) to++;
  } else {
    while (from > 0 && /\s/.test(text[from - 1])) from--;
    if (text[from - 1] === ";") from--;
  }
  return text.slice(0, from) + text.slice(to);
}

/** The longest style value the editor writes, or takes from the page. */
export const STYLE_VALUE_MAX = 200;

/** A border's styles: `none` and `hidden` draw none. */
export const BORDER_STYLES = ["none", "hidden", "dotted", "dashed", "solid", "double", "groove", "ridge", "inset", "outset"] as const;

/** A value's parts, split on spaces outside parentheses: `14px 24px`,
 *  `0 1px 3px rgb(0 0 0 / 0.3)` as four. */
export function valueParts(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of value.trim()) {
    depth += c === "(" ? 1 : c === ")" ? -1 : 0;
    if (/\s/.test(c) && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/** Words of a border or a background that are no colour: widths, styles,
 *  repeats, places, sizes and boxes, and the keywords of any property. */
const NOT_A_COLOUR = new Set<string>(["thin", "medium", "thick", ...BORDER_STYLES, "repeat", "no-repeat", "repeat-x", "repeat-y", "space", "round", "scroll", "fixed", "local", "center", "top", "bottom", "left", "right", "cover", "contain", "auto", "border-box", "padding-box", "content-box", "text", "inherit", "initial", "unset", "revert", "/"]);

/** The parts of a shorthand value that are colours, as in `border` or
 *  `background`: a hex, a colour function, a `var()`, or a word that is
 *  not one of a border's or a background's other words; never a length,
 *  a number or an image. */
export function colourParts(value: string): string[] {
  return valueParts(value).filter((p) => {
    const v = p.toLowerCase();
    if (/^#[0-9a-f]{3,8}$/.test(v) || /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|var)\(/.test(v)) return true;
    return /^[a-z][a-z-]*$/.test(v) && !NOT_A_COLOUR.has(v);
  });
}

/** A property the editor writes: lowercase letters and `-`, as `padding`
 *  or `border-radius`. */
export function isStyleProp(prop: string): boolean {
  return /^[a-z][a-z-]{0,39}$/.test(prop);
}

/** A value the editor writes into a `style` attribute: lengths, numbers,
 *  colours, keywords, `var(--token)` and functions such as `rgb()`, with
 *  balanced parentheses, at most {@link STYLE_VALUE_MAX} characters, and nothing that could
 *  end the declaration or the attribute or load anything: no quotes, `;`,
 *  braces, angle brackets, backslash, `url(` or `@`; and no `/*` or `*\/`,
 *  which would open or close a comment and hide the declarations after
 *  it. A `/` alone stays, as in `1 / 3` or `12px/1.5`. */
export function isStyleValue(value: string): boolean {
  if (!value.trim() || value.length > STYLE_VALUE_MAX || !/^[A-Za-z0-9\s#%.,()/+*!_-]+$/.test(value) || /url\s*\(|expression\s*\(|\/\*|\*\//i.test(value)) return false;
  let depth = 0;
  for (const c of value) {
    depth += c === "(" ? 1 : c === ")" ? -1 : 0;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/** A `style` attribute's text as the source writes it, in double quotes:
 *  `&` and `"` as entities. */
export function attrText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
