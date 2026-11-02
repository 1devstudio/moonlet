// The Files tab is a file explorer with type icons and row actions; the
// Changes tab lists the changed files as a tree or a list (X28), then shows a
// file's diff in a tab of the main window, with a preview for Markdown (X77).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, $$, browser, expect } from "@wdio/globals";
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

  it("lists the changed files as a folder tree in the Changes tab", async () => {
    await tab("Changes").click();
    await expect($(sel.text("2 files changed"))).toBeDisplayed({ wait: 15_000 });
    // The view persists in localStorage, which outlives a run: start from the tree.
    const showAsTree = $('button[aria-label="Show as tree"]');
    if (await showAsTree.isExisting()) await showAsTree.click();
    await expect($(sel.button("docs"))).toBeDisplayed();
    await expect($('//div[@role="button"][@title="docs/guide.md"]')).toBeDisplayed();
    await expect($('//div[@role="button"][@title="package.json"]')).toBeDisplayed();
    // A folder collapses and expands.
    await $(sel.button("docs")).click();
    await expect($('//div[@role="button"][@title="docs/guide.md"]')).not.toBeExisting();
    await $(sel.button("docs")).click();
    await expect($('//div[@role="button"][@title="docs/guide.md"]')).toBeDisplayed();
  });

  /** A diff tab of the main window, by the file's path. */
  const diffTab = (path: string) => `//div[starts-with(@title, ${JSON.stringify(`${path} — `)})][.//button[@title="Close tab"]]`;

  /** Activates a tab. A tab takes mousedown, which the embedded driver's click does not raise. */
  const activate = (path: string) =>
    browser.execute((p: string) => {
      const t = document.evaluate(`//div[starts-with(@title, ${JSON.stringify(`${p} — `)})]`, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement;
      t.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    }, path);

  it("opens a file's diff in a tab of the main window from the keyboard", async () => {
    await browser.execute(() => (document.querySelector('div[role="button"][title="package.json"]') as HTMLElement).focus());
    await browser.keys("Enter");
    await expect($(diffTab("package.json"))).toBeDisplayed({ wait: 15_000 });
    // The right panel keeps the list.
    await expect($(sel.text("2 files changed"))).toBeDisplayed();
    await expect($('button[aria-label="Back to the changed files"]')).not.toBeExisting();
  });

  it("opens a file's diff from the keyboard with Space too", async () => {
    await browser.execute(() => (document.querySelector('div[role="button"][title="docs/guide.md"]') as HTMLElement).focus());
    await browser.keys("Space");
    await expect($(diffTab("docs/guide.md"))).toBeDisplayed({ wait: 15_000 });
  });

  it("switches to the file's diff tab when it is clicked again", async () => {
    // guide.md's tab is the active one; clicking package.json must bring its tab back, not open a second.
    await expect($(diffTab("docs/guide.md"))).toHaveAttribute("aria-current", "true");
    await $('//div[@role="button"][@title="package.json"]').click();
    await expect($(diffTab("package.json"))).toHaveAttribute("aria-current", "true");
    await expect($$(diffTab("package.json"))).toBeElementsArrayOfSize(1);
  });

  it("opens the diff of the uncommitted changes as a separate, marked tab", async () => {
    await $(sel.button("Uncommitted")).click();
    await $('//div[@role="button"][@title="package.json"]').click();
    const tabs = $$(diffTab("package.json"));
    await expect(tabs).toBeElementsArrayOfSize(2);
    await expect($(`${diffTab("package.json")}[.//span[normalize-space()="uncommitted"]]`)).toHaveAttribute("aria-current", "true");
    await $(sel.button("Against")).click();
  });

  it("previews a Markdown file's new version in its diff tab", async () => {
    await $('//div[@role="button"][@title="docs/guide.md"]').click();
    await expect($(diffTab("docs/guide.md"))).toBeDisplayed({ wait: 15_000 });
    // A file that is not Markdown has no switch.
    await activate("package.json");
    await expect($(diffTab("package.json"))).toHaveAttribute("aria-current", "true");
    await expect($(sel.button("Preview"))).not.toBeDisplayed();
    await activate("docs/guide.md");
    await expect($(diffTab("docs/guide.md"))).toHaveAttribute("aria-current", "true");
    await $(sel.button("Preview")).click();
    const frame = $('iframe[title="Markdown preview"]');
    await expect(frame).toBeDisplayed();
    expect(await frame.getAttribute("srcdoc")).toContain("<h1");
    expect(await frame.getAttribute("srcdoc")).toContain("Guide");
    await $(sel.button("Diff")).click();
    await expect(frame).not.toBeDisplayed();
  });

  it("closes the diff tabs", async () => {
    for (const path of ["docs/guide.md", "package.json", "package.json"]) {
      await browser.execute((p: string) => {
        const t = document.evaluate(`//div[starts-with(@title, "${p} — ")]//button[@title="Close tab"]`, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement;
        t.click();
      }, path);
    }
    await expect($(diffTab("docs/guide.md"))).not.toBeExisting();
    await expect($(diffTab("package.json"))).not.toBeExisting();
  });

  it("switches the changed files to a flat list and back", async () => {
    await $('button[aria-label="Show as list"]').click();
    await expect($(sel.button("docs"))).not.toBeExisting();
    const guide = '//div[@role="button"][@title="docs/guide.md"]';
    await expect($(`${guide}//span[normalize-space()="docs/"]`)).toBeDisplayed();
    await expect($(`${guide}//span[normalize-space()="guide.md"]`)).toBeDisplayed();
    // The choice survives a reload.
    await browser.refresh();
    await tab("Changes").click();
    await expect($(`${guide}//span[normalize-space()="docs/"]`)).toBeDisplayed({ wait: 15_000 });
    await $('button[aria-label="Show as tree"]').click();
    await expect($(sel.button("docs"))).toBeDisplayed();
  });
});
