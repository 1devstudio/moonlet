// Project settings (X8), the automated version of manual check M10.

import { $, browser, expect } from "@wdio/globals";
import { CONFIG, SESSION, fill, readConfig, resetConfig, sel, world, writeConfig } from "../fixtures";

const w = world();
const dialog = () => $(sel.dialog);
const field = (label: string) => $(sel.field(label));
const runButton = () => $('//button[normalize-space()="Run"]');

/** No dialog left from an earlier test, a fresh config, the seeded session open. */
async function start(config = CONFIG) {
  if (await dialog().isExisting()) {
    await $(`${sel.dialog} button[title="Close"]`).click();
    if (await $(sel.confirmButton("Discard")).isExisting()) await $(sel.confirmButton("Discard")).click();
    await expect(dialog()).not.toBeExisting();
  }
  resetConfig(w, config);
  await $(sel.sessionRow(SESSION)).click();
  await expect(runButton()).toBeDisplayed();
}

/** The form sits in a disabled <fieldset> until the config has loaded. The
 *  driver's isEnabled ignores the fieldset, so ask the DOM. */
const loaded = () =>
  browser.waitUntil(() => browser.execute(() => !!document.querySelector('[role="dialog"] fieldset:enabled')), {
    timeoutMsg: "Project settings form never finished loading",
  });

async function openFromMoreMenu() {
  await $('button[title="More"]').click();
  await $(sel.button("Project settings…")).click();
  await expect(dialog()).toBeDisplayed();
}

describe("Project settings", () => {
  it("opens from Run with the Run field focused when there is no run command", async () => {
    await start();
    await expect(runButton()).toHaveAttribute("title", "Set a run command…");
    await runButton().click();
    await expect(dialog()).toBeDisplayed();
    await expect(field("Run")).toBeFocused();
  });

  it("saves a run command, keeps the file's comments and turns Run on", async () => {
    await start();
    await runButton().click();
    await loaded();
    await fill(sel.field("Run"), "echo e2e-run");
    await $(sel.dialogButton("Save")).click();
    await expect(dialog()).not.toBeDisplayed();
    const text = readConfig(w);
    expect(text).toContain("# storefront scripts");
    expect(text).toContain('setup = "echo setting-up"   # install deps');
    expect(text).toContain("# fake agent for testing");
    expect(text).toContain('run = "echo e2e-run"');
    // No session switch: the projects.changed event refreshes the button.
    await expect(runButton()).toHaveAttribute("title", "Run: echo e2e-run (⌘R)");
  });

  it("flags a built-in agent name and an unknown default agent, and blocks Save", async () => {
    await start(`${CONFIG.replace("[agents]", 'default_agent = "ghost"\n\n[agents]')}`);
    await openFromMoreMenu();
    await loaded();
    await expect($(sel.text("ghost is not an agent in this project."))).toBeDisplayed();
    await $(sel.dialogButton("Add agent")).click();
    // The row lays out as a 150px name and a command filling the rest.
    const name = await $('(//input[@aria-label="Agent name"])[last()]').getSize("width");
    const cmd = await $('(//input[@aria-label="Agent command"])[last()]');
    const box = await dialog().getLocation("x") + (await dialog().getSize("width"));
    expect(name).toBe(150);
    expect((await cmd.getLocation("x")) + (await cmd.getSize("width"))).toBeLessThan(box);
    await expect($('(//input[@aria-label="Agent name"])[last()]')).toBeFocused();
    await fill('(//input[@aria-label="Agent name"])[last()]', "claude");
    await fill('(//input[@aria-label="Agent command"])[last()]', "claude --x");
    await expect($(sel.text("claude is built in. Pick another name."))).toBeDisplayed();
    await expect($(sel.dialogButton("Save"))).toBeDisabled();
  });

  it("asks before discarding unsaved changes", async () => {
    await start();
    await openFromMoreMenu();
    await loaded();
    await fill(sel.field("Setup"), "pnpm install");
    await browser.keys("Escape");
    await expect($(sel.confirm("Discard changes"))).toBeDisplayed();
    await expect($(sel.text("Discard unsaved changes to .moonlet/config.toml?"))).toBeDisplayed();
    await expect(dialog()).toBeDisplayed();
    await $(sel.confirmButton("Discard")).click();
    await expect(dialog()).not.toBeDisplayed();
    expect(readConfig(w)).toBe(CONFIG);
  });

  it("refuses to save over a file that changed on disk, and reloads it", async () => {
    await start();
    await openFromMoreMenu();
    await loaded();
    await fill(sel.field("Archive"), "echo bye");
    writeConfig(w, `${CONFIG}# edited by hand\n`);
    await $(sel.dialogButton("Save")).click();
    await expect($(sel.text("The file changed on disk. Reload to see the new version."))).toBeDisplayed();
    expect(readConfig(w)).toBe(`${CONFIG}# edited by hand\n`);
    await $(sel.dialogButton("Reload")).click();
    await expect($(sel.text("The file changed on disk. Reload to see the new version."))).not.toBeDisplayed();
    await expect(field("Archive")).toHaveValue("");
  });

  it("shows the parse error instead of the form for invalid TOML", async () => {
    await start("run = \n");
    await openFromMoreMenu();
    await expect($(sel.text(".moonlet/config.toml is not valid TOML"))).toBeDisplayed();
    await expect(field("Run")).not.toBeExisting();
    await $(sel.dialogButton("Close")).click();
    await expect(dialog()).not.toBeDisplayed();
    expect(readConfig(w)).toBe("run = \n");
  });
});
