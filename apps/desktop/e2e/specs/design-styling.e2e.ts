// The visual editor's styling (X65 entry 10): the right rail's Inspector
// with its token popover, the off-system dot of a free value, and the
// Palette's snippets inserted by a pick; each saved in the page file, and
// undone.
//
// WebDriver cannot reach inside the page, a sandboxed frame on another
// host in its own web process (design-comments.e2e.ts), so the selection
// is made from the Layers tab and the edits from the rail; dragging and
// resizing in the page are tested on the bridge script in jsdom
// (designBridge.test.ts).

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { diskShows, press, within } from "../design";
import { fill, rpc, world } from "../fixtures";

const w = world();
const FAKE = join(w.root, "bin", "claude");
const workspaceId = () => rpc<{ id: string }[]>(w, "workspace.list", {})[0].id;
const mode = (label: string) => $(`//div[@role="group"][@aria-label="Mode"]/button[starts-with(@aria-label, "${label}")]`);
const SYSTEM = "styling-kit";
const system = () => join(w.home, "design", workspaceId(), "systems", SYSTEM);
// A design of its own: the editor keeps the highest id each page has had for
// the app's life, so design-editor.e2e.ts's Settings page gets its own ids.
const file = () => join(w.home, "design", workspaceId(), "designs", "styled-page", "pages", "index.html");
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
const BUTTON_CARD = [
  '<!-- @dsCard group="Buttons" name="Button" source="src/ui.tsx" -->',
  "<!doctype html>",
  '<link rel="stylesheet" href="../../../styles.css">',
  '<section class="ds-cell" data-snippet="buttons/button/primary"><h4>primary</h4><div class="ds-mount"><button class="btn btn--primary">Save</button></div></section>',
  '<section class="ds-cell" data-snippet="buttons/button/ghost"><h4>ghost</h4><div class="ds-mount"><button class="btn btn--ghost">Cancel</button></div></section>',
  "",
].join("\n");
const rail = () => $('//aside[@aria-label="Right rail"]');
const tab = (name: string) => rail().$(`.//button[@role="tab"][normalize-space()="${name}"]`);
const layer = (name: string) => rail().$(`.//button[@role="treeitem"][@aria-label="${name}"]`);
const inspector = () => rail().$('.//*[@aria-label="Inspector"]');
const field = (label: string) => inspector().$(`.//button[@aria-label="${label}"]`);
const popover = (label: string) => $(`//div[@role="dialog"][@aria-label="${label} tokens"]`);

// A design agent that ends each turn with a short answer, as in
// design-editor.e2e.ts.
const ANSWERING_CLAUDE = String.raw`#!/bin/sh
out() { printf '%s\n' "$1"; }
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) out '{"type":"system","subtype":"init","session_id":"e2e-styling","model":"e2e-model","permissionMode":"acceptEdits","slash_commands":[]}' ;;
    *'"type":"user"'*)
      out '{"type":"assistant","message":{"id":"a1","content":[{"type":"text","text":"Noted."}]}}'
      out '{"type":"result","subtype":"success","is_error":false,"usage":{}}' ;;
  esac
done
`;

/** Enter pressed in the field at `xpath`. */
const enterIn = (xpath: string) =>
  browser.execute((xp: string) => {
    const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement | null;
    el?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  }, xpath);

