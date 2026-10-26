// A workspace design's screen (X65): made with the New design dialog, its
// agent's chat beside the canvas, which shows each page live at a viewport
// and zoom, every page in Overview, one bar at a time, and design.open.

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, $$, browser, expect } from "@wdio/globals";
import { fill, rpc, sel, SESSION, world } from "../fixtures";

const w = world();
const FAKE = join(w.root, "bin", "claude");
const workspaceId = () => rpc<{ id: string }[]>(w, "workspace.list", {})[0].id;
const mode = (label: string) => $(`//div[@role="group"][@aria-label="Mode"]/button[starts-with(@aria-label, "${label}")]`);
const SYSTEM = "screen-kit";
const BRIEF = "Settings page with a left nav and a Git section";
const dir = () => join(w.home, "design", workspaceId(), "designs", "settings-page");
const page = (title: string, body = "") =>
  `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="../../../systems/${SYSTEM}/styles.css"></head>\n<body data-mid="m1"><h1 data-mid="m2">${title}</h1>${body}</body></html>\n`;
const chat = () => $('//section[@aria-label="Design · Settings page"]');
const bar = () => $('//div[@role="status"][@data-tone]');
const frame = (title: string) => $(`//iframe[@title="${title}"]`);

// A design agent that stays at work on every message until it is
// interrupted; a message with ASK_FOR_APPROVAL makes it ask to run a command,
// and its answer ends the turn. printf, because /bin/sh's echo expands the \n
// in the JSON.
const ASK = "ASK_FOR_APPROVAL";
const WORKING_CLAUDE = String.raw`#!/bin/sh
out() { printf '%s\n' "$1"; }
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) out '{"type":"system","subtype":"init","session_id":"e2e-design","model":"e2e-model","permissionMode":"acceptEdits","slash_commands":[]}' ;;
    *'"subtype":"interrupt"'*) out '{"type":"result","subtype":"success","is_error":false,"usage":{}}' ;;
    *ASK_FOR_APPROVAL*)
      out '{"type":"assistant","message":{"id":"m2","content":[{"type":"tool_use","id":"b1","name":"Bash","input":{"command":"rm -rf assets"}}]}}'
      out '{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","tool_use_id":"b1","input":{"command":"rm -rf assets"}}}' ;;
    *'"type":"control_response"'*) out '{"type":"result","subtype":"success","is_error":false,"usage":{}}' ;;
  esac
done
`;

/** `p`'s value, or "timed out" when it takes longer than `ms`. */
const within = <T>(ms: number, p: Promise<T>) => Promise.race([p, new Promise<"timed out">((r) => setTimeout(() => r("timed out"), ms))]);

