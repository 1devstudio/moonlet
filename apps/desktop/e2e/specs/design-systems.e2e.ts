// A design system's view and card page (X64): the cards of a fixture design
// system by group, rendered through the moonlet-design:// scheme, a check
// problem's badge and line, and the banner for a source changed since the sync.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { projectId, rpc, sel, world } from "../fixtures";

const w = world();
const workspaceId = () => rpc<{ id: string }[]>(w, "workspace.list", {})[0].id;
const mode = (label: string) => $(`//div[@role="group"][@aria-label="Mode"]/button[starts-with(@aria-label, "${label}")]`);
const readme = join(w.repo, "README.md");
const head = '<!doctype html>\n<html><head><meta charset="utf-8"><link rel="stylesheet" href="../../../styles.css"></head>\n';
const FILES: [string, string][] = [
  ["styles.css", '@import "tokens/colors.css";\n@import "components.css";\n'],
  ["tokens/colors.css", ":root { --color-fg: #e6e6e6; }\n"],
  ["components.css", ".btn { color: var(--color-fg); }\n.field {}\n"],
  [
    "components/buttons/button/button.html",
    `<!-- @dsCard group="Buttons" name="Button" source="README.md" viewport="320x140" -->\n${head}<body><section data-snippet="buttons/button/primary"><button class="btn">Run</button></section>\n<section data-snippet="buttons/button/ghost"><button class="btn">Cancel</button></section></body></html>\n`,
  ],
  [
    "components/forms/field/field.html",
    `<!-- @dsCard group="Forms" name="Field" -->\n${head}<body><section data-snippet="forms/field/default"><input class="field" style="color: var(--color-nope)"></section></body></html>\n`,
  ],
];

describe("Design system view", () => {
  let original = "";
  before(() => {
    original = readFileSync(readme, "utf8");
    const ws = workspaceId();
    rpc(w, "design.system.create", { workspace: ws, name: "Storefront kit", sources: [{ project: projectId(w) }], agent: false });
    const dir = join(w.home, "design", ws, "systems", "storefront-kit");
    for (const [path, text] of FILES) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    // The check writes the Colours card from the tokens; the sync anchors the cards.
    rpc(w, "design.check", { workspace: ws, slug: "storefront-kit" });
    rpc(w, "design.system.synced", { workspace: ws, slug: "storefront-kit" });
    // A source changed since the sync.
    writeFileSync(readme, `${original}changed\n`);
  });

  after(async () => {
    writeFileSync(readme, original);
    rpc(w, "design.system.remove", { workspace: workspaceId(), slug: "storefront-kit" });
    if (await mode("Sessions").isExisting()) await mode("Sessions").click();
  });

  it("shows the cards by group, each rendered in its sandboxed frame", async () => {
    await mode("Design").click();
    await $('//nav[@aria-label="Design systems"]//button[.//span[normalize-space()="Storefront kit"]]').click();
    await expect($('//nav[@aria-label="Groups"]//button[.//span[normalize-space()="All"]]//span[normalize-space()="3"]')).toBeDisplayed();
    await expect($('//nav[@aria-label="Groups"]//button[.//span[normalize-space()="Forms"]]//span[@aria-label="has a check problem"]')).toBeExisting();
    const frame = $('//section[@aria-label="Buttons"]//iframe[@title="Button"]');
    await expect(frame).toHaveAttribute("src", `moonlet-design://${workspaceId()}/systems/storefront-kit/components/buttons/button/button.html`);
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    // Sandboxed with no same-origin: the app itself cannot reach into it (a
    // test driver cannot either; the screenshots show what it renders).
    const reached = await browser.execute(() => (document.querySelector('iframe[title="Button"]') as HTMLIFrameElement | null)?.contentDocument ?? null);
    expect(reached).toBeNull();
  });

  it("says which source changed since the sync and how many cards a sync rewrites", async () => {
    await expect($(sel.text("1 source changed since sync · README.md. A sync rewrites only the card made from it."))).toBeDisplayed();
    await expect($('//button[normalize-space()="1 check problem"]')).toBeDisplayed();
  });

  it("opens a card with its check problem's line and its snippets", async () => {
    await $('//button[@aria-label="Field"]').click();
    await expect($('//nav[@aria-label="Breadcrumb"]')).toHaveText(expect.stringContaining("Forms"));
    await expect($('//aside[@aria-label="Card"]//p[normalize-space()="line 4 · unknown token"]')).toBeDisplayed();
    await expect($(sel.button("Ask the sync agent to fix"))).toBeDisplayed();
    await expect($('//aside[@aria-label="Card"]//span[normalize-space()="forms/field/default"]')).toBeDisplayed();
    await $('//button[@aria-label="Back to the design system"]').click();
    await expect($('//nav[@aria-label="Groups"]')).toBeDisplayed();
  });
});
