// The visual editor's structure (X65 entry 9): Edit mode (V), selecting an
// element from the Layers tab and the breadcrumb, Delete, ⌘D and ⌥⌘G on the
// selection, undo, the page file on disk after each, the edits by hand chip
// and the message they go before, and the yellow bar for a save that raced
// a change on disk.
//
// WebDriver cannot click inside the page, a sandboxed frame on another host
// in its own web process (design-comments.e2e.ts), so the selection is made
// from the app's Layers tab and breadcrumb, and the keys are sent to the
// app, which makes the edit on the page's source and saves it. The tree in
// Layers is the bridge's report when the page loads; WebKit suspends a
// hidden window's frames about 2 s after they load, so it is read once, at
// load, and the edits never wait on the frame.

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { diskShows, press, within } from "../design";
import { fill, rpc, sel, world } from "../fixtures";

const w = world();
const FAKE = join(w.root, "bin", "claude");
const workspaceId = () => rpc<{ id: string }[]>(w, "workspace.list", {})[0].id;
const mode = (label: string) => $(`//div[@role="group"][@aria-label="Mode"]/button[starts-with(@aria-label, "${label}")]`);
const SYSTEM = "editor-kit";
const dir = () => join(w.home, "design", workspaceId(), "designs", "settings-page");
const file = () => join(dir(), "pages", "index.html");
const onDisk = () => readFileSync(file(), "utf8");
const PAGE = [
  "<!doctype html>",
  `<html><head><meta charset="utf-8"><link rel="stylesheet" href="../../../systems/${SYSTEM}/styles.css"></head>`,
  '<body data-mid="m1">',
  '<main data-mid="m20">',
  '  <section data-mid="m22"><h2 data-mid="m23">General</h2></section>',
  '  <section data-mid="m24"><h2 data-mid="m25">Git</h2>',
  '    <p data-mid="m30">Branch prefix</p>',
  "  </section>",
  "</main>",
  "</body></html>",
  "",
].join("\n");
const chat = () => $('//section[@aria-label="Design · Settings page"]');
const rail = () => $('//aside[@aria-label="Right rail"]');
const layer = (name: string) => rail().$(`.//button[@role="treeitem"][@aria-label="${name}"]`);
const crumbs = () => $('//nav[@aria-label="Selection"]');
const canvasMode = () => $('//div[@aria-label="Canvas mode"]/button[@aria-pressed="true"]');
const COMPOSER = '//section[@aria-label="Design · Settings page"]//textarea';

// A design agent that ends each turn with a short answer, as in
// design-comments.e2e.ts.
const ANSWERING_CLAUDE = String.raw`#!/bin/sh
out() { printf '%s\n' "$1"; }
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) out '{"type":"system","subtype":"init","session_id":"e2e-editor","model":"e2e-model","permissionMode":"acceptEdits","slash_commands":[]}' ;;
    *'"type":"user"'*)
      out '{"type":"assistant","message":{"id":"a1","content":[{"type":"text","text":"Noted."}]}}'
      out '{"type":"result","subtype":"success","is_error":false,"usage":{}}' ;;
  esac
done
`;

