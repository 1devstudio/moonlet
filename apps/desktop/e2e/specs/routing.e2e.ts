// Routed commands (X62) in the settings: a project's heavy commands are
// edited and approved on its page, and the Workers page shows who runs them.

import { $, browser, expect } from "@wdio/globals";
import { CONFIG, PROJECT, SESSION, closeSettings, fill, openSettings, projectId, readConfig, resetConfig, rpc, sel, world } from "../fixtures";

const w = world();
const heavy = '//*[@data-setting="project-heavy"]';

async function openProject() {
  if (await $(sel.settings).isExisting()) {
    await $('button[title="Close settings (Esc)"]').click();
    if (await $(sel.confirmButton("Discard")).isExisting()) await $(sel.confirmButton("Discard")).click();
  }
  resetConfig(w, CONFIG);
  await $(sel.sessionRow(SESSION)).click();
  await $('button[title="More"]').click();
  await $(sel.button("Project settings…")).click();
  await expect($(sel.navEntry(PROJECT, true))).toBeExisting();
  await browser.waitUntil(() => browser.execute(() => !!document.querySelector('[aria-label="Settings"] fieldset:enabled')), {
    timeoutMsg: "Project settings form never finished loading",
  });
}

describe("routed commands", () => {
  after(async () => {
    resetConfig(w, CONFIG);
    if (await $(sel.settings).isExisting()) await closeSettings();
  });

  it("approving heavy commands saves them", async () => {
    await openProject();
    await $(`${heavy}//button[starts-with(normalize-space(), "Add command")]`).click();
    await fill(`${heavy}//input[@aria-label="Heavy command"]`, "echo heavy");
    await $(sel.settingsButton("Save")).click();
    await browser.waitUntil(() => readConfig(w).includes('[heavy]\ncommands = ["echo heavy"]'), {
      timeoutMsg: `[heavy] never reached the config: ${readConfig(w)}`,
    });
    // Saved, not approved: the banner asks.
    await expect($(sel.text("echo heavy is not approved yet"))).toBeDisplayed();
    await expect($(`${heavy}//*[normalize-space()="Not approved"]`)).toBeDisplayed();
    await $(sel.settingsButton("Approve")).click();
    // Kept in the account, so it holds on every member (X89).
    await expect($(sel.text(`Approved echo heavy for ${PROJECT} on every host of your account`))).toBeDisplayed();
    await expect($(`${heavy}//*[normalize-space()="Approved"]`)).toBeDisplayed();
    const info = rpc<{ approved: { commands: string[]; env: string[] } | null }>(w, "heavy.get", { project: projectId(w) });
    expect(info.approved).toEqual({ commands: ["echo heavy"], env: [] });
    // Saving the page again after its heavy commands were saved finds the
    // file as they left it.
    await fill(sel.settingsField("Run"), "echo after-heavy");
    await $(sel.settingsButton("Save")).click();
    await browser.waitUntil(() => readConfig(w).includes('run = "echo after-heavy"'), {
      timeoutMsg: `the second save never reached the config: ${readConfig(w)}`,
    });
    await expect($(sel.text("The file changed on disk. Reload to see the new version."))).not.toBeExisting();
  });

  it("the Workers page says when no other machine runs heavy commands", async () => {
    if (await $(sel.settings).isExisting()) await closeSettings();
    await openSettings("Workers");
    // Since X89 the rows stay, each with its switch, under a hint.
    await expect($(`//*[@data-setting="workers-hint"][normalize-space()="No host runs heavy commands for the others yet. Turn on Takes heavy commands from other hosts on a host below."]`)).toBeDisplayed();
    await expect($('//*[starts-with(@data-setting, "worker-settings-")]//button[@role="switch"][@aria-checked="false"]')).toBeDisplayed();
  });

  it("a host's switch and slots on the Workers page are saved (X89)", async () => {
    const own = () => rpc<{ worker: { enabled: boolean; slots: number } }>(w, "link.get", {}).worker;
    const line = '//*[starts-with(@data-setting, "worker-settings-")]';
    await $(`${line}//button[@role="switch"]`).click();
    await browser.waitUntil(() => own().enabled, { timeoutMsg: "the switch never reached link.json" });
    await expect($('//*[contains(normalize-space(), " takes heavy commands from your other hosts")]')).toBeDisplayed();
    await $(`${line}//button[@title="One more"]`).click();
    await browser.waitUntil(() => own().slots === 3, { timeoutMsg: `the slots never reached link.json: ${own().slots}` });
    await expect($(`${line}//*[@aria-label="Commands at once"][normalize-space()="3"]`)).toBeDisplayed();
    // As it was, for the specs after this one.
    await $(`${line}//button[@title="One fewer"]`).click();
    await $(`${line}//button[@role="switch"]`).click();
    await browser.waitUntil(() => !own().enabled && own().slots === 2, { timeoutMsg: "the settings were not put back" });
  });
});
