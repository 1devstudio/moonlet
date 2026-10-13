// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SPLASH, splashHtml } from "./splash";

const storyboard = readFileSync(new URL("../../src-tauri/gen/apple/LaunchScreen.storyboard", import.meta.url), "utf8");
const constant = (id: string) => Number(new RegExp(`constant="(-?\\d+)" id="${id}"`).exec(storyboard)?.[1]);

describe("the splash", () => {
  it("has the iOS launch screen's layout, so launch hands over without a jump", () => {
    expect(SPLASH).toEqual({ logo: 132, lift: 36, gap: 16, name: 30, line: 36 });
    expect([constant("mLg-w0-cst"), constant("mLg-h0-cst")]).toEqual([SPLASH.logo, SPLASH.logo]);
    expect(constant("mLg-y0-cst")).toBe(-SPLASH.lift);
    expect(constant("mLb-y0-cst")).toBe(SPLASH.gap);
    expect(storyboard).toContain(`weight="semibold" pointSize="${SPLASH.name}"`);
  });

  it("is static HTML for index.html: the logo at the logo's size and the name", () => {
    const html = splashHtml('<svg viewBox="0 0 1 1"></svg>');
    expect(html).toContain('<svg width="132" height="132" viewBox="0 0 1 1"></svg>');
    expect(html).toContain("top: calc(50% - 36px)");
    expect(html).toContain("top: calc(50% - 36px + 66px + 16px)");
    expect(html).toContain(">moonlet</div>");
  });
});