describe("The visual editor's styling", () => {
  let fake = "";
  before(async () => {
    fake = readFileSync(FAKE, "utf8");
    writeFileSync(FAKE, ANSWERING_CLAUDE);
    chmodSync(FAKE, 0o755);
    const ws = workspaceId();
    rpc(w, "design.system.create", { workspace: ws, name: "Styling kit", sources: [], agent: false });
    const put = (rel: string, text: string) => {
      mkdirSync(dirname(join(system(), rel)), { recursive: true });
      writeFileSync(join(system(), rel), text);
    };
    put("styles.css", '@import "tokens/scale.css";\n');
    put("tokens/scale.css", ":root {\n  --space-1: 4px;\n  --space-4: 16px;\n  --space-6: 24px;\n  --color-panel: #161616;\n}\n");
    put("components/buttons/Button/Button.html", BUTTON_CARD);
    rpc(w, "design.create", { workspace: ws, name: "Styled page", system: SYSTEM, brief: "A settings page" });
    writeFileSync(file(), PAGE);
    await mode("Design").click();
    await $('//nav[@aria-label="Designs"]//button[.//span[normalize-space()="Styled page"]]').click();
    await expect($('//iframe[@title="index.html"]')).toBeExisting();
    await press("v");
    await expect(layer("section m24")).toBeDisplayed();
  });

  after(async () => {
    writeFileSync(FAKE, fake);
    for (const d of rpc<{ slug: string }[]>(w, "design.list", { workspace: workspaceId() })) rpc(w, "design.remove", { workspace: workspaceId(), slug: d.slug });
    rpc(w, "design.system.remove", { workspace: workspaceId(), slug: SYSTEM });
    await within(5_000, (async () => {
      if (await mode("Sessions").isExisting()) await mode("Sessions").click();
    })());
  });

  it("has the right rail's Layers, Inspector, Palette and Comments tabs, and inspects the element selected in Layers", async () => {
    expect((await rail().$$('.//button[@role="tab"]').map((t) => t.getText())).map((t) => t.replace(/\s*\d+$/, ""))).toEqual(["Layers", "Inspector", "Palette", "Comments"]);
    await layer("section m24").click();
    await tab("Inspector").click();
    await expect(inspector()).toHaveText(expect.stringContaining("section"));
    await expect(inspector()).toHaveText(expect.stringContaining("m24"));
    for (const s of ["Layout", "Spacing", "Size", "Fill and border", "Effects"]) await expect(inspector().$(`.//section[@aria-label="${s}"]`)).toBeDisplayed();
  });

  it("sets the selection's padding to a token from the Inspector's popover, saving the page file", async () => {
    await field("Padding").click();
    await expect(popover("Padding")).toBeDisplayed();
    await expect(popover("Padding")).toHaveText(expect.stringContaining("Any value works. One that matches no token marks the element off-system."));
    expect(await popover("Padding").$$('.//button[@role="option"]').map((o) => o.getAttribute("aria-label"))).toEqual(["--space-1", "--space-4", "--space-6"]);
    await popover("Padding").$('.//button[@aria-label="--space-4"]').click();
    await diskShows(onDisk, (html) => html.includes('<section data-mid="m24" style="padding: var(--space-4)"><h2 data-mid="m25">Git</h2>'), "got the padding token");
    await expect(field("Padding")).toHaveText(expect.stringContaining("--space-4"));
    await expect(field("Padding")).toHaveText(expect.stringContaining("16px"));
    // The rest of the file is as it was written.
    expect(onDisk().replace(' style="padding: var(--space-4)"', "")).toBe(PAGE);
  });

  it("marks the element off-system in Layers and the Inspector after a free value that matches no token", async () => {
    await expect(inspector()).not.toHaveText(expect.stringContaining("off-system"));
    await field("Margin").click();
    const input = '//div[@role="dialog"][@aria-label="Margin tokens"]//input[@aria-label="Margin value"]';
    await fill(input, "13px");
    await enterIn(input);
    await diskShows(onDisk, (html) => html.includes('<section data-mid="m24" style="padding: var(--space-4); margin: 13px">'), "got the free margin");
    await tab("Layers").click();
    await expect(layer("section m24").$('.//*[@aria-label="off-system"]')).toBeExisting();
    await expect(layer("section m22").$('.//*[@aria-label="off-system"]')).not.toBeExisting();
    await tab("Inspector").click();
    await expect(inspector()).toHaveText(expect.stringContaining("off-system"));
  });

  it("inserts a snippet picked in the Palette after the selection, with fresh ids, saving the page file", async () => {
    await tab("Palette").click();
    const palette = rail().$('.//*[@aria-label="Palette"]');
    await expect(palette.$('.//button[@aria-label="buttons/button/primary"]')).toBeDisplayed();
    await fill('//aside[@aria-label="Right rail"]//input[@aria-label="Search snippets"]', "ghost");
    await expect(palette.$('.//button[@aria-label="buttons/button/primary"]')).not.toBeExisting();
    await palette.$('.//button[@aria-label="buttons/button/ghost"]').click();
    await diskShows(onDisk, (html) => html.includes('    <p data-mid="m30">Branch prefix</p>\n  </section>\n  <button data-mid="m31" class="btn btn--ghost">Cancel</button>\n</main>'), "got the ghost button after m24");
  });

  it("undoes the insert and the margin with ⌘Z, and counts the edits by hand left on the chip", async () => {
    await press("z", { code: "KeyZ", metaKey: true });
    await diskShows(onDisk, (html) => !html.includes("m31"), "lost the button");
    await press("z", { code: "KeyZ", metaKey: true });
    await diskShows(onDisk, (html) => html.includes('<section data-mid="m24" style="padding: var(--space-4)"><h2'), "lost the margin");
    await expect($('//*[@aria-label="Edits by hand"]')).toHaveText("1 edit by hand · go with your next message");
  });
});
