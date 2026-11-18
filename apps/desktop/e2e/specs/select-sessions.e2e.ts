// Select several sessions (X106): ⌘-click and ⇧-click rows in the sidebar,
// then act on all of them from the selection bar or the right-click menu.

import { $, browser, expect } from "@wdio/globals";
import { PROJECT, rightClick, rpc, sel, world } from "../fixtures";

const w = world();
const NAMES = ["Pick one", "Pick two", "Pick three"];
const bar = (count: string) => `//div[@role="toolbar"][@aria-label=${JSON.stringify(count)}]`;
const picked = (name: string) => `${sel.sessionRow(name)}[@aria-selected="true"]`;

/** Clicks the row at `xpath` with ⌘ or ⇧ held: the embedded driver sends no
 *  modifiers with a click, so it gets the click event a held key gives. */
async function modClick(xpath: string, keys: { metaKey?: boolean; shiftKey?: boolean }) {
  await browser.execute(
    (xp: string, k: { metaKey?: boolean; shiftKey?: boolean }) => {
      const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement;
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...k }));
    },
    xpath,
    keys,
  );
}

describe("Select several sessions (X106)", () => {
  const ids: Record<string, string> = {};
  let acme: { id: string } | undefined;
  let client: { id: string } | undefined;

  before(async () => {
    const project = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!;
    for (const name of NAMES) ids[name] = rpc<{ id: string }>(w, "session.create", { project_id: project.id, name, agent: "none" }).id;
    for (const name of NAMES) await $(sel.sessionRow(name)).waitForDisplayed();
  });

  after(() => {
    // What is left is archived, so the workspace can go (X32).
    for (const id of Object.values(ids)) {
      try {
        rpc(w, "session.archive", { id, remove_worktree: true, delete_branch: true });
      } catch {
        // Archived by the spec already.
      }
    }
    if (client) rpc(w, "section.delete", { id: client.id });
    if (acme) rpc(w, "workspace.delete", { id: acme.id });
  });

  it("⌘-click picks rows without opening them, and Esc clears them", async () => {
    // Pick two is open; ⌘-clicking the others leaves it open.
    await $(sel.sessionRow("Pick two")).click();
    await expect($(`${sel.sessionRow("Pick two")}[@aria-current="true"]`)).toBeExisting();
    await modClick(sel.sessionRow("Pick one"), { metaKey: true });
    await modClick(sel.sessionRow("Pick three"), { metaKey: true });
    await expect($(bar("2 selected"))).toBeDisplayed();
    await expect($(`${sel.sessionRow("Pick two")}[@aria-current="true"]`)).toBeExisting();
    await expect($(`${sel.sessionRow("Pick one")}[@aria-current="true"]`)).not.toBeExisting();
    await expect($(picked("Pick one"))).toBeExisting();
    await expect($(picked("Pick three"))).toBeExisting();
    await expect($(picked("Pick two"))).not.toBeExisting();
    // A row not picked still shows its box, unticked.
    await expect($(`${sel.sessionRow("Pick two")}[@aria-selected="false"]`)).toBeExisting();

    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
    await browser.keys("Escape");
    await expect($(bar("2 selected"))).not.toBeExisting();
    await expect($(picked("Pick one"))).not.toBeExisting();
  });

  it("⇧-click picks the range from the last click", async () => {
    await modClick(sel.sessionRow("Pick one"), { metaKey: true });
    await modClick(sel.sessionRow("Pick three"), { shiftKey: true });
    // Newest first in the sidebar: Pick three, Pick two, Pick one.
    for (const name of NAMES) await expect($(picked(name))).toBeExisting();
    await expect($(bar("3 selected"))).toBeDisplayed();
    // ✕ clears them too.
    await $(`${bar("3 selected")}//button[@title="Clear selection (Esc)"]`).click();
    await expect($(bar("3 selected"))).not.toBeExisting();
  });

  it("the right-click menu of a picked row acts on all of them", async () => {
    await modClick(sel.sessionRow("Pick one"), { metaKey: true });
    await modClick(sel.sessionRow("Pick two"), { metaKey: true });
    await rightClick(sel.sessionRow("Pick two"));
    await expect($(sel.text("2 sessions"))).toBeDisplayed();
    await expect($(sel.button("Mark as read"))).toBeDisplayed();
    await expect($(sel.button("Archive 2 sessions"))).toBeDisplayed();
    // Esc closes the menu and keeps the picks.
    await browser.keys("Escape");
    await expect($(sel.button("Archive 2 sessions"))).not.toBeExisting();
    await $(`${bar("2 selected")}//button[@title="Clear selection (Esc)"]`).click();
  });

  it("moves picked sessions to another workspace from the bar", async () => {
    acme = rpc<{ id: string }>(w, "workspace.create", { name: "Acme client", color: "blue" });
    client = rpc<{ id: string }>(w, "section.create", { workspace_id: acme.id, name: "Client" });
    rpc(w, "section.add_project", { id: client.id, path: w.repo });

    await modClick(sel.sessionRow("Pick three"), { metaKey: true });
    await $(`${bar("1 selected")}//button[starts-with(normalize-space(), "Move to")]`).click();
    // The item's text starts with the workspace mark's letter.
    await $('//button[.//span[normalize-space()="Acme client"]]').click();

    await expect($(sel.sessionRow("Pick three"))).not.toBeExisting({ wait: 10_000 });
    const moved = rpc<{ id: string; workspace_id: string }[]>(w, "session.list", {}).find((s) => s.id === ids["Pick three"]);
    expect(moved?.workspace_id).toBe(acme.id);
    await expect($(bar("1 selected"))).not.toBeExisting();
  });

  it("archives the picked sessions after one confirm", async () => {
    await modClick(sel.sessionRow("Pick one"), { metaKey: true });
    await modClick(sel.sessionRow("Pick two"), { metaKey: true });
    await $(`${bar("2 selected")}//button[normalize-space()="Archive"]`).click();
    await expect($(sel.confirm("Archive 2 sessions"))).toBeDisplayed();
    await expect($(`${sel.confirm("Archive 2 sessions")}//ul[@aria-label="Sessions"]//*[normalize-space()="Pick one"]`)).toBeDisplayed();
    // Enabled once each host said what would be lost (X55).
    await expect($(sel.confirmButton("Archive 2"))).toBeEnabled();
    await $(sel.confirmButton("Archive 2")).click();

    await expect($(sel.sessionRow("Pick one"))).not.toBeExisting({ wait: 15_000 });
    await expect($(sel.sessionRow("Pick two"))).not.toBeExisting({ wait: 15_000 });
    await expect($(bar("2 selected"))).not.toBeExisting();
  });
});
