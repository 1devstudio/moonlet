// A design system's tokens in the visual editor (X65): which token a
// value is, how an Inspector field shows it (`--space-1  4px`), the order
// of the token popover, and the off-system flag of an element whose inline
// style has a value that matches no token. The tokens are the X64 check's
// own reading of the system's `tokens/` (`design.kit`); nothing here parses
// a stylesheet.

import type { DesignToken } from "./protocol";
import { colourParts, valueParts, type Decl } from "./designStyle";

export type TokenFamily = DesignToken["family"];

/** A token as a style value: `var(--space-4)`. The one build of a token
 *  reference; {@link varAt} its one parse. */
export const tokenRef = (name: string) => `var(${name})`;

/** The first `var(--name)` or `var(--name, fallback)` in `text` from
 *  `from`: where it is, the name and the fallback; null for none. */
export function varAt(text: string, from = 0): { start: number; end: number; name: string; fallback: string | null } | null {
  const re = /var\(\s*(--[A-Za-z0-9_-]+)\s*/g;
  re.lastIndex = from;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let i = m.index + m[0].length;
    let fallback: string | null = null;
    if (text[i] === ",") {
      let depth = 0;
      const begin = ++i;
      for (; i < text.length && !(text[i] === ")" && depth === 0); i++) depth += text[i] === "(" ? 1 : text[i] === ")" ? -1 : 0;
      fallback = text.slice(begin, i).trim();
    }
    if (text[i] === ")") return { start: m.index, end: i + 1, name: m[1], fallback };
  }
  return null;
}

/** The token a value names when it is just `var(--token)`; null otherwise. */
export function tokenRefName(value: string): string | null {
  const v = value.trim();
  const at = varAt(v);
  return at && at.start === 0 && at.end === v.length && at.fallback === null ? at.name : null;
}

/** `value` with each `var(--token)` in it replaced by the token's value,
 *  along aliases; a `var()` of no token by its fallback, else as it is. */
export function resolveValue(tokens: DesignToken[], value: string): string {
  let out = value.trim();
  let from = 0;
  for (let i = 0; i < 10; i++) {
    const m = varAt(out, from);
    if (!m) break;
    const t = tokens.find((x) => x.name === m.name);
    const by = t ? t.value : m.fallback;
    if (by === null) {
      from = m.end;
      continue;
    }
    out = out.slice(0, m.start) + by + out.slice(m.end);
  }
  return out;
}

/** A colour's channels as `rgb(r, g, b)`, or `rgba(r, g, b, a)` below 1. */
function rgbText(ch: number[], a: number): string {
  const n = (x: number) => String(Math.round(x * 1000) / 1000);
  return a >= 1 ? `rgb(${ch.map(n).join(", ")})` : `rgba(${ch.map(n).join(", ")}, ${n(a)})`;
}

/** The root's font size the page computes px from, as a browser's
 *  default: a token in rem (or em, at the root) is that many times it. */
export const ROOT_PX = 16;

/** A value as it compares: lowercase, single spaces, rem and em as px at
 *  {@link ROOT_PX}, `0px` as `0`, and colours written as hex or `rgb()` in
 *  either syntax, its channels in numbers or percentages, as one `rgb()`. */
function norm(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/(^|[\s(,])(-?\d*\.?\d+)r?em\b/g, (_all, pre: string, n: string) => `${pre}${Math.round(Number(n) * ROOT_PX * 1000) / 1000}px`)
    .replace(/#([0-9a-f]{3,8})\b/g, (all, hex: string) => {
      if (![3, 4, 6, 8].includes(hex.length)) return all;
      const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
      const ch = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
      return rgbText(ch, full.length === 8 ? parseInt(full.slice(6), 16) / 255 : 1);
    })
    .replace(/rgba?\(([^)]*)\)/g, (all, inside: string) => {
      // A channel in % is of 255, rounded as the page computes it; an
      // alpha in % is of 1.
      const nums = inside
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map((x, i) => (!x.endsWith("%") ? Number(x) : i < 3 ? Math.round((Number(x.slice(0, -1)) * 255) / 100) : Number(x.slice(0, -1)) / 100));
      if (nums.length < 3 || nums.length > 4 || nums.some((x) => Number.isNaN(x))) return all;
      return rgbText(nums.slice(0, 3), nums[3] ?? 1);
    })
    .replace(/(^|[\s(,])0px\b/g, "$10");
}

/** The token `value` is: the token of `family` it names (`var(--space-4)`),
 *  none when it names one of another family, else the first of `family`
 *  whose value, along aliases, is the same value; null for none. */
export function tokenOf(tokens: DesignToken[], value: string, family?: TokenFamily): DesignToken | null {
  const name = tokenRefName(value);
  if (name) return tokens.find((t) => t.name === name && (!family || t.family === family)) ?? null;
  const want = norm(resolveValue(tokens, value));
  if (!want) return null;
  return tokens.find((t) => (!family || t.family === family) && norm(resolveValue(tokens, t.value)) === want) ?? null;
}

/** What an Inspector field shows of `value`: its token and the token's
 *  value (`--space-1`, `4px`), a token per part when every part has one
 *  (`--space-5 --space-6`, `20px 24px`), else no token and the value. */
