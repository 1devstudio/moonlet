// Title bars move the window (X94): a press anywhere in a column's header bar
// that is not a control (its title, its text, its empty space) starts a
// window drag, while its buttons and links keep their clicks.

import { $, expect } from "@wdio/globals";
import { SESSION, closeSettings, openSettings, pressDrags, projectId, rpc, sel, world } from "../fixtures";

const w = world();

const sessionHeader = '//header[@aria-label="Session"]';
const rightHeader = '//button[normalize-space()="Run"]/parent::div';
const settingsHeader = '//div[@role="region"][@aria-label="Settings"]//main/header';

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

  it("drags the window from an archived session's name, not from its Restore button", async () => {
    const id = rpc<{ id: string }>(w, "session.create", { project_id: projectId(w), name: "Dragged away", branch: "dragged-away", agent: "none" }).id;
    rpc(w, "session.archive", { id });
    await $('//button[normalize-space()="History"]').click();
    await $('//button[normalize-space()="Dragged away"]').click();
    const header = '//div[@role="region"][@aria-label="Archived session Dragged away"]/header';
    await expect($(header)).toBeDisplayed({ wait: 10_000 });
    expect(await pressDrags(`${header}/span[normalize-space()="Dragged away"]`)).toBe(true);
    expect(await pressDrags(`${header}//button[contains(normalize-space(), "Restore")]`)).toBe(false);
    // Back from History to the session list.
    if (!(await $(sel.sessionRow(SESSION)).isExisting())) await $('//button[normalize-space()="History"]').click();
    await $(sel.sessionRow(SESSION)).waitForClickable({ timeout: 10_000 });
    await $(sel.sessionRow(SESSION)).click();
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
