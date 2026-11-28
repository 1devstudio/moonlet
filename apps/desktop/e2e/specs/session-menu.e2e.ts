// A session's right-click menu (X112): the actions that live elsewhere in
// the app, gathered in the row's own menu.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { PROJECT, fill, rightClick, rpc, sel, world } from "../fixtures";

const w = world();

describe("Session menu (X112)", () => {
  let id = "";
  let forked = "";

  before(async () => {
    const project = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!;
    id = rpc<{ id: string }>(w, "session.create", { project_id: project.id, name: "Menu row", agent: "none" }).id;
    await $(sel.sessionRow("Menu row")).waitForDisplayed();
  });

  after(() => {
    for (const s of [id, forked].filter(Boolean)) rpc(w, "session.archive", { id: s, remove_worktree: true, delete_branch: true });
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

  it("pins a session to the top from its menu, and its row starts with a pin (X119)", async () => {
    const pin = `${sel.sessionRow("Menu row renamed")}//span[@aria-label="Pinned to top"]`;
    await expect($(pin)).not.toBeExisting();
    await rightClick(sel.sessionRow("Menu row renamed"));
    await $(sel.button("Pin to top")).click();
    await expect($(pin)).toBeDisplayed({ wait: 10_000 });
    await rightClick(sel.sessionRow("Menu row renamed"));
    await $(sel.button("Unpin from top")).click();
    await expect($(pin)).not.toBeExisting({ wait: 10_000 });
  });

  it("forks a session from its menu, with its uncommitted files, and opens the fork", async () => {
    type Listed = { id: string; name: string; path: string; branch: string };
    const src = rpc<Listed[]>(w, "session.list", {}).find((s) => s.id === id)!;
    writeFileSync(join(src.path, "fork-note.md"), "not committed\n");
    await rightClick(sel.sessionRow("Menu row renamed"));
    await $(sel.button("Fork")).click();
    await expect($(`${sel.sessionRow("Menu row renamed 2")}[@aria-current="true"]`)).toBeDisplayed({ wait: 15_000 });
    const fork = rpc<Listed[]>(w, "session.list", {}).find((s) => s.name === "Menu row renamed 2")!;
    forked = fork.id;
    expect(fork.branch).not.toBe(src.branch);
    expect(existsSync(join(fork.path, "fork-note.md"))).toBe(true);
    expect(readFileSync(join(fork.path, "fork-note.md"), "utf8")).toBe("not committed\n");
  });
});