export function fieldShown(tokens: DesignToken[], value: string, family: TokenFamily): { token: string | null; value: string } {
  const whole = tokenOf(tokens, value, family);
  if (whole) return { token: whole.name, value: resolveValue(tokens, whole.value) };
  const each = valueParts(value).map((p) => tokenOf(tokens, p, family));
  if (each.length > 1 && each.every((t) => t !== null)) return { token: each.map((t) => t!.name).join(" "), value: each.map((t) => resolveValue(tokens, t!.value)).join(" ") };
  return { token: null, value: resolveValue(tokens, value) };
}

/** The first number of a value, along aliases, a length in px; NaN for none. */
const numberOf = (tokens: DesignToken[], value: string) => parseFloat(/-?\d*\.?\d+/.exec(norm(resolveValue(tokens, value)))?.[0] ?? "NaN");

/** The token popover of a field whose value is `value`: the tokens of its
 *  family, first those a part of the value is (the one it names, then
 *  those of the same value), then the rest nearest to its first number,
 *  ties in the system's order. */
export function popoverTokens(tokens: DesignToken[], value: string, family: TokenFamily): DesignToken[] {
  const fam = tokens.filter((t) => t.family === family);
  const first: DesignToken[] = [];
  for (const p of valueParts(value)) {
    const want = norm(resolveValue(tokens, p));
    const name = tokenRefName(p);
    const same = fam.filter((t) => t.name === name || norm(resolveValue(tokens, t.value)) === want);
    for (const t of same.sort((a, b) => Number(b.name === name) - Number(a.name === name))) if (!first.includes(t)) first.push(t);
  }
  const at = numberOf(tokens, valueParts(value)[0] ?? "");
  const rest = fam.filter((t) => !first.includes(t));
  if (!Number.isNaN(at)) {
    const d = (t: DesignToken) => Math.abs(numberOf(tokens, t.value) - at);
    rest.sort((a, b) => (Number.isNaN(d(a)) ? Infinity : d(a)) - (Number.isNaN(d(b)) ? Infinity : d(b)));
  }
  return [...first, ...rest];
}

/** An entry of the token popover: the tokens it writes, one per part of
 *  the value, and their values. */
export interface PopoverEntry {
  names: string[];
  value: string;
}

/** The token popover's entries: for a value of two to four parts (a
 *  padding or margin shorthand), first a token per part, the one each part
 *  is, else the nearest of the family; then each token of the family, in
 *  {@link popoverTokens}' order. */
export function popoverEntries(tokens: DesignToken[], value: string, family: TokenFamily): PopoverEntry[] {
  const single = (t: DesignToken): PopoverEntry => ({ names: [t.name], value: resolveValue(tokens, t.value) });
  const singles = popoverTokens(tokens, value, family).map(single);
  const each = valueParts(value);
  if (each.length < 2 || each.length > 4) return singles;
  const per = each.map((p) => tokenOf(tokens, p, family) ?? popoverTokens(tokens, p, family)[0] ?? null);
  if (per.some((t) => t === null)) return singles;
  const pair = per.map((t) => single(t!));
  return [{ names: pair.flatMap((e) => e.names), value: pair.map((e) => e.value).join(" ") }, ...singles];
}

/** What a property's value must match to be on the system: each part a
 *  token of the family (`parts`), the whole value one (`whole`), or each
 *  colour part a colour token (`colours`), as in `border`. */
type Rule = { family: TokenFamily; by: "parts" | "whole" | "colours" };

/** The properties whose values take tokens, and how. Sizes, places,
 *  display and opacity take none: they are never off-system. */
export function propRule(prop: string): Rule | null {
  if (/^(padding|margin)(-(top|right|bottom|left|inline|block)(-(start|end))?)?$/.test(prop) || /^(row-|column-)?gap$/.test(prop)) return { family: "spacing", by: "parts" };
  if (/^(color|background-color|border(-(top|right|bottom|left))?-color|outline-color|fill|stroke)$/.test(prop)) return { family: "color", by: "whole" };
  if (/^(border(-(top|right|bottom|left))?|outline|background)$/.test(prop)) return { family: "color", by: "colours" };
  if (/^border(-(top|bottom)-(left|right))?-radius$/.test(prop)) return { family: "radius", by: "parts" };
  if (prop === "box-shadow") return { family: "shadow", by: "whole" };
  if (/^(font-size|font-family|font-weight|line-height|letter-spacing)$/.test(prop)) return { family: "typography", by: "whole" };
  return null;
}

/** Values on any system: keywords that are no design choice. */
const NEUTRAL = new Set(["0", "auto", "none", "inherit", "initial", "unset", "revert", "transparent", "currentcolor", "normal"]);

/** The properties of an inline style whose value matches no token, where
 *  the property takes tokens: they make the element off-system. */
export function offSystem(tokens: DesignToken[], style: Decl[]): string[] {
  const on = (v: string, family: TokenFamily) => NEUTRAL.has(norm(v)) || tokenOf(tokens, v, family) !== null;
  return style
    .filter(([prop, value]) => {
      const rule = propRule(prop);
      if (!rule) return false;
      if (rule.by === "whole") return !on(value, rule.family);
      const each = rule.by === "parts" ? valueParts(value) : colourParts(value);
      return !each.every((p) => on(p, rule.family));
    })
    .map(([prop]) => prop);
}

/** The elements of a page, by their inline styles (`inlineStyles`), that
 *  are off-system, in the page's order. */
export function offSystemMids(tokens: DesignToken[], styles: Record<string, Decl[]>): Set<string> {
  return new Set(Object.keys(styles).filter((mid) => offSystem(tokens, styles[mid]).length > 0));
}
