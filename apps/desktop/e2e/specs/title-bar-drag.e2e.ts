// Title bars move the window: a press anywhere in a column's header bar that
// is not a control (its title, its text, its empty space) starts a window
// drag, while its buttons and links keep their clicks.
//
// Tauri's drag script claims a press it turns into a window drag: it calls
// preventDefault() on the mousedown, so dispatchEvent() returns false.

import { $, browser, expect } from "@wdio/globals";
import { SESSION, closeSettings, openSettings, sel } from "../fixtures";

const sessionHeader = '//header[@aria-label="Session"]';
const rightHeader = '//button[normalize-space()="Run"]/parent::div';
const settingsHeader = '//div[@role="region"][@aria-label="Settings"]//main/header';

/** Presses the left button on the element at `xpath`'s centre: true when the
 *  press starts a window drag. */
const pressDrags = (xpath: string) =>
  browser.execute((x: string) => {
    const e = document.evaluate(x, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement | null;
    if (!e) throw new Error(`no element at ${x}`);
    const r = e.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, composed: true, button: 0, detail: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    const claimed = !e.dispatchEvent(new MouseEvent("mousedown", at));
    e.dispatchEvent(new MouseEvent("mouseup", at));
    return claimed;
  }, xpath) as Promise<boolean>;

describe("title bars move the window", () => {
  before(async () => {
    await $(sel.sessionRow(SESSION)).click();
    await expect($(sessionHeader)).toBeDisplayed({ wait: 10_000 });
  });

  it("drags the window from the session's name and branch in its header", async () => {
    expect(await pressDrags(`${sessionHeader}//h1`)).toBe(true);
    expect(await pressDrags(`${sessionHeader}/span`)).toBe(true);
    expect(await pressDrags(sessionHeader)).toBe(true);
  });

  it("drags the window from the empty space in the right panel's header, not from its Run button", async () => {
    expect(await pressDrags(`${rightHeader}/span[contains(@class, "ml-auto")]`)).toBe(true);
    expect(await pressDrags(`${rightHeader}/button[normalize-space()="Run"]`)).toBe(false);
    expect(await pressDrags(`${rightHeader}/button[normalize-space()="Run"]/span`)).toBe(false);
  });

  it("closes an open title bar menu on a press outside it, without dragging the window", async () => {
    await $('button[title="More"]').click();
    await expect($(sel.button("Toggle sidebar"))).toBeDisplayed();
    const backdrop = `${rightHeader}//div[contains(@class, "fixed") and contains(@class, "inset-0")]`;
    expect(await pressDrags(backdrop)).toBe(false);
    await $(backdrop).click();
    await expect($(sel.button("Toggle sidebar"))).not.toBeExisting();

    // The workspace switcher's menu: neither its backdrop nor its heading moves the window.
    await $('button[aria-label^="Switch workspace"]').click();
    const menu = '//div[@role="menu"][@aria-label="Workspaces"]';
    await expect($(menu)).toBeDisplayed();
    expect(await pressDrags(`${menu}/div[1]`)).toBe(false);
    expect(await pressDrags(`${menu}/preceding-sibling::div[1]`)).toBe(false);
    await expect($(menu)).not.toBeExisting();
  });

  it("drags the window from the settings page's breadcrumb, not from its close button", async () => {
    await openSettings("Appearance");
    try {
      expect(await pressDrags(`${settingsHeader}/span[1]`)).toBe(true);
      expect(await pressDrags(`${settingsHeader}//button[@title="Close settings (Esc)"]`)).toBe(false);
    } finally {
      await closeSettings();
    }
  });
});