describe("A design's screen", () => {
  let blocked = "";
  before(async () => {
    blocked = readFileSync(FAKE, "utf8");
    writeFileSync(FAKE, WORKING_CLAUDE);
    chmodSync(FAKE, 0o755);
    rpc(w, "design.system.create", { workspace: workspaceId(), name: "Screen kit", sources: [], agent: false });
    writeFileSync(join(w.home, "design", workspaceId(), "systems", SYSTEM, "styles.css"), "h1 { color: #d97757; }\n");
  });

  after(async () => {
    writeFileSync(FAKE, blocked);
    for (const d of rpc<{ slug: string }[]>(w, "design.list", { workspace: workspaceId() })) rpc(w, "design.remove", { workspace: workspaceId(), slug: d.slug });
    for (const s of rpc<{ slug: string }[]>(w, "design.systems", { workspace: workspaceId() })) rpc(w, "design.system.remove", { workspace: workspaceId(), slug: s.slug });
    await within(5_000, (async () => {
      if (await mode("Sessions").isExisting()) await mode("Sessions").click();
    })());
  });

  it("makes a design with the New design dialog, and opens its screen with its agent's chat", async () => {
    await mode("Design").click();
    // New design waits for a design system to start from.
    const newDesign = $('//nav//button[starts-with(normalize-space(), "New design")][.//kbd]');
    await expect(newDesign).toBeEnabled();
    await newDesign.click();
    const dialog = $('//div[@role="dialog"][@aria-label="New design"]');
    await expect(dialog).toBeDisplayed();
    await expect(dialog.$(".//select")).toHaveValue(SYSTEM);
    await expect(dialog).toHaveText(expect.stringContaining("Screen kit: 0 cards, 0 layouts, not synced yet"));
    await fill('//div[@role="dialog"]//input[@placeholder="Settings page"]', "Settings page");
    await fill('//div[@role="dialog"]//textarea[@aria-label="Brief"]', BRIEF);
    await dialog.$(sel.button("Create design")).click();
    await expect(dialog).not.toBeExisting();
    await expect(chat()).toBeDisplayed();
    await expect(chat()).toHaveText(expect.stringContaining("Screen kit · no pages yet"));
    await expect(chat().$(sel.text("The brief went with the design system's README.md and the design rules."))).toBeDisplayed();
    // The brief alone, not the README and the rules that went with it.
    await expect(chat().$(sel.text(BRIEF))).toBeDisplayed();
    await expect($('//nav[@aria-label="Designs"]//button[.//span[normalize-space()="Settings page"]]')).toHaveAttribute("aria-current", "page");
    await expect($(sel.text("Claude is writing index.html"))).toBeDisplayed();
  });

  it("shows the orange bar while its agent works, and Stop stops it", async () => {
    await expect(bar()).toHaveAttribute("data-tone", "orange");
    await expect(bar()).toHaveText(expect.stringContaining("Claude is changing the design. Edit mode opens when it stops; comments still work"));
    await bar().$(sel.button("Stop")).click();
    await expect(bar()).not.toBeExisting();
  });

  it("opens the folded chat when its agent asks for an approval, with the orange bar, and leaves it folded while it still waits", async () => {
    await chat().$('.//button[@title="Hide chat (⌘\\)"]').click();
    await expect(chat()).not.toBeExisting();
    const agent = rpc<{ agent: number }[]>(w, "design.list", { workspace: workspaceId() })[0].agent;
    rpc(w, "chat.send", { id: agent, text: `${ASK} please`, images: [] });
    await expect(chat()).toBeDisplayed();
    await expect(bar()).toHaveAttribute("data-tone", "orange");
    await expect(bar()).toHaveText(expect.stringContaining("Claude needs your approval"));
    await expect($('//nav[@aria-label="Designs"]//button[.//span[normalize-space()="Settings page"]]')).toHaveText(expect.stringContaining("needs you"));
    // Folded again while the agent still waits, a new listing leaves it folded.
    await chat().$('.//button[@title="Hide chat (⌘\\)"]').click();
    writeFileSync(join(dir(), "comments.json"), "[]\n");
    await browser.pause(1_000);
    await expect(chat()).not.toBeExisting();
    await $('//button[@title="Show chat (⌘\\)"]').click();
    await chat().$(sel.button("Deny")).click();
    await expect(bar()).not.toBeExisting();
  });

  it("shows the page once it is written, and loads it again when it is written again", async () => {
    writeFileSync(join(dir(), "pages", "index.html"), page("Settings"));
    await expect(frame("index.html")).toBeExisting();
    await expect(frame("index.html")).toHaveAttribute("src", expect.stringContaining(`.${workspaceId()}/designs/settings-page/pages/index.html`));
    await expect(frame("index.html")).toHaveAttribute("sandbox", "allow-scripts");
    const first = await frame("index.html").getAttribute("src");
    writeFileSync(join(dir(), "pages", "index.html"), page("Settings, again"));
    await browser.waitUntil(async () => (await frame("index.html").getAttribute("src")) !== first, { timeoutMsg: "the page did not load again" });
    await expect($(sel.text("index.html"))).toBeDisplayed();
  });

  it("switches the viewport, which design.toml keeps, and zooms", async () => {
    await $('//button[@aria-label="Viewport"]').click();
    await $('//button[starts-with(normalize-space(), "Phone")]').click();
    await expect($('//button[@aria-label="Viewport"]')).toHaveText(expect.stringContaining("390×844"));
    await browser.waitUntil(() => readFileSync(join(dir(), "design.toml"), "utf8").includes('viewport = "390x844"'), { timeoutMsg: "the viewport was not saved" });
    const fit = $('//button[@title="Fit (⌘0)"]');
    await expect(fit).toHaveAttribute("aria-pressed", "true");
    const fitted = await fit.getText();
    await $('//button[@title="Zoom in (⌘=)"]').click();
    await expect(fit).toHaveAttribute("aria-pressed", "false");
    expect(await fit.getText()).not.toBe(fitted);
    await browser.keys(["Meta", "0"]);
    await expect(fit).toHaveAttribute("aria-pressed", "true");
    await expect(fit).toHaveText(fitted);
  });

  it("keeps a custom size in the app's settings, listed after the presets", async () => {
    await $('//button[@aria-label="Viewport"]').click();
    await $('//button[starts-with(normalize-space(), "Custom size")]').click();
    await fill('//div[@role="dialog"][@aria-label="Custom viewport"]//input[@aria-label="Width"]', "1024");
    await fill('//div[@role="dialog"][@aria-label="Custom viewport"]//input[@aria-label="Height"]', "768");
    await $('//div[@role="dialog"][@aria-label="Custom viewport"]').$(sel.button("Use this size")).click();
    await expect($('//button[@aria-label="Viewport"]')).toHaveText(expect.stringContaining("Custom 1024×768"));
    await browser.waitUntil(() => readFileSync(join(dir(), "design.toml"), "utf8").includes('viewport = "1024x768"'), { timeoutMsg: "the viewport was not saved" });
    await $('//button[@aria-label="Viewport"]').click();
    await $('//button[starts-with(normalize-space(), "Phone")]').click();
    await $('//button[@aria-label="Viewport"]').click();
    await expect($('//button[starts-with(normalize-space(), "Custom")][contains(normalize-space(), "1024×768")]')).toBeDisplayed();
    await browser.keys("Escape");
  });

  it("shows every page in Overview with its label and open comments, and opens one from there", async () => {
    // An open comment counts on the design's row, and on its page.
    writeFileSync(join(dir(), "comments.json"), '[{"n": 1, "page": "git-a", "mid": "m2", "tag": "h1", "comment": "Tighter", "state": "open"}]\n');
    writeFileSync(join(dir(), "pages", "git-a.html"), page("Git, cards"));
    writeFileSync(join(dir(), "design.toml"), `${readFileSync(join(dir(), "design.toml"), "utf8")}\n[pages.git-a]\nlabel = "cards"\n`);
    await $('//nav[@aria-label="Pages"]//button[normalize-space()="git-a"]').waitForExist();
    await $('//nav[@aria-label="Pages"]//button[normalize-space()="Overview"]').click();
    const tile = $('//button[@aria-label="git-a.html"]');
    await expect(tile).toHaveText(expect.stringContaining("cards"));
    await expect(tile.$('.//*[@title="1 open comment"]')).toBeDisplayed();
    await expect($('//button[@aria-label="index.html"]')).toHaveText("index.html");
    await expect($('//nav[@aria-label="Designs"]//button[.//span[normalize-space()="Settings page"]]')).toHaveText(expect.stringContaining("1"));
    await expect($$('//button[@aria-label="git-a.html" or @aria-label="index.html"]//iframe')).toBeElementsArrayOfSize(2);
    await tile.click();
    await expect($('//nav[@aria-label="Pages"]//button[normalize-space()="git-a"]')).toHaveAttribute("aria-current", "page");
    await expect(frame("git-a.html")).toBeExisting();
  });

  it("shows its agent only in Design mode, never in the Sessions list", async () => {
    await mode("Sessions").click();
    await expect($(sel.sessionRow(SESSION))).toBeDisplayed();
    await expect($('//*[contains(normalize-space(), "Design · Settings page")]')).not.toBeExisting();
  });

  it("switches to a design on design.open", async () => {
    rpc(w, "design.open", { workspace: workspaceId(), slug: "settings-page" });
    await expect(mode("Design")).toHaveAttribute("aria-pressed", "true");
    await expect(chat()).toBeDisplayed();
  });

  it("offers a design an agent started in a toast, and leaves the focus where it is", async () => {
    const agent = rpc<{ agent: number }[]>(w, "design.list", { workspace: workspaceId() })[0].agent;
    rpc(w, "design.create", { workspace: workspaceId(), name: "Onboarding", system: SYSTEM, brief: "Welcome screens", spawned_by: agent });
    const toast = $('//div[button[normalize-space()="Open"]][contains(normalize-space(), "An agent started the design Onboarding")]');
    await expect(toast).toBeDisplayed();
    await expect(chat()).toBeDisplayed();
    await toast.$(sel.button("Open")).click();
    await expect($('//section[@aria-label="Design · Onboarding"]')).toBeDisplayed();
    await $('//nav[@aria-label="Designs"]//button[.//span[normalize-space()="Settings page"]]').click();
    await expect(chat()).toBeDisplayed();
  });

  it("shows the grey bar once its design system is removed", async () => {
    rpc(w, "design.system.remove", { workspace: workspaceId(), slug: SYSTEM });
    await expect(bar()).toHaveAttribute("data-tone", "grey");
    await expect(bar()).toHaveText(expect.stringContaining(`Design system removed. Pages show without Screen kit's styles.`));
  });

  it("leaves the window answering while a page never stops running", async () => {
    writeFileSync(join(dir(), "pages", "loop.html"), page("Loop", "<script>for (;;) {}</script>"));
    await $('//nav[@aria-label="Pages"]//button[normalize-space()="loop"]').click();
    await expect(frame("loop.html")).toBeExisting();
    await browser.pause(2_000);
    const answered = await within(2_000, browser.execute(() => document.title));
    expect(answered).not.toBe("timed out");
    const clicked = await within(5_000, $('//nav[@aria-label="Pages"]//button[normalize-space()="index"]').click());
    expect(clicked).not.toBe("timed out");
    await expect(frame("index.html")).toBeExisting();
  });
});
