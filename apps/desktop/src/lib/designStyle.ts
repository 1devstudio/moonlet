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

/** A property the editor writes: lowercase letters and `-`, as `padding`
 *  or `border-radius`. */
export function isStyleProp(prop: string): boolean {
  return /^[a-z][a-z-]{0,39}$/.test(prop);
}

/** A value the editor writes into a `style` attribute: lengths, numbers,
 *  colours, keywords, `var(--token)` and functions such as `rgb()`, with
 *  balanced parentheses, at most 200 characters, and nothing that could
 *  end the declaration or the attribute or load anything: no quotes, `;`,
 *  braces, angle brackets, backslash, `url(` or `@`. */
export function isStyleValue(value: string): boolean {
  if (!value.trim() || value.length > 200 || !/^[A-Za-z0-9\s#%.,()/+*!_-]+$/.test(value) || /url\s*\(|expression\s*\(/i.test(value)) return false;
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
