// Terminal > Size scales the whole app's text, not only the terminals: the
// Files, Changes and Review tabs here.

import { $, browser, expect } from "@wdio/globals";
import { SESSION, fill, sel } from "../fixtures";

const sizeField = sel.field("Size");
const tabs = ["Files", "Changes", "Review"];

async function setFontSize(size: string) {
  await $('button[title="Settings (⌘,)"]').click();
  await fill(sizeField, size);
  await $('[role="dialog"][aria-label="Settings"] button[title="Close"]').click();
}

const tabFontSizes = () =>
  browser.execute(
    (labels: string[]) =>
      labels.map((label) => {
        const tab = document.evaluate(`//button[normalize-space()="${label}"]`, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        return tab instanceof HTMLElement ? getComputedStyle(tab).fontSize : null;
      }),
    tabs,
  );

describe("font size", () => {
  before(async () => {
    await $(sel.sessionRow(SESSION)).click();
    await expect($(sel.button("Files"))).toBeDisplayed();
  });

  after(async () => {
    await setFontSize("13");
  });

  it("scales the right panel's text with the terminal font size", async () => {
    expect(await tabFontSizes()).toEqual(["14px", "14px", "14px"]);

    await setFontSize("19.5");
    await browser.waitUntil(async () => (await tabFontSizes())[0] === "21px", { timeoutMsg: "the Files tab never grew to 21px" });
    expect(await tabFontSizes()).toEqual(["21px", "21px", "21px"]);
  });
});
