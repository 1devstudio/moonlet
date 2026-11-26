// A session's right-click menu (X112): the actions that live elsewhere in
// the app, gathered in the row's own menu.

import { $, browser, expect } from "@wdio/globals";
import { PROJECT, fill, rightClick, rpc, sel, world } from "../fixtures";

const w = world();

describe("Session menu (X112)", () => {
  let id = "";

  before(async () => {
    const project = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!;
    id = rpc<{ id: string }>(w, "session.create", { project_id: project.id, name: "Menu row", agent: "none" }).id;
    await $(sel.sessionRow("Menu row")).waitForDisplayed();
  });

  after(() => {
    rpc(w, "session.archive", { id, remove_worktree: true, delete_branch: true });
  });

  it("lists the session's actions", async () => {
    await rightClick(sel.sessionRow("Menu row"));
    for (const label of ["Open", "Open in", "Rename", "Move to workspace", "Archive"]) await expect($(sel.button(label))).toBeDisplayed();
    // No PR yet, and no agent tab to mark unread.
    await expect($(sel.button("Open PR"))).not.toBeExisting();
    await expect($(sel.button("Mark as unread"))).not.toBeExisting();
    await browser.keys("Escape");
    await expect($(sel.button("Rename"))).not.toBeExisting();
  });

  it("renames a session from its menu", async () => {
    await rightClick(sel.sessionRow("Menu row"));
    await $(sel.button("Rename")).click();
    const input = '//aside//input[@value="Menu row"]';
    await $(input).waitForDisplayed();
    await fill(input, "Menu row renamed");
    await browser.keys("Enter");
    await expect($(sel.sessionRow("Menu row renamed"))).toBeDisplayed();
    await browser.waitUntil(() => rpc<{ id: string; name: string }[]>(w, "session.list", {}).find((s) => s.id === id)?.name === "Menu row renamed", {
      timeoutMsg: "the daemon kept the old name",
    });
  });
});
