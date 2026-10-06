// Terminal > Size scales the whole app's text, not only the terminals: the
// Plan, Files, Changes and Review tabs here.

import { $, browser, expect } from "@wdio/globals";
import { SESSION, fill, sel } from "../fixtures";

const sizeField = sel.field("Size");
const tabs = ["Plan", "Files", "Changes", "Review"];

async function setFontSize(size: string) {
  await $('button[title="Settings (⌘,)"]').click();
  await fill(sizeField, size);
  await $('[role="dialog"][aria-label="Settings"] button[title="Close"]').click();
}

const tabFontSizes = () =>
  browser.execute(
    (labels: string[]) =>
      labels.map((label) => {
        const tab = document.evaluate(`//button[@role="tab"][normalize-space()="${label}"]`, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
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
    // 13px tabs (X24) at the default size.
    expect(await tabFontSizes()).toEqual(["13px", "13px", "13px", "13px"]);

    await setFontSize("19.5");
    await browser.waitUntil(async () => (await tabFontSizes())[0] === "19.5px", { timeoutMsg: "the Plan tab never grew to 19.5px" });
    expect(await tabFontSizes()).toEqual(["19.5px", "19.5px", "19.5px", "19.5px"]);
  });
});
