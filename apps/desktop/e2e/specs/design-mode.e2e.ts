// Design mode (X65) and the New design system dialog (X64): the third mode
// of the sidebar, and a design system built from the workspace's project.

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { fill, PROJECT, rpc, sel, SESSION, world } from "../fixtures";

const w = world();
const mode = (label: string) => $(`//div[@role="group"][@aria-label="Mode"]/button[starts-with(@aria-label, "${label}")]`);
const dialog = () => $('//div[@role="dialog"][@aria-label="New design system"]');
const systemRow = (name: string) => $(`//nav[@aria-label="Design systems"]//button[.//span[normalize-space()="${name}"]]`);
const workspaceId = () => rpc<{ id: string }[]>(w, "workspace.list", {})[0].id;
const FAKE = join(w.root, "bin", "claude");
// A sync agent that asks to approve its plan for every message (as in
// plan-approval.e2e.ts). printf, because /bin/sh's echo expands the \n in the JSON.
const PLANNING_CLAUDE = String.raw`#!/bin/sh
out() { printf '%s\n' "$1"; }
plan='{"plan":"# Cards for the storefront\n\n- Button, Input and Card first\n","planFilePath":"/tmp/plans/storefront-cards.md"}'
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) out '{"type":"system","subtype":"init","session_id":"e2e-design","model":"e2e-model","permissionMode":"plan","slash_commands":[]}' ;;
    *'"type":"user"'*)
      out "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"content\":[{\"type\":\"tool_use\",\"id\":\"p1\",\"name\":\"ExitPlanMode\",\"input\":$plan}]}}"
      out "{\"type\":\"control_request\",\"request_id\":\"r1\",\"request\":{\"subtype\":\"can_use_tool\",\"tool_name\":\"ExitPlanMode\",\"tool_use_id\":\"p1\",\"input\":$plan,\"requires_user_interaction\":true}}" ;;
  esac
done
`;

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

  it("shows a sync agent's plan from its docked chat, before it is approved", async () => {
    const blocked = readFileSync(FAKE, "utf8");
    writeFileSync(FAKE, PLANNING_CLAUDE);
    chmodSync(FAKE, 0o755);
    try {
      rpc(w, "design.system.create", { workspace: workspaceId(), name: "Checkout", sources: [] });
      await systemRow("Checkout").click();
      const agent = $('//section[@aria-label="Design · Checkout"]');
      await agent.$(sel.button("Open plan")).click();
      const plan = $('//div[@role="dialog"][@aria-label="Plan"]');
      await expect(plan.$(sel.text("Button, Input and Card first"))).toBeDisplayed();
      // The approval stays in the chat, under the dialog.
      await expect(agent.$(sel.button("Approve, ask before edits"))).toBeExisting();
      await browser.keys("Escape");
      await expect(plan).not.toBeExisting();
    } finally {
      writeFileSync(FAKE, blocked);
    }
  });
});
