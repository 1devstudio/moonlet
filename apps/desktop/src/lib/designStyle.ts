// An element's inline `style` as the visual editor reads and writes it
// (X65): its declarations in order, parsed and serialized in this one
// place, and the check of every property and value the editor writes,
// which go into an attribute of the page's source.

/** A declaration of an inline style: its property and value. */
export type Decl = [prop: string, value: string];

/** Properties to set (a value) or remove (null), in the order set. */
export type StyleSet = Record<string, string | null>;

/** The declarations of a `style` attribute's text, in order: each
 *  `property: value` between semicolons outside parentheses and quotes,
 *  the property in lowercase; a later one of a property replaces the
 *  earlier one in its place, as only the last counts. Text that is no
 *  declaration is dropped. */
export function parseStyle(text: string): Decl[] {
  const out: Decl[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  const take = (part: string) => {
    const colon = part.indexOf(":");
    if (colon < 0) return;
    const prop = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (!/^-{0,2}[a-z][a-z0-9-]*$/.test(prop) || !value) return;
    const at = out.findIndex(([p]) => p === prop);
    if (at >= 0) out[at] = [prop, value];
    else out.push([prop, value]);
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) {
      take(text.slice(start, i));
      start = i + 1;
    }
  }
  take(text.slice(start));
  return out;
}

/** The text of a `style` attribute: `padding: 4px; gap: 8px`. */
export function styleText(decls: Decl[]): string {
  return decls.map(([p, v]) => `${p}: ${v}`).join("; ");
}

/** `decls` with `set` made: a property set keeps its place, or goes last
 *  when new; one set to null is removed; the others stay as they were. */
export function withStyle(decls: Decl[], set: StyleSet): Decl[] {
  const out = decls.map(([p, v]): Decl => [p, v]);
  for (const [prop, value] of Object.entries(set)) {
    const at = out.findIndex(([p]) => p === prop);
    if (value === null) {
      if (at >= 0) out.splice(at, 1);
    } else if (at >= 0) out[at] = [prop, value];
    else out.push([prop, value]);
  }
  return out;
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
