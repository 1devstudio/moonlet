// The settings page (X43): it opens over the sessions at General, its nav
// moves between pages, a change is kept, and Esc goes back unless a field
// or a dialog over the page has it.

import { $, browser, expect } from "@wdio/globals";
import { closeSettings, openSettings, sel } from "../fixtures";

const meta = sel.settingsSwitch("Use Option as Meta");
const checked = async (xpath: string) => (await $(xpath).getAttribute("aria-checked")) === "true";

describe("settings page", () => {
  // Settings live in the webview's storage, which outlives the scratch world.
  after(async () => {
    await openSettings("Terminal");
    if (!(await checked(meta))) await $(meta).click();
    await openSettings("Agents");
    await $(sel.settingsOption("Default permission mode", "Manual")).click();
    await closeSettings();
  });

  it("opens at General from the sidebar's gear", async () => {
    await $('button[title="Settings (⌘,)"]').click();
    await expect($(sel.settings)).toBeDisplayed();
    await expect($('//nav[@aria-label="Settings"]//button[@aria-current="page"][normalize-space()="General"]')).toBeExisting();
    await expect($('//h1[normalize-space()="General"]')).toBeDisplayed();
    await expect($(sel.button("Check now"))).toBeDisplayed();
  });

  it("goes back to the sessions with Esc", async () => {
    await browser.keys(["Escape"]);
    await expect($(sel.settings)).not.toBeExisting();
  });

  it("leaves a text field with Esc before closing", async () => {
    await openSettings("Terminal");
    await $(sel.settingsField("Font family")).click();
    await browser.keys(["Escape"]);
    await expect($(sel.settings)).toBeDisplayed();
    await browser.keys(["Escape"]);
    await expect($(sel.settings)).not.toBeExisting();
  });

  it("closes only the sign-in dialog with Esc, not the page under it", async () => {
    await openSettings("Profiles");
    await $(sel.button("Sign in…")).click();
    const signIn = '[role="dialog"][aria-label="Sign in: Default profile"]';
    await expect($(signIn)).toBeDisplayed();
    await browser.keys(["Escape"]);
    await expect($(signIn)).not.toBeExisting();
    await expect($(sel.settings)).toBeDisplayed();
    await closeSettings();
  });

  it("keeps a switched-off terminal setting", async () => {
    await openSettings("Terminal");
    if (await checked(meta)) await $(meta).click();
    await expect($(meta)).toHaveAttribute("aria-checked", "false");
    await closeSettings();

    await openSettings("Terminal");
    await expect($(meta)).toHaveAttribute("aria-checked", "false");
    await closeSettings();
  });

  it("keeps the default permission mode picked from the list", async () => {
    await openSettings("Agents");
    await $(sel.settingsOption("Default permission mode", "Plan")).click();
    await closeSettings();

    await openSettings("Agents");
    await expect($(sel.settingsOption("Default permission mode", "Plan"))).toHaveAttribute("aria-checked", "true");
    await closeSettings();
  });
});
