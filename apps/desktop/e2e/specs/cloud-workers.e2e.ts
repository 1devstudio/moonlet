// Cloud workers (X63) in the settings: the central host's providers, its
// Tailscale client and its limits, saved to its cloud.json.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { choose, closeSettings, fill, openSettings, sel, world } from "../fixtures";

const w = world();
const cloudJson = () => {
  try {
    return JSON.parse(readFileSync(join(w.home, "cloud.json"), "utf8"));
  } catch {
    return null;
  }
};

describe("cloud workers", () => {
  after(async () => {
    if (await $(sel.settings).isExisting()) await closeSettings();
  });

  it("saving the Cloud workers settings", async () => {
    await openSettings("Cloud workers");
    await expect($(sel.text("0 of 40 machine-hours this month"))).toBeDisplayed();
    await choose('//*[@aria-label="Settings"]//select[@aria-label="Add provider"]', "fake");
    await expect($(sel.text("Fake cloud"))).toBeDisplayed();
    await fill(sel.settingsField("Remove a machine after"), "0");
    await fill(sel.settingsField("OAuth client ID"), "kD3fQx7CNTRL");
    await fill(sel.settingsField("Tag"), "tag:shop-worker");
    // The policy follows the tag before it is saved.
    await expect($(`//*[@data-setting="cloud-policy"]//pre[contains(., '"src": ["tag:shop-worker"]')]`)).toBeDisplayed();
    await $(sel.settingsButton("Save")).click();
    await browser.waitUntil(() => cloudJson()?.idle_minutes === 0, { timeoutMsg: `cloud.json never got the idle time: ${JSON.stringify(cloudJson())}` });
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
});
