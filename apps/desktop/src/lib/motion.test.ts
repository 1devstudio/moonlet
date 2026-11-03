import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { quietWhen } from "./motion";

// Read from disk: Vitest hands a test an empty string for a CSS import, `?raw` too.
const styles = (file: string) => readFileSync(join(import.meta.dirname, "../styles", file), "utf8");
const motionCss = styles("motion.css");

/** The app's motion rules, with an endless spinner like the app's own. */
function page(css = motionCss) {
  const style = document.createElement("style");
  style.textContent = `.spin { animation-name: moonlet-spin; animation-iteration-count: infinite; }\n${css}`;
  document.head.append(style);
  return style;
}

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
    expect(getComputedStyle(tabWithSpinner(false)).animationPlayState).not.toBe("paused");
  });

  it("runs an endless animation once when the system asks for reduced motion", () => {
    // jsdom matches no media query: apply the reduced-motion rules as WebKit would.
    const reduced = [...page().sheet!.cssRules]
      .filter((r): r is CSSMediaRule => r.type === 4 && (r as CSSMediaRule).media.mediaText === "(prefers-reduced-motion: reduce)")
      .flatMap((r) => [...r.cssRules].map((inner) => inner.cssText));
    page(reduced.join("\n"));
    expect(getComputedStyle(tabWithSpinner(false)).animationIterationCount).toBe("1");
  });

  it("animates only opacity and transform in every endless animation", () => {
    const sheet = page(styles("moonlet.css")).sheet!;
    const rules = [...sheet.cssRules];
    const endless = rules
      .filter((r): r is CSSStyleRule => r instanceof CSSStyleRule)
      .map((r) => r.style.getPropertyValue("animation"))
      .filter((a) => /\binfinite\b/.test(a))
      .map((a) => a.split(/\s+/)[0]);
    // The spinners, pulses, working dots, progress bar and chat shimmer.
    expect(new Set(endless)).toEqual(new Set(["moonlet-spin", "moonlet-pulse", "moonlet-indeterminate", "chat-shimmer"]));
    const moved = rules
      // jsdom has no CSSKeyframesRule class; 7 is CSSRule.KEYFRAMES_RULE.
      .filter((r): r is CSSKeyframesRule => r.type === 7 && endless.includes((r as CSSKeyframesRule).name))
      .flatMap((r) => [...r.cssRules].flatMap((k) => Array.from((k as CSSKeyframeRule).style)));
    expect(new Set(moved)).toEqual(new Set(["opacity", "transform"]));
  });
});
