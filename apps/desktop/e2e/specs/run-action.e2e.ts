// The Run action modal (X19): ⌘K, filtering, and custom shortcuts that work
// as soon as they are set.

import { $, browser, expect } from "@wdio/globals";
import { fill, sel } from "../fixtures";

const dialog = () => $('[role="dialog"][aria-label="Run action"]');
const query = '//div[@role="dialog"][@aria-label="Run action"]//input';
/** An action's row, by its full label. */
const row = (label: string) => $(`//div[@data-row][.//span[normalize-space()=${JSON.stringify(label)}]]`);

/** Sends a key to whatever has focus, as the app's shortcuts see it. */
async function press(key: string, code: string, mods: { metaKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}) {
  await browser.execute(
    (k: string, c: string, m: object) =>
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, code: c, bubbles: true, cancelable: true, ...m })),
    key,
    code,
    mods,
  );
}

async function open() {
  if (!(await dialog().isExisting())) await press("k", "KeyK", { metaKey: true });
  await expect(dialog()).toBeDisplayed();
}

async function close() {
  await press("Escape", "Escape");
  await expect(dialog()).not.toBeExisting();
}

describe("Run action", () => {
  it("opens with ⌘K and lists every action", async () => {
    await open();
    await expect($(sel.text("24 actions"))).toBeDisplayed();
    await expect($(query)).toBeFocused();
    await close();
  });

  it("opens from the sidebar", async () => {
    await $(sel.button("Run action")).click();
    await expect(dialog()).toBeDisplayed();
    await close();
  });

  it("filters by the typed letters", async () => {
    await open();
    await fill(query, "set");
    await expect($(sel.text("6 of 24"))).toBeDisplayed();
    await expect(row("Re-run setup script")).toBeDisplayed();
    await fill(query, "deploy");
    await expect($(sel.text("No actions match “deploy”."))).toBeDisplayed();
    await close();
  });

  it("sets a shortcut that runs the action at once", async () => {
    await open();
    await fill(query, "show archived");
    await press("Enter", "Enter", { altKey: true });
    await expect($(sel.text("Press keys…"))).toBeDisplayed();
    await press("c", "KeyC", { metaKey: true });
    await expect($(sel.text("⌘C is reserved for Copy."))).toBeDisplayed();
    await press("˙", "KeyH", { metaKey: true, altKey: true });
    await expect($(sel.text("⌥⌘H now runs Show archived sessions"))).toBeDisplayed();
    await expect(row("Show archived sessions").$(".//kbd")).toHaveText("⌥⌘H");
    await close();

    await press("˙", "KeyH", { metaKey: true, altKey: true });
    await expect($(sel.text("Archived sessions"))).toBeDisplayed();
    await $(sel.button("History")).click();
  });

  it("asks before taking a key from another action, then moves it", async () => {
    await open();
    await fill(query, "commit…");
    await $(`//div[@data-row][.//span[normalize-space()="Commit…"]]//button[normalize-space()="Set shortcut"]`).click();
    await press("t", "KeyT", { metaKey: true });
    await expect($(sel.text("⌘T is already used by New terminal tab."))).toBeDisplayed();
    await $(sel.button("Replace")).click();
    await expect($(sel.text("⌘T now runs Commit"))).toBeDisplayed();

    // Give ⌘T back, so other specs keep the default.
    await fill(query, "new terminal tab");
    await expect(row("New terminal tab").$('.//button[normalize-space()="Set shortcut"]')).toBeDisplayed();
    await press("Enter", "Enter", { altKey: true });
    await press("t", "KeyT", { metaKey: true });
    await expect($(sel.text("⌘T is already used by Commit."))).toBeDisplayed();
    await press("Enter", "Enter");
    await expect(row("New terminal tab").$(".//kbd")).toHaveText("⌘T");
    await close();
  });
});
