// Settings › Keyboard shortcuts (X43): record a key for an action, move a
// key another action has after asking, put a default back, and Esc while
// recording cancels without closing the page.

import { $, browser, expect } from "@wdio/globals";
import { closeSettings, fill, openSettings, sel } from "../fixtures";

const keyButton = (action: string) => $(`button[aria-label="Shortcut for ${action}"]`);

/** Sends a key to whatever has focus, as the page's recorder sees it. */
async function press(key: string, code: string, mods: { metaKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}) {
  await browser.execute(
    (k: string, c: string, m: object) =>
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, code: c, bubbles: true, cancelable: true, ...m })),
    key,
    code,
    mods,
  );
}

describe("keyboard shortcuts page", () => {
  before(async () => {
    await openSettings("Keyboard shortcuts");
  });

  // Shortcuts live in the webview's storage, which outlives the scratch world.
  after(async () => {
    if (await $(sel.settingsButton("Reset all")).isEnabled()) {
      await $(sel.settingsButton("Reset all")).click();
      await $(sel.confirmButton("Reset all")).click();
    }
    await closeSettings();
  });

  it("records a new key for an action and marks it custom", async () => {
    await expect(keyButton("Re-run last command")).toHaveText("Not set");
    await keyButton("Re-run last command").click();
    await expect(keyButton("Re-run last command")).toHaveText("Press a shortcut…");
    await press("j", "KeyJ", { metaKey: true, shiftKey: true });
    await expect(keyButton("Re-run last command")).toHaveText("⇧⌘J");
    await expect($('button[title="Reset Re-run last command to its default"]')).toBeDisplayed();
  });

  it("refuses a reserved key and says why", async () => {
    await keyButton("Re-run last command").click();
    await press("k", "KeyK", { metaKey: true });
    await expect($(sel.text("⌘K is reserved for Run action."))).toBeDisplayed();
    await expect($('[role="dialog"][aria-label="Run action"]')).not.toBeExisting();
    await press("Escape", "Escape");
    await expect(keyButton("Re-run last command")).toHaveText("⇧⌘J");
    await expect($(sel.settings)).toBeDisplayed();
  });

  it("asks before taking a key another action uses", async () => {
    await keyButton("Re-run last command").click();
    await press("d", "KeyD", { metaKey: true });
    await expect($(sel.confirm("Shortcut in use"))).toBeDisplayed();
    await expect($(sel.text("⌘D is already used by Split pane right. Move it to Re-run last command? Split pane right will have no shortcut."))).toBeDisplayed();
    await $(sel.confirmButton("Cancel")).click();
    await expect(keyButton("Re-run last command")).toHaveText("⇧⌘J");
    await expect(keyButton("Split pane right")).toHaveText("⌘D");
  });

  it("puts the default key back", async () => {
    await $('button[title="Reset Re-run last command to its default"]').click();
    await expect(keyButton("Re-run last command")).toHaveText("Not set");
  });

  it("says New design's ⇧⌘N works in Design mode only, beside New session's (X65)", async () => {
    await expect(keyButton("New session…")).toHaveText("⇧⌘N");
    await expect(keyButton("New design…")).toHaveText("⇧⌘N");
    await expect($('[data-setting="shortcut-new-design"] [data-shortcut-mode]')).toHaveText("in Design mode");
    await expect($('[data-setting="shortcut-new-session"] [data-shortcut-mode]')).not.toBeExisting();
  });

  it("filters by key", async () => {
    await fill('//input[@aria-label="Filter shortcuts"]', "⇧⌘P");
    await expect(keyButton("Create pull request…")).toBeDisplayed();
    await expect(keyButton("Split pane right")).not.toBeExisting();
  });
});