describe("The visual editor", () => {
  let fake = "";
  before(async () => {
    fake = readFileSync(FAKE, "utf8");
    writeFileSync(FAKE, ANSWERING_CLAUDE);
    chmodSync(FAKE, 0o755);
    const ws = workspaceId();
    rpc(w, "design.system.create", { workspace: ws, name: "Editor kit", sources: [], agent: false });
    writeFileSync(join(w.home, "design", ws, "systems", SYSTEM, "styles.css"), "h2 { color: #d97757; }\n");
    rpc(w, "design.create", { workspace: ws, name: "Settings page", system: SYSTEM, brief: "A settings page" });
    writeFileSync(file(), PAGE);
    await mode("Design").click();
    await $('//nav[@aria-label="Designs"]//button[.//span[normalize-space()="Settings page"]]').click();
    await expect(chat()).toBeDisplayed();
    await expect($('//iframe[@title="index.html"]')).toBeExisting();
  });

  after(async () => {
    writeFileSync(FAKE, fake);
    for (const d of rpc<{ slug: string }[]>(w, "design.list", { workspace: workspaceId() })) rpc(w, "design.remove", { workspace: workspaceId(), slug: d.slug });
    rpc(w, "design.system.remove", { workspace: workspaceId(), slug: SYSTEM });
    await within(5_000, (async () => {
      if (await mode("Sessions").isExisting()) await mode("Sessions").click();
    })());
  });

  it("switches to Edit mode with V, which the hint line explains, folding the chat and showing the page's elements in Layers", async () => {
    await press("v");
    await expect(canvasMode()).toHaveText(expect.stringContaining("Edit"));
    await expect($(sel.text("Click selects · double-click edits text · Esc selects the parent · Tab the next sibling"))).toBeDisplayed();
    await expect(chat()).not.toBeExisting();
    await expect(rail().$('.//button[@role="tab"][@aria-selected="true"]')).toHaveText("Layers");
    await expect(layer("section m24")).toBeDisplayed();
    await expect(layer("p m30")).toHaveText(expect.stringContaining("Branch prefix"));
  });

  it("selects an element from Layers, with its ancestors in the breadcrumb, where a click selects one of them", async () => {
    await layer("section m24").click();
    await expect(layer("section m24")).toHaveAttribute("aria-current", "true");
    await expect(crumbs()).toHaveText(expect.stringContaining("body"));
    expect((await crumbs().$$(".//button")).length).toBe(3);
    await expect(crumbs().$('.//button[normalize-space()="main m20"]')).toBeDisplayed();
    await crumbs().$('.//button[normalize-space()="main m20"]').click();
    await expect(layer("main m20")).toHaveAttribute("aria-current", "true");
  });

  it("deletes the selection with Delete, duplicates it with ⌘D and wraps it with ⌥⌘G, saving the page file each time", async () => {
    await layer("p m30").click();
    await press("Delete");
    await diskShows(onDisk, (html) => !html.includes("m30") && html.includes('<h2 data-mid="m25">Git</h2>\n  </section>'), "lost m30");
    await layer("h2 m25").click();
    await press("d", { code: "KeyD", metaKey: true });
    await diskShows(onDisk, (html) => html.includes('<h2 data-mid="m25">Git</h2><h2 data-mid="m31">Git</h2>'), "got the copy m31");
    await press("©", { code: "KeyG", altKey: true, metaKey: true });
    await diskShows(onDisk, (html) => html.includes('<div data-mid="m32"><h2 data-mid="m31">Git</h2></div>'), "wrapped m31 in m32");
    // The rest of the file is as it was written.
    expect(onDisk().startsWith(PAGE.split('  <section data-mid="m24">')[0])).toBe(true);
  });

  it("undoes the wrap with ⌘Z and the copy with the toolbar's undo button", async () => {
    await press("z", { code: "KeyZ", metaKey: true });
    await diskShows(onDisk, (html) => !html.includes("m32") && html.includes('<h2 data-mid="m31">Git</h2>'), "unwrapped m31");
    await $('//button[@title="Undo (⌘Z)"]').click();
    await diskShows(onDisk, (html) => !html.includes("m31") && !html.includes("m30"), "lost the copy");
  });

  it("counts the edits by hand on the chip, and the next message to the agent starts with them", async () => {
    const chip = $('//*[@aria-label="Edits by hand"]');
    await expect(chip).toHaveText("1 edit by hand · go with your next message");
    await $('//button[@title="Show chat (⌘\\)"]').click();
    await fill(COMPOSER, "Two more variants of the Git section");
    await browser.execute(() => document.querySelector<HTMLButtonElement>('section[aria-label="Design · Settings page"] button[title="Send (↵)"]')?.click());
    const block = chat().$('.//*[@aria-label="Edits by hand since your last turn"]');
    await expect(block).toBeDisplayed();
    await expect(block).toHaveText(expect.stringContaining("index.html m30 p: deleted"));
    await expect(chat()).toHaveText(expect.stringContaining("Two more variants of the Git section"));
    await expect(chip).not.toBeExisting();
  });

  it("shows the yellow bar when the page changed on disk behind the canvas's back, and Dismiss puts it away", async () => {
    const bar = $('//div[@role="status"][@data-tone="yellow"]');
    // The change reaches the app as design.changed 150 ms or more after it
    // is written; a Delete sent at once is saved over the version the
    // canvas read. Should the change win the race, the page loads again
    // and the next try goes.
    for (let i = 0; i < 3 && !(await bar.isExisting()); i++) {
      if (!(await layer("section m22").isExisting())) writeFileSync(file(), PAGE);
      await layer("section m22").click();
      await expect(layer("section m22")).toHaveAttribute("aria-current", "true");
      writeFileSync(file(), PAGE.replace("General", `General, by the agent ${i}`));
      await press("Delete");
      await browser.waitUntil(() => bar.isExisting(), { timeout: 3_000 }).catch(() => {});
    }
    await expect(bar).toHaveText(expect.stringContaining("The page changed; your last edit was not saved."));
    await expect(bar).toHaveText(expect.stringContaining("index.html m22 section: deleted"));
    expect(onDisk()).toContain("General, by the agent");
    await bar.$(sel.button("Dismiss")).click();
    await expect(bar).not.toBeExisting();
  });
});
