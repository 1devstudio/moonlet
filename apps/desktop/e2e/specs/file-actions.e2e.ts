// File actions in the Files tab (X98): a right-click menu with New file,
// Rename, Duplicate, Delete and Open terminal here, and dragging a row onto
// a folder to move it. Delete goes to the world's scratch Trash
// (MOONLET_TRASH_DIR), never the user's own.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { PROJECT, fill, rpc, sel, world } from "../fixtures";

const w = world();
const NAME = "Tidy the files";

const tab = (label: string) => $(`//button[@role="tab"][normalize-space()=${JSON.stringify(label)}]`);
/** An explorer row, by the entry's name. */
const row = (name: string) => `//div[@role="treeitem"][.//span[normalize-space()=${JSON.stringify(name)}]]`;
/** An item of the open right-click menu, by its text. */
const item = (label: string) => `//div[@role="menu"][@aria-label="File actions"]//button[normalize-space()=${JSON.stringify(label)}]`;
/** An editor tab of the main window, by the file's path. */
const fileTab = (path: string) => `//div[@title=${JSON.stringify(path)}][.//button[@title="Close tab"]]`;

/** Right-clicks a row, by an XPath. */
const rightClick = (xpath: string) =>
  browser.execute((x: string) => {
    const r = document.evaluate(x, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement;
    const box = r.getBoundingClientRect();
    r.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + 20, clientY: box.top + 10 }));
  }, xpath);

/** Picks `label` in a row's right-click menu. */
async function act(name: string, label: string) {
  await rightClick(row(name));
  await $(item(label)).click();
}

describe("File actions in the Files tab (X98)", () => {
  let sessionId = "";
  let dir = "";

  before(async () => {
    const project = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!;
    const created = rpc<{ id: string; path: string }>(w, "session.create", { project_id: project.id, name: NAME, agent: "none" });
    sessionId = created.id;
    dir = created.path;
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "lib"));
    writeFileSync(join(dir, "src", "util.ts"), "export const util = 1;\n");
    writeFileSync(join(dir, "lib", "keep.txt"), "keep\n");
    await $(sel.sessionRow(NAME)).click();
    await tab("Files").click();
    await expect($(row("src"))).toBeDisplayed({ wait: 15_000 });
  });

  after(async () => {
    rpc(w, "session.archive", { id: sessionId });
    await expect($(sel.sessionRow(NAME))).not.toBeExisting({ wait: 30_000 });
  });

  it("shows a folder's actions on right-click", async () => {
    await rightClick(row("src"));
    for (const label of ["New file", "New folder", "Rename", "Duplicate", "Open terminal here", "Delete"]) await expect($(item(label))).toBeDisplayed();
    await browser.keys("Escape");
    await expect($(item("Rename"))).not.toBeExisting();
  });

  it("creates a file in a folder and opens it", async () => {
    await act("src", "New file");
    await fill('//input[@aria-label="New file name"]', "notes.md");
    await browser.keys("Enter");
    await expect($(row("notes.md"))).toBeDisplayed({ wait: 15_000 });
    expect(readFileSync(join(dir, "src", "notes.md"), "utf8")).toBe("");
    await expect($(fileTab(join(dir, "src", "notes.md")))).toBeDisplayed();
  });

  it("renames a file in place, and its editor tab follows", async () => {
    await act("notes.md", "Rename");
    const field = '//input[@aria-label="Rename notes.md"]';
    // The name is selected up to its extension.
    expect(await browser.execute(() => {
      const i = document.activeElement as HTMLInputElement;
      return [i.selectionStart, i.selectionEnd];
    })).toEqual([0, 5]);
    await fill(field, "guide.md");
    await browser.keys("Enter");
    await expect($(row("guide.md"))).toBeDisplayed({ wait: 15_000 });
    expect(existsSync(join(dir, "src", "notes.md"))).toBe(false);
    expect(existsSync(join(dir, "src", "guide.md"))).toBe(true);
    await expect($(fileTab(join(dir, "src", "guide.md")))).toBeDisplayed();
    await expect($(fileTab(join(dir, "src", "notes.md")))).not.toBeExisting();
  });

  it("duplicates a file next to it as a copy, and starts renaming the copy", async () => {
    await act("util.ts", "Duplicate");
    await expect($('//input[@aria-label="Rename util copy.ts"]')).toBeDisplayed({ wait: 15_000 });
    await browser.keys("Escape");
    await expect($(row("util copy.ts"))).toBeDisplayed();
    expect(readFileSync(join(dir, "src", "util copy.ts"), "utf8")).toBe("export const util = 1;\n");
  });

  it("moves a file dragged onto a folder", async () => {
    await browser.execute(
      (from: string, to: string) => {
        const find = (x: string) => document.evaluate(x, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement;
        const data = new DataTransfer();
        find(from).dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: data }));
        const folder = find(to);
        folder.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data }));
        folder.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
      },
      row("util copy.ts"),
      row("lib"),
    );
    await browser.waitUntil(() => existsSync(join(dir, "lib", "util copy.ts")), { timeout: 10_000, timeoutMsg: "util copy.ts not moved into lib" });
    expect(existsSync(join(dir, "src", "util copy.ts"))).toBe(false);
    await expect($(row("util copy.ts"))).not.toBeExisting({ wait: 15_000 });
  });

  it("moves a deleted file to the Trash after asking, and closes its tab", async () => {
    await act("guide.md", "Delete");
    await expect($(sel.confirm("Delete file"))).toBeDisplayed();
    await expect($(sel.text("Move guide.md to the Trash?"))).toBeDisplayed();
    await $(sel.confirmButton("Move to Trash")).click();
    await expect($(row("guide.md"))).not.toBeExisting({ wait: 15_000 });
    expect(existsSync(join(dir, "src", "guide.md"))).toBe(false);
    expect(readdirSync(w.env.MOONLET_TRASH_DIR)).toContain("guide.md");
    await expect($(fileTab(join(dir, "src", "guide.md")))).not.toBeExisting();
  });

  it("opens a terminal tab in a folder", async () => {
    const shells = () => rpc<{ session_id?: string; kind: string; cwd: string }[]>(w, "terminal.list", {}).filter((t) => t.session_id === sessionId && t.kind === "shell");
    await act("lib", "Open terminal here");
    await browser.waitUntil(() => shells().some((t) => t.cwd === join(dir, "lib")), { timeout: 15_000, timeoutMsg: JSON.stringify(shells()) });
  });
});
