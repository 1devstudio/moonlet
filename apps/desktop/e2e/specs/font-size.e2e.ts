// Appearance › Font size scales the whole app's text, not only the terminals: the
// right panel's views here, and More when they no longer fit (X94).

import { $, browser, expect } from "@wdio/globals";
import { SESSION, closeSettings, fill, openSettings, sel } from "../fixtures";

const sizeField = sel.settingsField("Font size");

async function setFontSize(size: string) {
  await openSettings("Appearance");
  await fill(sizeField, size);
  await closeSettings();
}

/** The font size of every view in the right panel's row, and of More when the views overflow into it (X94). */
const tabFontSizes = () =>
  browser.execute(() =>
    [...document.querySelectorAll<HTMLElement>('button[role="tab"][id^="right-tab-"], button[aria-label^="More views"]')].map((t) => getComputedStyle(t).fontSize),
  );

const allAre = (sizes: string[], size: string) => sizes.length > 0 && sizes.every((s) => s === size);

describe("font size", () => {
  before(async () => {
    await $(sel.sessionRow(SESSION)).click();
    await expect($(sel.button("Files"))).toBeDisplayed();
  });

  after(async () => {
    await setFontSize("13");
  });

  it("scales the right panel's text with the terminal font size", async () => {
    // 13px tabs (X24) at the default size.
    expect(allAre(await tabFontSizes(), "13px")).toBe(true);

    await setFontSize("19.5");
    await browser.waitUntil(async () => allAre(await tabFontSizes(), "19.5px"), { timeoutMsg: "the views never grew to 19.5px" });
  });
});
