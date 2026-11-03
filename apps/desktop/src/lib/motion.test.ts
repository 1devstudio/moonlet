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
});
