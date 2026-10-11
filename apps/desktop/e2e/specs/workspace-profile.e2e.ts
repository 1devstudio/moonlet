// A Claude profile per workspace (X33): create a profile in the New
// workspace dialog, and see a session's shell get it as CLAUDE_CONFIG_DIR.
// Signing in is not exercised: the world's `claude` is a stub.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { PROJECT, choose, fill, rpc, sel, world } from "../fixtures";

const w = world();
const input = '//textarea[@placeholder="Type a command…"]';

/** Types `command` into the input editor and presses Enter (as in
 *  command-blocks.e2e.ts: retyped until the editor shows it). */
async function run(command: string) {
  const shown = () =>
    browser.execute(
      (xp: string, c: string) => {
        const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as Element | null;
        return el?.previousElementSibling?.textContent?.startsWith(c) ?? false;
      },
      input,
      command,
    );
  await browser.waitUntil(
    async () => {
      await fill(input, command);
      await browser.pause(300);
      return shown();
    },
    { timeout: 15_000, timeoutMsg: `the editor never showed ${command}` },
  );
  await browser.execute((xp: string) => {
    const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    el?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }, input);
}

interface Profile {
  id: string;
  name: string;
  path: string;
}

describe("workspace Claude profile", () => {
  it("creates a profile for a new workspace and starts its sessions with it", async () => {
    const folder = `${w.root}/claude-work`;
    await $('button[aria-label="Switch workspace, current: Personal"]').click();
    await $(sel.button("New workspace…")).click();
    await fill('//div[@role="dialog"]//input[@placeholder="Acme"]', "Acme");
    await choose('//select[@aria-label="Claude profile"]', "new");
    await fill('//input[@placeholder="Profile name, e.g. Work profile"]', "Work profile");
    await fill('//input[starts-with(@placeholder, "Folder (default")]', folder);
    await $(sel.button("Create profile")).click();
    await browser.waitUntil(() => rpc<Profile[]>(w, "profile.list", {}).some((p) => p.name === "Work profile"), { timeoutMsg: "the profile was not created" });
    const profile = rpc<Profile[]>(w, "profile.list", {}).find((p) => p.name === "Work profile")!;
    expect(profile.path).toBe(folder);
    await expect($('//select[@aria-label="Claude profile"]')).toHaveValue(profile.id);
    await $('//label[contains(normalize-space(), "Move sections from Personal")]/input').click();
    await $('//label[contains(normalize-space(), "My projects")]/input[@type="checkbox"]').click();
    await $(sel.button("Create workspace")).click();

    // The footer names the account the workspace's agents use.
    await expect($('//button[.//span[normalize-space()="Claude · Work profile"]]')).toBeDisplayed();

    // A new session's shell has the profile's folder.
    const project = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!;
    await browser.execute((id: string) => localStorage.setItem(`moonlet.composer.${id}`, JSON.stringify({ agent: "none", model: null, effort: null })), project.id);
    await $('button[title="New session"]').click();
    await fill('//textarea[@placeholder="What do you want to work on?"]', "Profile check");
    await $(sel.button("Create")).click();
    await expect($(sel.sessionRow("Profile check"))).toBeDisplayed({ wait: 30_000 });
    // Written to a file: a long path wraps across terminal rows.
    const created = rpc<{ id: string; name: string; path: string }[]>(w, "session.list", {}).find((s) => s.name === "Profile check")!;
    await run("echo $CLAUDE_CONFIG_DIR > profile-check.txt");
    const check = join(created.path, "profile-check.txt");
    await browser.waitUntil(() => existsSync(check) && readFileSync(check, "utf8").trim().length > 0, { timeout: 15_000, timeoutMsg: "the shell never wrote profile-check.txt" });
    expect(readFileSync(check, "utf8").trim()).toBe(folder);

    // Leave the shared world as the other specs expect it.
    const work = rpc<{ id: string; name: string; section_ids: string[] }[]>(w, "workspace.list", {}).find((x) => x.name === "Acme")!;
    const personal = rpc<{ id: string; name: string }[]>(w, "workspace.list", {}).find((x) => x.name === "Personal")!;
    rpc(w, "session.archive", { id: created.id });
    rpc(w, "section.move", { id: work.section_ids[0], workspace_id: personal.id });
    rpc(w, "workspace.delete", { id: work.id });
    rpc(w, "profile.delete", { id: profile.id });
    await expect($('button[aria-label="Switch workspace, current: Personal"]')).toBeDisplayed();
  });
});
