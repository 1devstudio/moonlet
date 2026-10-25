// A design system's sync in its view (X64): the step bar while its agent
// works, Stop sync, then what the sync left: a card edited by hand beside the
// sync's version, settled with Use synced, and Changed by this sync.

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { $, expect } from "@wdio/globals";
import { projectId, rpc, sel, world } from "../fixtures";

const w = world();
const FAKE = join(w.root, "bin", "claude");
const workspaceId = () => rpc<{ id: string }[]>(w, "workspace.list", {})[0].id;
const mode = (label: string) => $(`//div[@role="group"][@aria-label="Mode"]/button[starts-with(@aria-label, "${label}")]`);
const SLUG = "checkout-kit";
const dir = () => join(w.home, "design", workspaceId(), "systems", SLUG);

// A sync agent that stays at work on every message until it is interrupted.
// printf, because /bin/sh's echo expands the \n in the JSON.
const WORKING_CLAUDE = String.raw`#!/bin/sh
out() { printf '%s\n' "$1"; }
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) out '{"type":"system","subtype":"init","session_id":"e2e-sync","model":"e2e-model","permissionMode":"acceptEdits","slash_commands":[]}' ;;
    *'"subtype":"interrupt"'*) out '{"type":"result","subtype":"success","is_error":false,"usage":{}}' ;;
  esac
done
`;

const head = '<!doctype html>\n<html><head><meta charset="utf-8"><link rel="stylesheet" href="../../../styles.css"></head>\n';
const row = (label: string) => `<!-- @dsCard group="Custom" name="Row" source="README.md" -->\n${head}<body><section data-snippet="custom/row/default"><div class="row">${label}</div></section></body></html>\n`;
const put = (path: string, text: string) => {
  mkdirSync(dirname(join(dir(), path)), { recursive: true });
  writeFileSync(join(dir(), path), text);
};
const progress = (step: string, summary: string) => rpc(w, "design.system.progress", { workspace: workspaceId(), slug: SLUG, step, summary });

describe("Design system sync", () => {
  let blocked = "";
  before(() => {
    blocked = readFileSync(FAKE, "utf8");
    writeFileSync(FAKE, WORKING_CLAUDE);
    chmodSync(FAKE, 0o755);
    rpc(w, "design.system.create", { workspace: workspaceId(), name: "Checkout kit", sources: [{ project: projectId(w) }] });
  });

  after(async () => {
    writeFileSync(FAKE, blocked);
    rpc(w, "design.system.remove", { workspace: workspaceId(), slug: SLUG });
    if (await mode("Sessions").isExisting()) await mode("Sessions").click();
  });

  it("shows each step's result while its agent works", async () => {
    await mode("Design").click();
    await $('//nav[@aria-label="Design systems"]//button[.//span[normalize-space()="Checkout kit"]]').click();
    progress("inventory", "3 changed, 1 new, 1 gone");
    progress("tokens", "no change");
    progress("cards", "1 of 3");
    const steps = $('//ol[@aria-label="Sync steps"]');
    await expect(steps.$('.//li[contains(., "Inventory")]')).toHaveText(expect.stringContaining("3 changed, 1 new, 1 gone"));
    await expect(steps.$('.//span[@aria-current="step"]')).toHaveText(expect.stringContaining("Cards"));
    await expect(steps.$('.//span[@aria-current="step"]')).toHaveText(expect.stringContaining("1 of 3"));
  });

  it("stops the sync, then shows what it left: a card edited by hand beside the sync's version", async () => {
    await $(sel.button("Stop sync")).click();
    // The stopped sync shows where it stopped until one is recorded.
    await expect($('//ol[@aria-label="Sync steps"]')).toHaveText(expect.stringContaining("1 of 3"));
    // The agent wrote the card and recorded a sync; the user edited it by hand;
    // a later sync wrote its version beside it.
    put("styles.css", '@import "components.css";\n');
    put("components.css", ".row {}\n");
    put("components/custom/row/row.html", row("Saved carts"));
    rpc(w, "design.system.synced", { workspace: workspaceId(), slug: SLUG });
    put("components/custom/row/row.html", row("Saved carts, edited by hand"));
    put("components/custom/row/row.proposed.html", row("Saved carts, from the sync"));
    put("components/custom/kbd/kbd.html", `<!-- @dsCard group="Custom" name="Kbd" source="README.md" -->\n${head}<body><kbd>K</kbd></body></html>\n`);
    rpc(w, "design.system.synced", { workspace: workspaceId(), slug: SLUG });

    await expect($(sel.button("Sync"))).toBeDisplayed();
    await expect($('//div[@role="status"][contains(., "Sync finished")]')).toHaveText(expect.stringContaining("1 change to settle"));
    const needs = $('//section[@aria-label="Needs you"]');
    await expect(needs.$('.//iframe[@title="Row, yours"]')).toBeExisting();
    await expect(needs.$('.//iframe[@title="Row, synced"]')).toBeExisting();
    await expect($('//section[@aria-label="Changed by this sync"]')).toHaveText(expect.stringContaining("Kbd"));
  });

  it("takes the sync's version with Use synced, and nothing is left to settle", async () => {
    await $('//section[@aria-label="Needs you"]').$(sel.button("Use synced")).click();
    await expect($('//section[@aria-label="Needs you"]')).not.toBeExisting();
    expect(readFileSync(join(dir(), "components/custom/row/row.html"), "utf8")).toContain("Saved carts, from the sync");
  });

  it("keeps an orphan for now, and it no longer waits to be settled", async () => {
    // A card made from a file the project then deletes.
    const source = join(w.repo, "Toolbar.md");
    writeFileSync(source, "toolbar\n");
    put("components/custom/toolbar/toolbar.html", `<!-- @dsCard group="Custom" name="Toolbar" source="Toolbar.md" -->\n${head}<body><nav>Toolbar</nav></body></html>\n`);
    rpc(w, "design.system.synced", { workspace: workspaceId(), slug: SLUG });
    rmSync(source);
    rpc(w, "design.system.progress", { workspace: workspaceId(), slug: SLUG, step: "inventory", summary: "1 gone" });
    rpc(w, "design.system.synced", { workspace: workspaceId(), slug: SLUG });
    const orphan = $('//section[@aria-label="Needs you"]//div[contains(., "Toolbar · Custom · orphaned")]');
    await expect(orphan).toHaveText(expect.stringContaining("Its source Toolbar.md was deleted."));
    await orphan.$(sel.button("Keep for now")).click();
    await expect($('//section[@aria-label="Needs you"]')).not.toBeExisting();
    await expect($('//nav[@aria-label="Design systems"]//button[.//span[normalize-space()="Checkout kit"]]')).not.toHaveText(expect.stringContaining("to settle"));
  });
});
