import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { compile } from "tailwindcss";
import { afterEach, describe, expect, it } from "vitest";
import { quietWhen } from "./motion";

const src = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(path, "utf8");
// Read from disk: Vitest hands a test an empty string for a CSS import, `?raw` too.
const motionCss = read(join(src, "styles/motion.css"));

/** A stylesheet added to the page. */
function sheet(css: string): CSSStyleSheet {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  return style.sheet!;
}

/** The app's motion rules, with an endless spinner like the app's own. Its
 *  play state is written out: jsdom computes none, where WebKit's is `running`. */
const page = (css = motionCss) =>
  sheet(`.spin { animation-name: moonlet-spin; animation-iteration-count: infinite; animation-play-state: running; }\n${css}`);

/** A tab's container holding a spinner, `hidden` as the session view hides it. */
function tabWithSpinner(hidden: boolean): HTMLElement {
  const tab = document.createElement("div");
  for (const [k, v] of Object.entries(quietWhen(hidden))) tab.setAttribute(k, v);
  const spinner = document.createElement("span");
  spinner.className = "spin";
  tab.append(spinner);
  document.body.append(tab);
  return spinner;
}

/** Every rule of a sheet, inside `@media`, `@supports`, `@layer` and nested rules too. */
function* allRules(rules: CSSRuleList): Generator<CSSRule> {
  for (const rule of rules) {
    yield rule;
    if (rule.type !== CSSRule.KEYFRAMES_RULE && "cssRules" in rule) yield* allRules((rule as CSSGroupingRule).cssRules);
  }
}

/** The source files the Vite build scans for Tailwind classes, without the tests. */
const appSources = () =>
  readdirSync(src, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => read(join(src, f)));

/** The app's stylesheet as the build makes it: `index.css` with every file it
 *  imports (Tailwind's own, `styles/*.css`), and the Tailwind animation classes
 *  (`animate-spin`) the app's sources use. */
async function appCss(): Promise<string> {
  const require = createRequire(join(src, "index.css"));
  const { build } = await compile(read(join(src, "index.css")), {
    base: src,
    loadStylesheet: async (id, base) => {
      const path = id.startsWith(".") ? resolve(base, id) : require.resolve(id === "tailwindcss" ? "tailwindcss/index.css" : id);
      return { path, base: dirname(path), content: read(path) };
    },
  });
  return build(appSources().flatMap((code) => code.match(/[^\s"'`{}]*animate-[^\s"'`{}]*/g) ?? []));
}

/** Splits at `sep` outside parentheses: `a(1, 2), b` is `a(1, 2)` and `b`. */
function splitTop(value: string, sep: string): string[] {
  const parts = [""];
  let depth = 0;
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth === 0 && (sep === " " ? /\s/.test(ch) : ch === sep)) parts.push("");
    else parts[parts.length - 1] += ch;
  }
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** A part of the `animation` shorthand that is not the keyframes' name: a time,
 *  a count, an easing, a direction, a fill mode or a play state. */
const NOT_A_NAME = /^(?:-?[\d.]+m?s|[\d.]+|infinite|linear|ease(?:-in|-out|-in-out)?|step-start|step-end|normal|reverse|alternate(?:-reverse)?|none|forwards|backwards|both|running|paused|[\w-]+\(.*\))$/;

/** The keyframes each endless animation of a rule plays, from the shorthand,
 *  whose name may sit anywhere among its parts, and from the longhands. */
function endlessIn(style: CSSStyleDeclaration, vars: Map<string, string>): string[] {
  const value = (property: string) => {
    let v = style.getPropertyValue(property);
    for (let last = ""; last !== v; ) [last, v] = [v, v.replace(/var\((--[\w-]+)\s*(?:,([^()]*))?\)/g, (_, name, fallback) => vars.get(name) ?? fallback ?? "")];
    return v;
  };
  const shorthand = splitTop(value("animation"), ",")
    .map((one) => splitTop(one, " "))
    .filter((parts) => parts.includes("infinite"))
    .map((parts) => parts.find((p) => !NOT_A_NAME.test(p)) ?? "(no name)");
  const names = splitTop(value("animation-name"), ",");
  const counts = splitTop(value("animation-iteration-count"), ",");
  // The counts repeat to match the names, as in CSS.
  const longhands = (names.length ? names : ["(no name)"]).filter((_, i) => counts.length > 0 && counts[i % counts.length] === "infinite");
  return [...shorthand, ...longhands];
}

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
});

describe("motion (X82)", () => {
  it("pauses an animation inside a hidden tab", () => {
    page();
    expect(getComputedStyle(tabWithSpinner(true)).animationPlayState).toBe("paused");
  });

  it("keeps an animation in the shown tab running", () => {
    page();
    expect(getComputedStyle(tabWithSpinner(false)).animationPlayState).toBe("running");
  });

  it("runs an endless animation once when the system asks for reduced motion", () => {
    // jsdom matches no media query: apply the reduced-motion rules as WebKit would.
    const reduced = [...page().cssRules]
      .filter((r): r is CSSMediaRule => r.type === CSSRule.MEDIA_RULE && (r as CSSMediaRule).media.mediaText === "(prefers-reduced-motion: reduce)")
      .flatMap((r) => [...r.cssRules].map((inner) => inner.cssText));
    page(reduced.join("\n"));
    expect(getComputedStyle(tabWithSpinner(false)).animationIterationCount).toBe("1");
  });

  it("animates only opacity and transform in every endless animation", async () => {
    const rules = [...allRules(sheet(await appCss()).cssRules)];
    const vars = new Map(
      rules
        .filter((r): r is CSSStyleRule => r.type === CSSRule.STYLE_RULE)
        .flatMap((r) => Array.from(r.style).filter((p) => p.startsWith("--")).map((p) => [p, r.style.getPropertyValue(p).trim()] as const)),
    );
    const endless = new Set(rules.filter((r): r is CSSStyleRule => r.type === CSSRule.STYLE_RULE).flatMap((r) => endlessIn(r.style, vars)));
    // jsdom has no CSSKeyframesRule class to narrow with.
    const keyframes = rules.filter((r) => r.type === CSSRule.KEYFRAMES_RULE) as CSSKeyframesRule[];
    // A keyframe's easing says how it moves, not what.
    const moved = (name: string) =>
      [...new Set(keyframes.filter((k) => k.name === name).flatMap((k) => [...k.cssRules].flatMap((f) => Array.from((f as CSSKeyframeRule).style))))]
        .filter((p) => p !== "animation-timing-function")
        .sort();
    // The spinners, pulses, working dots, progress bar and chat shimmer, and
    // Tailwind's `animate-spin` and `animate-pulse`.
    expect(Object.fromEntries([...endless].map((name) => [name, moved(name)]))).toEqual({
      "moonlet-spin": ["transform"],
      "moonlet-pulse": ["opacity"],
      "moonlet-indeterminate": ["transform"],
      "chat-shimmer": ["opacity"],
      spin: ["transform"],
      pulse: ["opacity"],
    });
  });
});
