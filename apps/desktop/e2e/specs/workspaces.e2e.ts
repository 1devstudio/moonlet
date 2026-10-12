// Workspaces above sections (X32): create a workspace that takes a section,
// switch between workspaces, and start a session in the new one.

import { $, browser, expect } from "@wdio/globals";
import { PROJECT, SESSION, fill, rpc, sel, world } from "../fixtures";

const w = world();

interface Workspace {
  id: string;
  name: string;
  section_ids: string[];
}
interface Session {
  id: string;
  name: string;
  workspace_id: string | null;
}

const switcher = (name: string) => $(`button[aria-label="Switch workspace, current: ${name}"]`);
/** ⌃⌘<n>: the embedded driver's key actions do not carry both modifiers. */
const ctrlCmd = (key: string) =>
  browser.execute((k: string) => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, metaKey: true, ctrlKey: true, bubbles: true })), key);

describe("workspaces", () => {
  it("moves a section into a new workspace, switches between them, and starts a session there", async () => {
    await expect(switcher("Personal")).toBeDisplayed({ wait: 30_000 });
    await expect($(sel.sessionRow(SESSION))).toBeDisplayed();

    await switcher("Personal").click();
    await $(sel.button("New workspace…")).click();
    await fill('//div[@role="dialog"]//input[@placeholder="CipherHealth"]', "CipherHealth");
    await $('//label[contains(normalize-space(), "Move sections from Personal")]/input').click();
    await $('//label[contains(normalize-space(), "My projects")]/input[@type="checkbox"]').click();
    await $(sel.button("Create workspace")).click();

    // The new workspace is shown, with the section and its session.
    await expect(switcher("CipherHealth")).toBeDisplayed();
    await expect($(sel.text(PROJECT))).toBeDisplayed();
    await expect($(sel.sessionRow(SESSION))).toBeDisplayed();
    const work = rpc<Workspace[]>(w, "workspace.list", {}).find((x) => x.name === "CipherHealth")!;
    const personal = rpc<Workspace[]>(w, "workspace.list", {}).find((x) => x.name === "Personal")!;
    expect(personal.section_ids).toEqual([]);

    // ⌃⌘1 shows Personal, which no longer has the session; its terminal
    // keeps running while its workspace is hidden.
    await ctrlCmd("1");
    await expect(switcher("Personal")).toBeDisplayed();
    await expect($(sel.sessionRow(SESSION))).not.toBeDisplayed();
    const seeded = rpc<Session[]>(w, "session.list", {}).find((s) => s.name === SESSION)!;
    // Its shell, that is: the setup script's tab ends on its own.
    const terms = rpc<{ session_id?: string; kind: string; exit?: unknown }[]>(w, "terminal.list", {}).filter((t) => t.session_id === seeded.id && t.kind === "shell");
    expect(terms.length).toBeGreaterThan(0);
    expect(terms.every((t) => !t.exit)).toBe(true);
    await ctrlCmd("2");
    await expect(switcher("CipherHealth")).toBeDisplayed();

    // Workspace settings renames and recolours it.
    await switcher("CipherHealth").click();
    await $(sel.button("Workspace settings…")).click();
    await fill('//div[@role="dialog"]//input[@placeholder="CipherHealth"]', "Cipher");
    await $('button[aria-label="Violet"]').click();
    await $(sel.button("Save")).click();
    await expect(switcher("Cipher")).toBeDisplayed();
    expect(rpc<(Workspace & { color: string })[]>(w, "workspace.list", {}).find((x) => x.id === work.id)?.color).toBe("violet");

    // A new session goes into the shown workspace.
    const project = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!;
    await browser.execute((id: string) => localStorage.setItem(`moonlet.composer.${id}`, JSON.stringify({ agent: "none", model: null, effort: null })), project.id);
    await $('button[title="New session"]').click();
    await fill('//textarea[@placeholder="What do you want to work on?"]', "Cipher banner");
    await $(sel.button("Create")).click();
    await expect($(sel.sessionRow("Cipher banner"))).toBeDisplayed({ wait: 30_000 });
    const created = rpc<Session[]>(w, "session.list", {}).find((s) => s.name === "Cipher banner")!;
    expect(created.workspace_id).toBe(work.id);

    // Leave the shared world as the other specs expect it.
    rpc(w, "session.archive", { id: created.id });
    rpc(w, "section.move", { id: work.section_ids[0], workspace_id: personal.id });
    rpc(w, "workspace.delete", { id: work.id });
    await expect(switcher("Personal")).toBeDisplayed();
    await expect($(sel.sessionRow(SESSION))).toBeDisplayed();
  });
});
