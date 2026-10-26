// A design's page that does not load (X65 entry 13): the red "did not load"
// bar over the canvas, and its Ask the agent to fix.
//
// A page the scheme cannot serve comes as a page of moonlet's that tells
// the canvas why as it loads, so the bar shows in a hidden window too. A
// page whose bridge is silent fails only after a wait in a visible window:
// WebKit suspends a hidden window's frames about 2 s after they load, and
// the e2e window is often hidden (the screen locked, or covered), so that
// path is tested in lib/designLoad.test.ts, and here only when the window
// shows.

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { within } from "../design";
import { rpc, sel, world } from "../fixtures";

const w = world();
const FAKE = join(w.root, "bin", "claude");
const workspaceId = () => rpc<{ id: string }[]>(w, "workspace.list", {})[0].id;
const mode = (label: string) => $(`//div[@role="group"][@aria-label="Mode"]/button[starts-with(@aria-label, "${label}")]`);
const SYSTEM = "load-kit";
const dir = () => join(w.home, "design", workspaceId(), "designs", "settings-page");
const pageFile = (name: string) => join(dir(), "pages", `${name}.html`);
const bar = () => $('//div[@role="status"][@data-tone]');
const tab = (name: string) => $(`//nav[@aria-label="Pages"]//button[normalize-space()="${name}"]`);
const chat = () => $('//section[@aria-label="Design · Settings page"]');
const page = (title: string, body = "") => `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title}</title></head>\n<body data-mid="m1"><h1 data-mid="m2">${title}</h1>${body}</body></html>\n`;

// A design agent that logs each message it gets and ends each turn with a
// short answer. printf, because /bin/sh's echo expands the \n in the JSON.
const LOGGING_CLAUDE = String.raw`#!/bin/sh
out() { printf '%s\n' "$1"; }
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) out '{"type":"system","subtype":"init","session_id":"e2e-load","model":"e2e-model","permissionMode":"acceptEdits","slash_commands":[]}' ;;
    *'"type":"user"'*)
      printf '%s\n' "$line" >> "$0.log"
      out '{"type":"assistant","message":{"id":"a1","content":[{"type":"text","text":"Noted."}]}}'
      out '{"type":"result","subtype":"success","is_error":false,"usage":{}}' ;;
  esac
done
`;

describe("A design's page that does not load", () => {
  let fake = "";
  const said = () => (existsSync(`${FAKE}.log`) ? readFileSync(`${FAKE}.log`, "utf8") : "");

  before(async () => {
    fake = readFileSync(FAKE, "utf8");
    writeFileSync(FAKE, LOGGING_CLAUDE);
    chmodSync(FAKE, 0o755);
    const ws = workspaceId();
    rpc(w, "design.system.create", { workspace: ws, name: "Load kit", sources: [], agent: false });
    writeFileSync(join(w.home, "design", ws, "systems", SYSTEM, "styles.css"), "h1 { color: #d97757; }\n");
    rpc(w, "design.create", { workspace: ws, name: "Settings page", system: SYSTEM, brief: "A settings page" });
    // A slip a browser recovers from: no space after a quoted value.
    writeFileSync(pageFile("index"), page("Settings", '<p data-mid="m3" class="a"title="b">Tom & Jerry</div>'));
    writeFileSync(pageFile("locked"), page("Locked"));
    await mode("Design").click();
    await $('//nav[@aria-label="Designs"]//button[.//span[normalize-space()="Settings page"]]').click();
    await expect(chat()).toBeDisplayed();
    await expect($('//iframe[@title="index.html"]')).toBeExisting();
  });

  after(async () => {
    writeFileSync(FAKE, fake);
    if (existsSync(pageFile("locked"))) chmodSync(pageFile("locked"), 0o644);
    for (const d of rpc<{ slug: string }[]>(w, "design.list", { workspace: workspaceId() })) rpc(w, "design.remove", { workspace: workspaceId(), slug: d.slug });
    rpc(w, "design.system.remove", { workspace: workspaceId(), slug: SYSTEM });
    await within(5_000, (async () => {
      if (await mode("Sessions").isExisting()) await mode("Sessions").click();
    })());
  });

  it("shows no bar for a page that loads, whatever slips its HTML has", async () => {
    // Longer than the canvas waits for the bridge's answer.
    await browser.pause(4_000);
    await expect(bar()).not.toBeExisting();
  });

  it("shows the red did-not-load bar, saying why, for a page whose file cannot be read", async () => {
    chmodSync(pageFile("locked"), 0o000);
    await tab("locked").click();
    await expect($('//iframe[@title="locked.html"]')).toBeExisting();
    await expect(bar()).toHaveAttribute("data-tone", "red");
    await expect(bar()).toHaveText(expect.stringContaining("locked.html did not load. the file cannot be read"));
    await expect(bar().$(sel.button("Ask the agent to fix"))).toBeDisplayed();
  });

  it("asks the agent to fix the page, naming it and why it did not load", async () => {
    await bar().$(sel.button("Ask the agent to fix")).click();
    await browser.waitUntil(() => said().includes("pages/locked.html did not load in the canvas: the file cannot be read. Fix the page so it loads, then run the check again."), {
      timeoutMsg: `the agent was not asked to fix the page:\n${said()}`,
    });
  });

  it("shows the bar gone once the page loads again", async () => {
    chmodSync(pageFile("locked"), 0o644);
    writeFileSync(pageFile("locked"), page("Locked, fixed"));
    await expect(bar()).not.toBeExisting();
  });

  it("shows a page whose markup swallows the bridge as not loaded, with its first parse error and line, when the window shows", async function () {
    if ((await browser.execute(() => document.visibilityState)) !== "visible") return this.skip();
    writeFileSync(pageFile("swallowed"), '<!doctype html>\n<html lang="en><head><meta charset="utf-8">\n<body data-mid="m1"><h1 data-mid="m2">Swallowed</h1></body></html>\n');
    await tab("swallowed").click();
    await expect(bar()).toHaveText(expect.stringContaining("swallowed.html did not load. no space after an attribute's quoted value at line 2"), { wait: 10_000 });
  });
});
