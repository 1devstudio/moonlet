// Design mode (X65) and the New design system dialog (X64): the third mode
// of the sidebar, and a design system built from the workspace's project.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { fill, PROJECT, rpc, sel, SESSION, world } from "../fixtures";

const w = world();
const mode = (label: string) => $(`//div[@role="group"][@aria-label="Mode"]/button[starts-with(@aria-label, "${label}")]`);
const dialog = () => $('//div[@role="dialog"][@aria-label="New design system"]');
const systemRow = (name: string) => $(`//nav[@aria-label="Design systems"]//button[.//span[normalize-space()="${name}"]]`);
const workspaceId = () => rpc<{ id: string }[]>(w, "workspace.list", {})[0].id;

describe("Design mode", () => {
  after(async () => {
    for (const s of rpc<{ slug: string }[]>(w, "design.systems", { workspace: workspaceId() })) rpc(w, "design.system.remove", { workspace: workspaceId(), slug: s.slug });
    if (await mode("Sessions").isExisting()) await mode("Sessions").click();
  });

  it("opens from the mode switch with no design system yet", async () => {
    await mode("Design").click();
    await expect(mode("Design")).toHaveAttribute("aria-pressed", "true");
    await expect($(sel.text("None yet. Build one from a project's code."))).toBeDisplayed();
    await expect($(sel.text("No design system yet"))).toBeDisplayed();
    await expect($(sel.text("~/.moonlet/design"))).toBeDisplayed();
  });

  it("⌃⌘D goes back to Sessions, and again to Design", async () => {
    await browser.keys(["Control", "Meta", "d"]);
    await expect($(sel.sessionRow(SESSION))).toBeDisplayed();
    await browser.keys(["Control", "Meta", "d"]);
    await expect(mode("Design")).toHaveAttribute("aria-pressed", "true");
  });

  it("builds a design system from the workspace's project, with what to cover", async () => {
    await $('//button[@title="New design system"]').click();
    await expect(dialog()).toBeDisplayed();
    // The workspace's project is picked, read only.
    await expect(dialog().$(`.//label[.//span[normalize-space()="${PROJECT}"]]//input[@type="checkbox"]`)).toBeSelected();
    await expect(dialog().$(sel.text("Read only. The agent writes nothing in these projects."))).toBeDisplayed();
    await fill('//div[@role="dialog"]//input[@placeholder="moonlet desktop"]', "Storefront UI");
    await expect(dialog().$(sel.text(`~/.moonlet/design/${workspaceId()}/systems/storefront-ui`))).toBeDisplayed();
    await dialog().$('.//button[@role="radio"][starts-with(normalize-space(), "Everything")]').click();
    await dialog().$(sel.button("Build design system")).click();
    await expect(dialog()).not.toBeExisting();
    await expect(systemRow("Storefront UI")).toBeDisplayed();
    const config = join(w.home, "design", workspaceId(), "systems", "storefront-ui", "config.toml");
    expect(existsSync(config)).toBe(true);
    expect(readFileSync(config, "utf8")).toContain('cover = "all"');
  });

  it("opens the new system with its sync agent's chat docked, where its questions are answered", async () => {
    const agent = () => $('//section[@aria-label="Design · Storefront UI"]');
    await expect(agent()).toBeDisplayed();
    await agent().$(sel.button("Hide agent")).click();
    await expect(agent()).not.toBeExisting();
    await $(sel.button("Show agent")).click();
    await expect(agent()).toBeDisplayed();
  });
});
