// Quieter notifications (X47): the bell in the sidebar footer mutes every
// sound, and Settings › Notifications shows it and turns each banner off.

import { $, expect } from "@wdio/globals";
import { closeSettings, openSettings, sel } from "../fixtures";

const muted = sel.settingsSwitch("Mute all sounds");
const doneBanner = sel.settingsSwitch("Notification when an agent is done");
const checked = async (xpath: string) => (await $(xpath).getAttribute("aria-checked")) === "true";

describe("mute sounds", () => {
  // Settings live in the webview's storage, which outlives the scratch world.
  after(async () => {
    await openSettings("Notifications");
    if (await checked(muted)) await $(muted).click();
    if (!(await checked(doneBanner))) await $(doneBanner).click();
    await closeSettings();
  });

  it("mutes from the sidebar's bell and shows it in Settings", async () => {
    await $('button[title="Mute sounds"]').click();
    await expect($('button[title="Unmute sounds"]')).toBeDisplayed();
    await openSettings("Notifications");
    await expect($(muted)).toHaveAttribute("aria-checked", "true");
    await closeSettings();
  });

  it("unmutes from Settings, and the bell follows", async () => {
    await openSettings("Notifications");
    await $(muted).click();
    await expect($(muted)).toHaveAttribute("aria-checked", "false");
    await closeSettings();
    await expect($('button[title="Mute sounds"]')).toBeDisplayed();
  });

  it("turns the done notification off on its own", async () => {
    await openSettings("Notifications");
    await expect($(doneBanner)).toHaveAttribute("aria-checked", "true");
    await $(doneBanner).click();
    await expect($(doneBanner)).toHaveAttribute("aria-checked", "false");
    await expect($(sel.settingsSwitch("Notification when an agent needs you"))).toHaveAttribute("aria-checked", "true");
    await closeSettings();
  });
});
