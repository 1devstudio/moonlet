// Open file… (⌘P) opens a session's file by name, at `:line` or with
// `:start-end` selected (X96).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { PROJECT, fill, rpc, sel, world } from "../fixtures";

const w = world();
const NAME = "Open a file by name";
const dialog = '//div[@role="dialog"][@aria-label="Open file"]';
const field = `${dialog}//input[@aria-label="File name"]`;
let file = "";

/** A key press where the focus is, as a keyboard sends it. */
const press = (key: string, mods: { metaKey?: boolean } = {}) =>
  browser.execute(
    (k: string, m: { metaKey?: boolean }) =>
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, bubbles: true, cancelable: true, ...m })),
    key,
    mods,
  );

const fileTab = () => $(`//div[@title=${JSON.stringify(file)}][.//button[@title="Close tab"]]`);

/** What the editor shows: the numbers of the lines drawn selected, the
 *  cursor's line number, and every line number drawn. Monaco draws one
 *  overlay row per visible line, beside the gutter row of the same top. */
const editorView = () =>
  browser.execute(() => {
    const ed = document.querySelector(".monaco-editor");
    const numberAt = new Map([...(ed?.querySelectorAll<HTMLElement>(".margin-view-overlays > div") ?? [])].map((r) => [r.style.top, r.querySelector(".line-numbers")?.textContent?.trim() ?? ""]));
    const selected = [...(ed?.querySelectorAll<HTMLElement>(".view-overlays > div") ?? [])].filter((r) => r.querySelector(".selected-text")).map((r) => numberAt.get(r.style.top) ?? "?");
    return {
      selectedLines: selected.sort((a, b) => Number(a) - Number(b)),
      cursorLine: ed?.querySelector(".line-numbers.active-line-number")?.textContent?.trim() ?? "",
      lineNumbers: [...(ed?.querySelectorAll(".line-numbers") ?? [])].map((n) => n.textContent?.trim()),
    };
  });

/** Monaco draws on animation frames, which WebKit pauses while the window
 *  is in the background: a timeout says so instead of looking like a bug. */
const drawn = async (what: string) => `${what} (window ${await browser.execute(() => document.visibilityState)})`;

describe("Open file by name (X96)", () => {
  let sessionId = "";

  before(async () => {
    const project = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!;
    const created = rpc<{ id: string; path: string }>(w, "session.create", { project_id: project.id, name: NAME, agent: "none" });
    sessionId = created.id;
    mkdirSync(join(created.path, "config", "tenants"), { recursive: true });
    file = join(created.path, "config", "tenants", "tenant-acme.yaml");
    writeFileSync(file, Array.from({ length: 80 }, (_, i) => `key${i + 1}: value ${i + 1}`).join("\n") + "\n");
    writeFileSync(join(created.path, "config", "tenants", "tenant-globex.yaml"), "name: globex\n");
    await $(sel.sessionRow(NAME)).click();
  });

  after(async () => {
    rpc(w, "session.archive", { id: sessionId });
    await expect($(sel.sessionRow(NAME))).not.toBeExisting({ wait: 30_000 });
  });

  it("opens name:start-end from ⌘P with the range selected", async () => {
    await press("p", { metaKey: true });
    await $(field).waitForDisplayed();
    await fill(field, "tenant-acme.yaml:49-53");
    await expect($(`${dialog}//span[normalize-space()="lines 49–53"]`)).toBeDisplayed();
    const first = $(`(${dialog}//div[@data-file-row])[1]`);
    await expect(first).toHaveAttribute("data-file-row", "config/tenants/tenant-acme.yaml");
    await press("Enter");
    await expect($(dialog)).not.toBeExisting();
    await expect(fileTab()).toBeDisplayed();
    await expect(fileTab()).toHaveAttribute("aria-current", "true");
    await browser.waitUntil(async () => (await editorView()).cursorLine === "53", { timeoutMsg: await drawn("the cursor never moved to line 53") });
    const view = await editorView();
    expect(view.selectedLines).toEqual(["49", "50", "51", "52", "53"]);
    expect(view.lineNumbers).toContain("49");
  });

  it("moves the open file to a single line, and says when nothing matches", async () => {
    await press("p", { metaKey: true });
    await fill(field, "acme:12");
    await expect($(`${dialog}//span[normalize-space()="line 12"]`)).toBeDisplayed();
    await press("Enter");
    await expect($(dialog)).not.toBeExisting();
    await browser.waitUntil(async () => (await editorView()).cursorLine === "12", { timeoutMsg: await drawn("the cursor never moved to line 12") });
    expect((await editorView()).selectedLines).toEqual([]);

    await press("p", { metaKey: true });
    await fill(field, "zzz-nothing");
    await expect($(`${dialog}//div[normalize-space()="No file matches “zzz-nothing”"]`)).toBeDisplayed();
    await press("Escape");
    await expect($(dialog)).not.toBeExisting();
  });

  it("opens the row picked with ↓ from Tasks mode in Sessions mode, and a clicked row", async () => {
    const mode = (name: string) => $(`//div[@role="group"][@aria-label="Mode"]/button[starts-with(@aria-label, "${name}")]`);
    await mode("Tasks").click();
    await expect(mode("Tasks")).toHaveAttribute("aria-pressed", "true");
    await press("p", { metaKey: true });
    await fill(field, "tenant-");
    await expect($(`(${dialog}//div[@data-file-row])[2]`)).toHaveAttribute("data-file-row", "config/tenants/tenant-globex.yaml");
    await press("ArrowDown");
    await press("Enter");
    await expect($(dialog)).not.toBeExisting();
    await expect(mode("Sessions")).toHaveAttribute("aria-pressed", "true");
    const globex = $(`//div[@title=${JSON.stringify(file.replace("tenant-acme", "tenant-globex"))}][.//button[@title="Close tab"]]`);
    await expect(globex).toHaveAttribute("aria-current", "true");

    await press("p", { metaKey: true });
    await fill(field, "acme");
    await $(`${dialog}//div[@data-file-row="config/tenants/tenant-acme.yaml"]`).click();
    await expect($(dialog)).not.toBeExisting();
    await expect(fileTab()).toHaveAttribute("aria-current", "true");
  });
});
