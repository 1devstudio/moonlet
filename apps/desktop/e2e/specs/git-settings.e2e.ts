// Settings › Git (X55): a change is kept by the host's daemon, and the
// dialogs it names start the way it says.

import { $, browser, expect } from "@wdio/globals";
import { closeSettings, openSettings, rpc, sel, SESSION, world } from "../fixtures";

const w = world();
const drafts = sel.settingsSwitch("Open pull requests as drafts");
const prDialog = '//div[@role="dialog"][.//*[normalize-space()="Create pull request"]]';

async function press(key: string, code: string, mods: { metaKey?: boolean; shiftKey?: boolean } = {}) {
  await browser.execute(
    (k: string, c: string, m: object) =>
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, code: c, bubbles: true, cancelable: true, ...m })),
    key,
    code,
    mods,
  );
}

describe("Git settings", () => {
  after(() => {
    rpc(w, "git.set_settings", { draft_prs: false });
  });

  it("is a page of the App group", async () => {
    await openSettings("Git");
    await expect($('//h1[normalize-space()="Git"]')).toBeDisplayed();
    await expect($(sel.text("Commits and pull requests"))).toBeDisplayed();
  });

  it("keeps a change in the host's daemon", async () => {
    await expect($(drafts)).toHaveAttribute("aria-checked", "false");
    await $(drafts).click();
    await expect($(drafts)).toHaveAttribute("aria-checked", "true");
    await browser.waitUntil(() => rpc<{ draft_prs: boolean }>(w, "git.settings", {}).draft_prs, { timeoutMsg: "the daemon never got draft_prs" });
    await closeSettings();
  });

  it("starts Create pull request as a draft", async () => {
    await $(sel.sessionRow(SESSION)).click();
    await press("P", "KeyP", { metaKey: true, shiftKey: true });
    await expect($(prDialog)).toBeDisplayed();
    await expect($(`${prDialog}//label[contains(normalize-space(), "Draft")]/input`)).toBeSelected();
    await $(`${prDialog}//button[normalize-space()="Cancel"]`).click();
    await expect($(prDialog)).not.toBeExisting();
  });
});
