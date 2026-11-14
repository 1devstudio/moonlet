// Settings › Agents › Claude in Chrome (X103): the switch is kept by the
// host's daemon, which starts every Claude with --chrome while it is on.

import { $, browser, expect } from "@wdio/globals";
import { closeSettings, openSettings, rpc, sel, world } from "../fixtures";

const w = world();
const chrome = sel.settingsSwitch("Claude in Chrome");

describe("Claude in Chrome", () => {
  after(() => {
    rpc(w, "claude.set_settings", { chrome: false });
  });

  it("is off until turned on, and the daemon keeps it", async () => {
    await openSettings("Agents");
    await expect($(chrome)).toHaveAttribute("aria-checked", "false");
    await $(chrome).click();
    await expect($(chrome)).toHaveAttribute("aria-checked", "true");
    await browser.waitUntil(() => rpc<{ chrome: boolean }>(w, "claude.settings", {}).chrome, { timeoutMsg: "the daemon never got chrome" });
    await closeSettings();
  });

  it("shows the daemon's setting when Settings opens again", async () => {
    await openSettings("Agents");
    await expect($(chrome)).toHaveAttribute("aria-checked", "true");
    await $(chrome).click();
    await browser.waitUntil(() => !rpc<{ chrome: boolean }>(w, "claude.settings", {}).chrome, { timeoutMsg: "the daemon never turned chrome off" });
    await closeSettings();
  });
});
