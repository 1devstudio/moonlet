// The settings page (X43): it opens over the sessions at General, its nav
// moves between pages, a change is kept, and Esc goes back unless a field
// or a dialog over the page has it.

import { $, browser, expect } from "@wdio/globals";
import { closeSettings, fill, openSettings, sel } from "../fixtures";

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
    await expect($(sel.navEntry("General", true))).toBeExisting();
    await expect($('//h1[normalize-space()="General"]')).toBeDisplayed();
    await expect($(sel.button("Check now"))).toBeDisplayed();
  });

  it("says a development build doesn't update itself when asked to check", async () => {
    await $(sel.button("Check now")).click();
    await expect($(sel.text("Development builds don't update themselves"))).toBeDisplayed();
    await expect($(sel.text("plugin updater not found"))).not.toBeExisting();
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

  it("asks before leaving a workspace's unsaved changes, and Discard puts them back", async () => {
    await openSettings("Personal");
    await expect($(sel.settingsField("Name"))).toHaveValue("Personal");
    await fill(sel.settingsField("Name"), "Personal stuff");
    await expect($(sel.text("Unsaved changes to Personal stuff"))).toBeDisplayed();
    // Searching keeps the edits, and opening another page from it asks.
    await fill('//input[@aria-label="Search settings"]', "gpu");
    await expect($(sel.text("1 setting matches “gpu”"))).toBeDisplayed();
    await fill('//input[@aria-label="Search settings"]', "");
    await expect($(sel.settingsField("Name"))).toHaveValue("Personal stuff");
    await $(sel.navEntry("Hosts")).click();
    await expect($(sel.text("Discard unsaved changes to Personal?"))).toBeDisplayed();
    await $(sel.confirmButton("Keep editing")).click();
    await expect($(sel.settingsField("Name"))).toHaveValue("Personal stuff");
    await $(sel.settingsButton("Discard")).click();
    await expect($(sel.settingsField("Name"))).toHaveValue("Personal");
    await $(sel.navEntry("Hosts")).click();
    await expect($(sel.navEntry("Hosts", true))).toBeExisting();
    await closeSettings();
  });

  it("finds a setting from the search, opens its page and highlights its row", async () => {
    await openSettings("General");
    await browser.execute(() =>
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "f", code: "KeyF", metaKey: true, bubbles: true, cancelable: true })),
    );
    await expect($('input[aria-label="Search settings"]')).toBeFocused();
    await fill('//input[@aria-label="Search settings"]', "tool calls");
    await expect($(sel.text("1 setting matches “tool calls”"))).toBeDisplayed();
    await expect($('//*[@role="option"][@aria-selected="true"][.//*[normalize-space()="App › Agents"]]')).toBeDisplayed();
    await browser.keys(["Enter"]);
    await expect($(sel.navEntry("Agents", true))).toBeExisting();
    await expect($('[data-setting="tool-calls"][data-flash="true"]')).toBeExisting();
    await expect($('input[aria-label="Search settings"]')).toHaveValue("");
  });

  it("says when no setting matches", async () => {
    await fill('//input[@aria-label="Search settings"]', "zebra");
    await expect($(sel.text("No settings match “zebra”"))).toBeDisplayed();
    await browser.keys(["Escape"]);
    await expect($('input[aria-label="Search settings"]')).toHaveValue("");
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
