// Cloud workers (X63): the central host's providers, its Tailscale client
// and its limits, saved to its cloud.json; a project's cloud setting; and a
// machine from the fake provider starting and showing on the Workers page.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { PROJECT, SESSION, choose, closeSettings, daemonSock, fill, openSettings, rpc, sel, socketRpc, world } from "../fixtures";

const w = world();
const cloudJson = () => {
  try {
    return JSON.parse(readFileSync(join(w.home, "cloud.json"), "utf8"));
  } catch {
    return null;
  }
};

const allow = sel.settingsSwitch("Allow connections from my tailnet");

describe("cloud workers", () => {
  after(async () => {
    // Fake machines are scratch daemons: none outlives the spec.
    for (const m of rpc<{ machines: { id: string }[] }>(w, "cloud.machines", {}).machines) rpc(w, "cloud.down", { machine: m.id });
    // The world is shared with the specs after this one: the settings go back to their defaults.
    const keys = Object.keys(cloudJson()?.projects ?? {});
    await socketRpc(daemonSock(w), w.env, "cloud.set", {
      providers: { fake: null },
      projects: Object.fromEntries(keys.map((k) => [k, null])),
      tailscale: { client_id: "", tag: "tag:moonlet-worker" },
      idle_minutes: 15,
    });
    // Tailnet access is the daemon's setting, kept for the rest of the run: off again.
    if (await $(sel.settings).isExisting()) await closeSettings();
    await openSettings("Phones");
    if ((await $(allow).getAttribute("aria-checked")) === "true") await $(allow).click();
    await closeSettings();
  });

  it("saving the Cloud workers settings", async () => {
    await openSettings("Cloud workers");
    await expect($(sel.text("0 of 40 machine-hours this month"))).toBeDisplayed();
    await choose('//*[@aria-label="Settings"]//select[@aria-label="Add provider"]', "fake");
    await expect($(sel.text("Fake cloud"))).toBeDisplayed();
    await fill(sel.settingsField("Remove a machine after"), "30");
    await fill(sel.settingsField("OAuth client ID"), "kD3fQx7CNTRL");
    await fill(sel.settingsField("Tag"), "tag:shop-worker");
    // The policy follows the tag before it is saved.
    await expect($(`//*[@data-setting="cloud-policy"]//pre[contains(., '"src": ["tag:shop-worker"]')]`)).toBeDisplayed();
    await $(sel.settingsButton("Save")).click();
    await browser.waitUntil(() => cloudJson()?.idle_minutes === 30, { timeoutMsg: "cloud.json never got the idle time" });
    const saved = cloudJson();
    expect(saved.providers).toEqual({ fake: {} });
    expect(saved.tailscale).toEqual({ client_id: "kD3fQx7CNTRL", client_secret: "", tag: "tag:shop-worker" });
    await expect($(sel.text("No machines"))).toBeDisplayed();
    // Out of range: the field says so and Save waits.
    await fill(sel.settingsField("At most"), "0");
    await expect($(sel.text("At least 1 machine."))).toBeDisplayed();
    await expect($(sel.settingsButton("Save"))).toBeDisabled();
    await $(sel.settingsButton("Discard")).click();
    await expect($(sel.settingsField("At most"))).toHaveValue("2");
  });

  it("saving a project's cloud setting", async () => {
    if (await $(sel.settings).isExisting()) await closeSettings();
    // The test before saved the fake provider: the CLI may not change cloud settings.
    await $(sel.sessionRow(SESSION)).click();
    await $('button[title="More"]').click();
    await $(sel.button("Project settings…")).click();
    await expect($(sel.navEntry(PROJECT, true))).toBeExisting();
    await choose(sel.settingsField("Provider"), "fake");
    await fill(sel.settingsField("Location"), "here");
    await browser.waitUntil(() => $('//select[@id="project-cloud-type"]/option[@value="small"]').isExisting(), { timeoutMsg: "the fake's machine types never came" });
    await choose(sel.settingsField("Machine type"), "small");
    await fill(sel.settingsField("Image"), "none");
    await $(sel.settingsSwitch("Use cloud machines when every worker is busy")).click();
    await $(sel.settingsButton("Save")).click();
    await browser.waitUntil(() => Object.values(cloudJson()?.projects ?? {}).length === 1, { timeoutMsg: "the project's setting never reached cloud.json" });
    expect(Object.values(cloudJson().projects)).toEqual([{ overflow: true, provider: "fake", type: "small", location: "here", image: "none" }]);
  });

  it("Start a machine shows Starting, then Ready", async () => {
    // A machine pairs over the tailnet listener (here, loopback).
    await $(sel.navEntry("Phones")).click();
    if ((await $(allow).getAttribute("aria-checked")) !== "true") await $(allow).click();
    await $('//*[starts-with(normalize-space(), "Listening on 127.0.0.1:")]').waitForExist({ timeout: 15000 });
    // Creating takes 3 s, so Starting stays on screen.
    mkdirSync(w.env.MOONLET_CLOUD_FAKE, { recursive: true });
    writeFileSync(join(w.env.MOONLET_CLOUD_FAKE, "slow-create"), "3000");
    await $(sel.navEntry(PROJECT)).click();
    await browser.waitUntil(() => browser.execute(() => !!document.querySelector('[aria-label="Settings"] fieldset:enabled')), {
      timeoutMsg: "Project settings form never finished loading",
    });
    await $(sel.settingsButton("Start a machine")).click();
    const started = $(`//*[starts-with(normalize-space(), "Starting moonlet-${PROJECT}-")]`);
    await expect(started).toBeDisplayed();
    const name = (await started.getText()).replace("Starting ", "").trim();
    await expect($(sel.text(`1 machine for ${PROJECT} · 0 running commands`))).toBeDisplayed();
    await $(sel.navEntry("Workers")).click();
    const row = `//*[@data-setting="cloud-machine-${name}"]`;
    await expect($(`${row}//*[starts-with(normalize-space(), "Starting · ")]`)).toBeDisplayed();
    await expect($(sel.text("1 of 2 machines · 0 of 40 machine-hours this month · Cloud workers settings"))).toBeDisplayed();
    await $(`${row}//*[normalize-space()="Idle · removed in 30 min"]`).waitForDisplayed({ timeout: 60000, timeoutMsg: `${name} never became ready` });
    // Remove now: it goes, and stays as a line for an hour.
    await $(`${row}//button[normalize-space()="Remove now"]`).click();
    await $(`//*[starts-with(normalize-space(), "${name} removed on request · ")]`).waitForDisplayed({ timeout: 30000 });
  });
});
