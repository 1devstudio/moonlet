// A design system's tokens in the visual editor (X65): which token a
// value is, how an Inspector field shows it (`--space-1  4px`), the order
// of the token popover, and the off-system flag of an element whose inline
// style has a value that matches no token. The tokens are the X64 check's
// own reading of the system's `tokens/` (`design.kit`); nothing here parses
// a stylesheet.

import type { DesignToken } from "./protocol";
import type { Decl } from "./designStyle";

export type TokenFamily = DesignToken["family"];

const VAR = /var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,([^()]*(?:\([^()]*\))?[^()]*))?\)/;

/** `value` with each `var(--token)` in it replaced by the token's value,
 *  along aliases; a `var()` of no token by its fallback, else as it is. */
export function resolveValue(tokens: DesignToken[], value: string): string {
  let out = value.trim();
  for (let i = 0; i < 10; i++) {
    const m = VAR.exec(out);
    if (!m) break;
    const t = tokens.find((x) => x.name === m[1]);
    const by = t ? t.value : m[2] !== undefined ? m[2].trim() : null;
    if (by === null) break;
    out = out.slice(0, m.index) + by + out.slice(m.index + m[0].length);
  }
  return out;
}

/** A colour's channels as `rgb(r, g, b)`, or `rgba(r, g, b, a)` below 1. */
function rgbText(ch: number[], a: number): string {
  const n = (x: number) => String(Math.round(x * 1000) / 1000);
  return a >= 1 ? `rgb(${ch.map(n).join(", ")})` : `rgba(${ch.map(n).join(", ")}, ${n(a)})`;
}

/** A value as it compares: lowercase, single spaces, `0px` as `0`, and
 *  colours written as hex or `rgb()` in either syntax as one `rgb()`. */
function norm(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/#([0-9a-f]{3,8})\b/g, (all, hex: string) => {
      if (![3, 4, 6, 8].includes(hex.length)) return all;
      const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
      const ch = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
      return rgbText(ch, full.length === 8 ? parseInt(full.slice(6), 16) / 255 : 1);
    })
    .replace(/rgba?\(([^)]*)\)/g, (all, inside: string) => {
      const nums = inside
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map((x) => (x.endsWith("%") ? Number(x.slice(0, -1)) / 100 : Number(x)));
      if (nums.length < 3 || nums.length > 4 || nums.some((x) => Number.isNaN(x))) return all;
      return rgbText(nums.slice(0, 3), nums[3] ?? 1);
    })
    .replace(/(^|[\s(,])0px\b/g, "$10");
}

/** A value's parts, split on spaces outside parentheses: `14px 24px`. */
function parts(value: string): string[] {
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

const named = (value: string) => /^var\(\s*(--[A-Za-z0-9_-]+)\s*\)$/.exec(value.trim())?.[1] ?? null;

/** The token `value` is: the token it names (`var(--space-4)`), else the
 *  first of `family` whose value, along aliases, is the same value; null
 *  for none. */
export function tokenOf(tokens: DesignToken[], value: string, family?: TokenFamily): DesignToken | null {
  const name = named(value);
  if (name) return tokens.find((t) => t.name === name) ?? null;
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
  const each = parts(value).map((p) => tokenOf(tokens, p, family));
  if (each.length > 1 && each.every((t) => t !== null)) return { token: each.map((t) => t!.name).join(" "), value: each.map((t) => resolveValue(tokens, t!.value)).join(" ") };
  return { token: null, value: resolveValue(tokens, value) };
}

/** The first number of a value, along aliases; NaN for none. */
const numberOf = (tokens: DesignToken[], value: string) => parseFloat(/-?\d*\.?\d+/.exec(resolveValue(tokens, value))?.[0] ?? "NaN");

/** The token popover of a field whose value is `value`: the tokens of its
 *  family, first those a part of the value is (the one it names, then
 *  those of the same value), then the rest nearest to its first number,
 *  ties in the system's order. */
export function popoverTokens(tokens: DesignToken[], value: string, family: TokenFamily): DesignToken[] {
  const fam = tokens.filter((t) => t.family === family);
  const first: DesignToken[] = [];
  for (const p of parts(value)) {
    const want = norm(resolveValue(tokens, p));
    const name = named(p);
    const same = fam.filter((t) => t.name === name || norm(resolveValue(tokens, t.value)) === want);
    for (const t of same.sort((a, b) => Number(b.name === name) - Number(a.name === name))) if (!first.includes(t)) first.push(t);
  }
  const at = numberOf(tokens, parts(value)[0] ?? "");
  const rest = fam.filter((t) => !first.includes(t));
  if (!Number.isNaN(at)) {
    const d = (t: DesignToken) => Math.abs(numberOf(tokens, t.value) - at);
    rest.sort((a, b) => (Number.isNaN(d(a)) ? Infinity : d(a)) - (Number.isNaN(d(b)) ? Infinity : d(b)));
  }
  return [...first, ...rest];
}

/** What a property's value must match to be on the system: each part a
 *  token of the family (`parts`), the whole value one (`whole`), or each
 *  colour part a colour token (`colours`), as in `border`. */
type Rule = { family: TokenFamily; by: "parts" | "whole" | "colours" };

/** The properties whose values take tokens, and how. Sizes, places,
 *  display and opacity take none: they are never off-system. */
export function propRule(prop: string): Rule | null {
  if (/^(padding|margin)(-(top|right|bottom|left|inline|block)(-(start|end))?)?$/.test(prop) || /^(row-|column-)?gap$/.test(prop)) return { family: "spacing", by: "parts" };
  if (/^(color|background|background-color|border(-(top|right|bottom|left))?-color|outline-color|fill|stroke)$/.test(prop)) return { family: "color", by: "whole" };
  if (/^(border(-(top|right|bottom|left))?|outline)$/.test(prop)) return { family: "color", by: "colours" };
  if (/^border(-(top|bottom)-(left|right))?-radius$/.test(prop)) return { family: "radius", by: "parts" };
  if (prop === "box-shadow") return { family: "shadow", by: "whole" };
  if (/^(font-size|font-family|font-weight|line-height|letter-spacing)$/.test(prop)) return { family: "typography", by: "whole" };
  return null;
}

/** Values on any system: keywords that are no design choice. */
const NEUTRAL = new Set(["0", "auto", "none", "inherit", "initial", "unset", "revert", "transparent", "currentcolor", "normal"]);

/** A border's parts that are no colour: widths and styles. */
const NOT_COLOUR = /^(-?[\d.]+[a-z%]*|thin|medium|thick|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)$/;

/** The properties of an inline style whose value matches no token, where
 *  the property takes tokens: they make the element off-system. */
export function offSystem(tokens: DesignToken[], style: Decl[]): string[] {
  const on = (v: string, family: TokenFamily) => NEUTRAL.has(norm(v)) || tokenOf(tokens, v, family) !== null;
  return style
    .filter(([prop, value]) => {
      const rule = propRule(prop);
      if (!rule) return false;
      if (rule.by === "whole") return !on(value, rule.family);
      const each = parts(value).filter((p) => rule.by === "parts" || !(NEUTRAL.has(norm(p)) || NOT_COLOUR.test(norm(p))));
      return !each.every((p) => on(p, rule.family));
    })
    .map(([prop]) => prop);
}

/** A token as a style value: `var(--space-4)`. */
export const tokenRef = (name: string) => `var(${name})`;
