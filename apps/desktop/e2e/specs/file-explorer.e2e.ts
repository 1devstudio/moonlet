// The Files tab is a file explorer with type icons and row actions; the
// Changes tab lists the changed files by folder, then shows a file's diff (X25).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { PROJECT, rpc, sel, world } from "../fixtures";

const w = world();
const NAME = "Browse the files";

const tab = (label: string) => $(`//button[@role="tab"][normalize-space()=${JSON.stringify(label)}]`);
/** An explorer row, by the entry's name. */
const row = (name: string) => `//div[@role="treeitem"][.//span[normalize-space()=${JSON.stringify(name)}]]`;
/** Clicks a row action, which only shows while the row is hovered. */
async function clickAction(rowXpath: string, title: string) {
  await browser.execute(
    (x: string, t: string) => {
      const r = document.evaluate(x, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement;
      (r.querySelector(`button[title="${t}"]`) as HTMLElement).click();
    },
    rowXpath,
    title,
  );
}

describe("File explorer and changed files", () => {
  let sessionId = "";

  before(async () => {
    const project = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!;
    const created = rpc<{ id: string; path: string }>(w, "session.create", { project_id: project.id, name: NAME, agent: "none" });
    sessionId = created.id;
    // Two changes in the worktree: a new file in a folder, and an edited one at the root.
    mkdirSync(join(created.path, "docs"));
    writeFileSync(join(created.path, "docs", "guide.md"), "# Guide\n");
    writeFileSync(join(created.path, "package.json"), '{ "name": "storefront" }\n');
    await $(sel.sessionRow(NAME)).click();
  });

  after(async () => {
    rpc(w, "session.archive", { id: sessionId });
    await expect($(sel.sessionRow(NAME))).not.toBeExisting({ wait: 30_000 });
  });

  it("shows the workspace's tree in the Files tab, with an icon per file type", async () => {
    await tab("Files").click();
    await expect($(row("docs"))).toBeDisplayed({ wait: 15_000 });
    await expect($(row("package.json"))).toBeDisplayed();
    await expect($(row("README.md"))).toBeDisplayed();
    // package.json gets the Node icon; the changed-files toggle is gone.
    await expect($(`${row("package.json")}//img[@data-icon="nodejs"]`)).toBeExisting();
    await expect($(sel.button("all files"))).not.toBeExisting();
  });

  it("expands a folder on click", async () => {
    await $(row("docs")).click();
    await expect($(row("guide.md"))).toBeDisplayed();
    await expect($(row("docs"))).toHaveAttribute("aria-expanded", "true");
  });

  it("offers Finder in a file's Open in menu", async () => {
    await clickAction(row("package.json"), "Open in…");
    await expect($(sel.text("Open in"))).toBeDisplayed();
    await expect($(sel.button("Finder"))).toBeDisplayed();
    await browser.keys("Escape");
    await expect($(sel.text("Open in"))).not.toBeExisting();
  });

  it("lists the changed files by folder in the Changes tab", async () => {
    await tab("Changes").click();
    await expect($(sel.text("2 files"))).toBeDisplayed({ wait: 15_000 });
    await expect($(sel.button("docs"))).toBeDisplayed();
    await expect($(sel.button("/"))).toBeDisplayed();
    await expect($('//div[@role="button"][@title="docs/guide.md"]')).toBeDisplayed();
  });

  it("opens a file's diff, and goes back to the list", async () => {
    await $('//div[@role="button"][@title="package.json"]').click();
    const back = $('button[aria-label="Back to the changed files"]');
    await expect(back).toBeDisplayed();
    await expect($(sel.text("2 files"))).not.toBeExisting();
    await back.click();
    await expect($(sel.text("2 files"))).toBeDisplayed();
  });
});
