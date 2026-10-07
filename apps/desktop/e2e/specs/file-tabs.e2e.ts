// A file clicked in the Files tab opens as an editor tab of the main window,
// coloured with Dark+, editable, saved with ⌘S; closing it unsaved asks (X26).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, $$, browser, expect } from "@wdio/globals";
import { PROJECT, choose, rpc, sel, world } from "../fixtures";

const w = world();
const NAME = "Edit a file";
let file = "";

const row = (name: string) => $(`//div[@role="treeitem"][.//span[normalize-space()=${JSON.stringify(name)}]]`);
const fileTab = () => $(`//div[@title=${JSON.stringify(file)}][.//button[@title="Close tab"]]`);
const editorText = () => browser.execute(() => (document.querySelector(".monaco-editor .view-lines") as HTMLElement | null)?.innerText.replace(/ /g, " ") ?? "");
/** The colour of the first rendered token with this text. */
const tokenColour = (text: string) =>
  browser.execute((t: string) => {
    const span = [...document.querySelectorAll(".monaco-editor .view-lines span span")].find((s) => s.textContent === t);
    return span ? getComputedStyle(span).color : null;
  }, text);

/** ⌘S in the focused editor. The embedded driver sends "s" with keyCode
 *  115 (F4 to Monaco), so this sends the keyCode a keyboard does, 83. */
const commandS = () =>
  browser.execute(() => {
    const e = new KeyboardEvent("keydown", { key: "s", code: "KeyS", metaKey: true, bubbles: true, cancelable: true });
    Object.defineProperty(e, "keyCode", { get: () => 83 });
    Object.defineProperty(e, "which", { get: () => 83 });
    document.activeElement?.dispatchEvent(e);
  });

async function setTheme(id: string) {
  await $('button[title="Settings (⌘,)"]').click();
  await choose(sel.field("Colour theme of files and diffs"), id);
  await $('[role="dialog"][aria-label="Settings"] button[title="Close"]').click();
  await expect($('[role="dialog"][aria-label="Settings"]')).not.toBeExisting();
}

/** Focuses the editor. The embedded driver's click raises no mousedown,
 *  which is what Monaco takes focus on. */
const focusEditor = () => browser.execute(() => (document.querySelector(".monaco-editor textarea") as HTMLElement).focus());

/** Monaco draws on animation frames, which WebKit pauses while the window
 *  is in the background: a timeout says so instead of looking like a bug. */
const drawn = async (what: string) => `${what} (window ${await browser.execute(() => document.visibilityState)})`;

describe("File tabs", () => {
  let sessionId = "";

  before(async () => {
    const project = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!;
    const created = rpc<{ id: string; path: string }>(w, "session.create", { project_id: project.id, name: NAME, agent: "none" });
    sessionId = created.id;
    mkdirSync(join(created.path, "src"));
    file = join(created.path, "src", "app.ts");
    writeFileSync(file, "const answer = 42;\n");
    writeFileSync(join(created.path, "GUIDE.md"), "# Getting started\n\nRun the app.\n");
    await $(sel.sessionRow(NAME)).click();
    await $('//button[@role="tab"][normalize-space()="Files"]').click();
  });

  after(async () => {
    rpc(w, "session.archive", { id: sessionId });
    await expect($(sel.sessionRow(NAME))).not.toBeExisting({ wait: 30_000 });
  });

  it("opens a clicked file as a tab of the main window, coloured with Dark+", async () => {
    await row("src").click();
    await row("app.ts").click();
    await expect(fileTab()).toBeDisplayed();
    await expect(fileTab()).toHaveAttribute("aria-current", "true");
    await browser.waitUntil(async () => (await editorText()).includes("const answer = 42;"), { timeoutMsg: await drawn("the file's text never showed") });
    // Dark+: keywords #569CD6, numbers #B5CEA8.
    await browser.waitUntil(async () => (await tokenColour("const")) === "rgb(86, 156, 214)", { timeoutMsg: await drawn("const is not Dark+ blue") });
    expect(await tokenColour("42")).toBe("rgb(181, 206, 168)");
  });

  it("recolours the open file when another theme is picked in Settings", async () => {
    try {
      await setTheme("github-dark");
      // GitHub Dark: keywords #F97583.
      await browser.waitUntil(async () => (await tokenColour("const")) === "rgb(249, 117, 131)", { timeoutMsg: await drawn("const did not turn GitHub Dark red") });
    } finally {
      // Settings outlive the run (localStorage), so the default comes back.
      await setTheme("dark-plus");
    }
    await browser.waitUntil(async () => (await tokenColour("const")) === "rgb(86, 156, 214)", { timeoutMsg: await drawn("const did not turn back to Dark+ blue") });
  });

  it("switches to the open tab when the file is clicked again", async () => {
    await row("app.ts").click();
    await expect($$(`//div[@title=${JSON.stringify(file)}][.//button[@title="Close tab"]]`)).toBeElementsArrayOfSize(1);
  });

  it("edits the file and saves it with ⌘S", async () => {
    await focusEditor();
    await browser.keys(["Meta", "ArrowDown"]);
    await browser.keys("let total = answer + 1;");
    await expect($('span[aria-label="unsaved"]')).toBeExisting();
    await commandS();
    await browser.waitUntil(() => readFileSync(file, "utf8").includes("let total = answer + 1;"), { timeoutMsg: "⌘S did not write the file" });
    await expect($('span[aria-label="unsaved"]')).not.toBeExisting();
  });

  it("asks before closing a tab with unsaved edits, and keeps it on cancel", async () => {
    await focusEditor();
    await browser.keys("// draft");
    await expect($('span[aria-label="unsaved"]')).toBeExisting();
    await browser.execute((p: string) => {
      const tab = document.evaluate(`//div[@title="${p}"]//button[@title="Close tab"]`, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement;
      tab.click();
    }, file);
    await expect($(sel.confirm("Unsaved changes"))).toBeDisplayed();
    await $(sel.confirmButton("Cancel")).click();
    await expect(fileTab()).toBeDisplayed();
    await browser.execute((p: string) => {
      const tab = document.evaluate(`//div[@title="${p}"]//button[@title="Close tab"]`, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement;
      tab.click();
    }, file);
    await $(sel.confirmButton("Discard")).click();
    await expect(fileTab()).not.toBeExisting();
    expect(readFileSync(file, "utf8")).not.toContain("// draft");
  });

  it("previews a markdown file in its own tab, and goes back to its source", async () => {
    await row("GUIDE.md").click();
    const tab = $('//div[@title][.//span[normalize-space()="GUIDE.md"]][.//button[@title="Close tab"]]');
    await expect(tab).toHaveAttribute("aria-current", "true");
    await $(sel.button("Preview")).click();
    const frame = $('iframe[title="Markdown preview"]');
    await expect(frame).toBeDisplayed();
    await browser.waitUntil(async () => ((await frame.getAttribute("srcdoc")) ?? "").includes("<h1>Getting started</h1>"), { timeoutMsg: "the heading was never rendered" });
    // The right panel stays on its tab.
    await expect($('//button[@role="tab"][normalize-space()="Files"]')).toHaveAttribute("aria-selected", "true");
    await $(sel.button("Source")).click();
    await expect(frame).not.toBeExisting();
    await browser.waitUntil(async () => (await editorText()).includes("# Getting started"), { timeoutMsg: await drawn("the source never showed") });
  });
});
