// Project settings (X8) as a settings page (X43), the automated version of
// manual check M10.

import { $, browser, expect } from "@wdio/globals";
import { CONFIG, PROJECT, SESSION, closeSettings, fill, readConfig, resetConfig, sel, world, writeConfig } from "../fixtures";

const w = world();
const page = () => $(sel.settings);
const field = (label: string) => $(sel.settingsField(label));
const button = (text: string) => $(sel.settingsButton(text));
const runButton = () => $('//button[normalize-space()="Run"]');

/** No page left from an earlier test, a fresh config, the seeded session open. */
async function start(config = CONFIG) {
  if (await page().isExisting()) {
    await $('button[title="Close settings (Esc)"]').click();
    if (await $(sel.confirmButton("Discard")).isExisting()) await $(sel.confirmButton("Discard")).click();
    await expect(page()).not.toBeExisting();
  }
  resetConfig(w, config);
  await $(sel.sessionRow(SESSION)).click();
  await expect(runButton()).toBeDisplayed();
}

/** The form sits in a disabled <fieldset> until the config has loaded. The
 *  driver's isEnabled ignores the fieldset, so ask the DOM. */
const loaded = () =>
  browser.waitUntil(() => browser.execute(() => !!document.querySelector('[aria-label="Settings"] fieldset:enabled')), {
    timeoutMsg: "Project settings form never finished loading",
  });

async function openFromMoreMenu() {
  await $('button[title="More"]').click();
  await $(sel.button("Project settings…")).click();
  await expect(page()).toBeDisplayed();
  await expect($(sel.navEntry(PROJECT, true))).toBeExisting();
}

describe("Project settings", () => {
  it("opens from Run with the Run field focused when there is no run command", async () => {
    await start();
    await expect(runButton()).toHaveAttribute("title", "Set a run command…");
    await runButton().click();
    await expect(page()).toBeDisplayed();
    await expect(field("Run")).toBeFocused();
  });

  it("saves a run command, keeps the file's comments and turns Run on", async () => {
    await start();
    await runButton().click();
    await loaded();
    await fill(sel.settingsField("Run"), "echo e2e-run");
    await expect($(sel.text("Unsaved changes"))).toBeDisplayed();
    await button("Save").click();
    await expect($(sel.text("This file is part of the repository."))).toBeDisplayed();
    const text = readConfig(w);
    expect(text).toContain("# storefront scripts");
    expect(text).toContain('setup = "echo setting-up"   # install deps');
    expect(text).toContain("# fake agent for testing");
    expect(text).toContain('run = "echo e2e-run"');
    await closeSettings();
    // No session switch: the projects.changed event refreshes the button.
    await expect(runButton()).toHaveAttribute("title", "Run: echo e2e-run (⌘R)");
  });

  it("flags a built-in agent name and an unknown default agent, and blocks Save", async () => {
    await start(`${CONFIG.replace("[agents]", 'default_agent = "ghost"\n\n[agents]')}`);
    await openFromMoreMenu();
    await loaded();
    await expect($(sel.text("ghost is not an agent in this project."))).toBeDisplayed();
    await button("Add agent").click();
    // The row lays out as a 150px name and a command filling the rest.
    const name = await $('(//input[@aria-label="Agent name"])[last()]').getSize("width");
    const cmd = await $('(//input[@aria-label="Agent command"])[last()]');
    const main = $('//*[@aria-label="Settings"]//main');
    const box = (await main.getLocation("x")) + (await main.getSize("width"));
    expect(name).toBe(150);
    expect((await cmd.getLocation("x")) + (await cmd.getSize("width"))).toBeLessThan(box);
    await expect($('(//input[@aria-label="Agent name"])[last()]')).toBeFocused();
    await fill('(//input[@aria-label="Agent name"])[last()]', "claude");
    await fill('(//input[@aria-label="Agent command"])[last()]', "claude --x");
    await expect($(sel.text("claude is built in. Pick another name."))).toBeDisplayed();
    await expect($(sel.text("Fix 2 errors to save"))).toBeDisplayed();
    await expect(button("Save")).toBeDisabled();
  });

  it("asks before leaving unsaved changes, after Esc has left the field", async () => {
    await start();
    await openFromMoreMenu();
    await loaded();
    await fill(sel.settingsField("Setup"), "pnpm install");
    await browser.keys("Escape");
    await expect($(sel.confirm("Discard changes"))).not.toBeExisting();
    await browser.keys("Escape");
    await expect($(sel.confirm("Discard changes"))).toBeDisplayed();
    await expect($(sel.text("Discard unsaved changes to .moonlet/config.toml?"))).toBeDisplayed();
    await $(sel.confirmButton("Keep editing")).click();
    await expect(page()).toBeDisplayed();
    await expect(field("Setup")).toHaveValue("pnpm install");
    await $(sel.navEntry("General")).click();
    await $(sel.confirmButton("Discard")).click();
    await expect($('//h1[normalize-space()="General"]')).toBeDisplayed();
    expect(readConfig(w)).toBe(CONFIG);
  });

  it("puts the file's values back with Discard", async () => {
    await start();
    await openFromMoreMenu();
    await loaded();
    await fill(sel.settingsField("Archive"), "echo bye");
    await button("Discard").click();
    await expect(field("Archive")).toHaveValue("");
    await expect($(sel.text("This file is part of the repository."))).toBeDisplayed();
  });

  it("refuses to save over a file that changed on disk, and reloads it", async () => {
    await start();
    await openFromMoreMenu();
    await loaded();
    await fill(sel.settingsField("Archive"), "echo bye");
    writeConfig(w, `${CONFIG}# edited by hand\n`);
    await button("Save").click();
    await expect($(sel.text("The file changed on disk. Reload to see the new version."))).toBeDisplayed();
    expect(readConfig(w)).toBe(`${CONFIG}# edited by hand\n`);
    await button("Reload").click();
    await expect($(sel.text("The file changed on disk. Reload to see the new version."))).not.toBeDisplayed();
    await expect(field("Archive")).toHaveValue("");
  });

  it("shows the parse error instead of the form for invalid TOML, and checks again", async () => {
    await start("run = \n");
    await openFromMoreMenu();
    await expect($(sel.text(".moonlet/config.toml is not valid TOML"))).toBeDisplayed();
    await expect(field("Run")).not.toBeExisting();
    writeConfig(w, CONFIG);
    await button("Check again").click();
    await expect(field("Run")).toBeDisplayed();
    expect(readConfig(w)).toBe(CONFIG);
    await closeSettings();
  });
});
