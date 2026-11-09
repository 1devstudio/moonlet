// One design library for the account (X95): a design system built in one
// workspace is listed in every other, and a design shared with every
// workspace is listed in each until Stop sharing moves it into the one shown.

import { $, browser, expect } from "@wdio/globals";
import { rpc, sel, world } from "../fixtures";

const w = world();
type Workspace = { id: string; name: string };
const mode = (label: string) => $(`//div[@role="group"][@aria-label="Mode"]/button[starts-with(@aria-label, "${label}")]`);
const switcher = (name: string) => $(`button[aria-label="Switch workspace, current: ${name}"]`);
const row = (nav: string, name: string) => $(`//nav[@aria-label="${nav}"]//button[.//span[normalize-space()="${name}"]]`);
/** ⌃⌘<n>: the embedded driver's key actions do not carry both modifiers. */
const ctrlCmd = (key: string) =>
  browser.execute((k: string) => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, metaKey: true, ctrlKey: true, bubbles: true })), key);
const more = () => $('//section[starts-with(@aria-label, "Design · ")]//button[@title="More"]');

describe("the design library (X95)", () => {
  let first: Workspace;
  let site: Workspace;

  before(() => {
    first = rpc<Workspace[]>(w, "workspace.list", {})[0];
    site = rpc<Workspace>(w, "workspace.create", { name: "Acme site", color: "blue" });
    rpc(w, "design.system.create", { workspace: first.id, name: "Library kit", sources: [], agent: false });
    rpc(w, "design.create", { workspace: first.id, name: "Pricing", system: "library-kit", brief: "Three plans" });
  });

  after(async () => {
    for (const ws of [first.id, site.id, "library"]) {
      for (const d of rpc<{ slug: string; kind: string; shared?: boolean }[]>(w, "design.list", { workspace: ws })) {
        if (d.kind === "workspace" && !d.shared) rpc(w, "design.remove", { workspace: ws, slug: d.slug });
      }
    }
    for (const s of rpc<{ slug: string }[]>(w, "design.systems", { workspace: first.id })) rpc(w, "design.system.remove", { workspace: first.id, slug: s.slug });
    await ctrlCmd("1");
    rpc(w, "workspace.delete", { id: site.id });
    if (await mode("Sessions").isExisting()) await mode("Sessions").click();
  });

  it("lists a design system built in one workspace in another", async () => {
    await mode("Design").click();
    await expect(row("Design systems", "Library kit")).toBeDisplayed({ wait: 30_000 });
    await ctrlCmd("2");
    await expect(switcher("Acme site")).toBeDisplayed();
    // The mode is remembered per workspace (X65).
    await mode("Design").click();
    await expect(row("Design systems", "Library kit")).toBeDisplayed();
  });

  it("shares a design with every workspace: both list it under Shared designs", async () => {
    await ctrlCmd("1");
    await expect(switcher(first.name)).toBeDisplayed();
    await row("Designs", "Pricing").click();
    await more().click();
    await $(sel.button("Share with every workspace")).click();
    await $(sel.confirmButton("Share")).click();
    await expect(row("Shared designs", "Pricing")).toBeDisplayed();
    await expect(row("Designs", "Pricing")).not.toBeExisting();
    await ctrlCmd("2");
    await expect(switcher("Acme site")).toBeDisplayed();
    await expect(row("Shared designs", "Pricing")).toBeDisplayed();
  });

  it("Stop sharing moves it into the workspace shown, and the other lists it no more", async () => {
    await row("Shared designs", "Pricing").click();
    await more().click();
    await $(sel.button("Stop sharing")).click();
    await $(sel.confirmButton("Stop sharing")).click();
    await expect(row("Designs", "Pricing")).toBeDisplayed();
    await expect($('//nav[@aria-label="Shared designs"]')).not.toBeExisting();
    expect(rpc<{ slug: string }[]>(w, "design.list", { workspace: site.id }).map((d) => d.slug)).toEqual(["pricing"]);
    await ctrlCmd("1");
    await expect(switcher(first.name)).toBeDisplayed();
    await expect($('//nav[@aria-label="Designs"]')).toBeDisplayed();
    await expect(row("Designs", "Pricing")).not.toBeExisting();
  });
});
