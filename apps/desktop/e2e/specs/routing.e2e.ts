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
    await expect($(sel.text(`Approved echo heavy for ${PROJECT} on this Mac`))).toBeDisplayed();
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
    await expect($(`//*[@data-setting="workers-empty"]//*[starts-with(normalize-space(), "Only ")][contains(normalize-space(), " runs heavy commands")]`)).toBeDisplayed();
    await $(sel.settingsButton("Open Hosts")).click();
    await expect($(sel.navEntry("Hosts", true))).toBeExisting();
  });
});
