// A design's comments (X65 entry 8): Comment mode pins a comment on a clicked
// element of the page, Send puts it in the design's chat as a Comment from
// the canvas card, and the Comments tab sends, sends all, resolves and shows
// the pins whose element is gone.

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, $$, browser, expect } from "@wdio/globals";
import { fill, rpc, sel, world } from "../fixtures";

const w = world();
const FAKE = join(w.root, "bin", "claude");
const workspaceId = () => rpc<{ id: string }[]>(w, "workspace.list", {})[0].id;
const mode = (label: string) => $(`//div[@role="group"][@aria-label="Mode"]/button[starts-with(@aria-label, "${label}")]`);
const SYSTEM = "comment-kit";
const dir = () => join(w.home, "design", workspaceId(), "designs", "settings-page");
// A nav filling the top of the page, so a click there is on it.
const page = (git = true) =>
  `<!doctype html>\n<html><head><meta charset="utf-8"><link rel="stylesheet" href="../../../systems/${SYSTEM}/styles.css"></head>\n<body data-mid="m1" style="margin:0"><nav data-mid="m12" style="display:block;height:400px;background:#333;color:#fff">General Appearance</nav><h2 data-mid="m25">Git</h2>${git ? '<p data-mid="m30">Warn before losing unpushed work</p>' : ""}</body></html>\n`;
const chat = () => $('//section[@aria-label="Design · Settings page"]');
const rail = () => $('//aside[@aria-label="Right rail"]');
const frame = () => $('//iframe[@title="index.html"]');
const box = () => $('//div[@role="dialog"][@aria-label="Comment"]');
const pins = () => JSON.parse(readFileSync(join(dir(), "comments.json"), "utf8")) as { n: number; sent_at: number | null; state: string }[];
const card = (n: number) => chat().$(`.//*[@data-comment-pin="${n}"]`);
/** A button inside an element, by its whole text. */
const inside = (text: string) => `.//button[normalize-space()="${text}"]`;
const row = () => $('//nav[@aria-label="Designs"]//button[.//span[normalize-space()="Settings page"]]');

// A design agent that ends each turn with a short answer. printf, because
// /bin/sh's echo expands the \n in the JSON.
const ANSWERING_CLAUDE = String.raw`#!/bin/sh
out() { printf '%s\n' "$1"; }
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) out '{"type":"system","subtype":"init","session_id":"e2e-comments","model":"e2e-model","permissionMode":"acceptEdits","slash_commands":[]}' ;;
    *'"type":"user"'*)
      out '{"type":"assistant","message":{"id":"a1","content":[{"type":"text","text":"Noted."}]}}'
      out '{"type":"result","subtype":"success","is_error":false,"usage":{}}' ;;
  esac
done
`;

/** `p`'s value, or "timed out" when it takes longer than `ms`. */
const within = <T>(ms: number, p: Promise<T>) => Promise.race([p, new Promise<"timed out">((r) => setTimeout(() => r("timed out"), ms))]);

describe("A design's comments", () => {
  let fake = "";
  before(async () => {
    fake = readFileSync(FAKE, "utf8");
    writeFileSync(FAKE, ANSWERING_CLAUDE);
    chmodSync(FAKE, 0o755);
    const ws = workspaceId();
    rpc(w, "design.system.create", { workspace: ws, name: "Comment kit", sources: [], agent: false });
    writeFileSync(join(w.home, "design", ws, "systems", SYSTEM, "styles.css"), "h2 { color: #d97757; }\n");
    rpc(w, "design.create", { workspace: ws, name: "Settings page", system: SYSTEM, brief: "A settings page" });
    writeFileSync(join(dir(), "pages", "index.html"), page());
    await mode("Design").click();
    await row().click();
    await expect(chat()).toBeDisplayed();
    await expect(frame()).toBeExisting();
  });

  after(async () => {
    writeFileSync(FAKE, fake);
    for (const d of rpc<{ slug: string }[]>(w, "design.list", { workspace: workspaceId() })) rpc(w, "design.remove", { workspace: workspaceId(), slug: d.slug });
    rpc(w, "design.system.remove", { workspace: workspaceId(), slug: SYSTEM });
    await within(5_000, (async () => {
      if (await mode("Sessions").isExisting()) await mode("Sessions").click();
    })());
  });

  it("switches to Comment mode with C, which the hint line explains", async () => {
    // Off the chat's input, where C is text.
    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
    await browser.keys("c");
    await expect($('//div[@aria-label="Canvas mode"]/button[@aria-pressed="true"]')).toHaveText(expect.stringContaining("Comment"));
    await expect($(sel.text("Hover outlines elements · click pins a comment · ⌥-click picks the parent"))).toBeDisplayed();
    await expect(rail()).toBeDisplayed();
  });

  // WebDriver's pointer never reaches the page: it is in a sandboxed frame on
  // another host, in its own web process, where WebDriver cannot switch to
  // and its pointer actions are not delivered (tried: a click at the frame's
  // place, at once after it loads and again every 150 ms). A pin is made
  // through design.comment.put, as the bridge's pick would make it; the
  // pick itself is tested on the bridge script in jsdom (designBridge.test.ts).
  it("opens a pin's comment box over the page, and Send puts it in the chat as a Comment from the canvas card", async () => {
    rpc(w, "design.comment.put", { workspace: workspaceId(), slug: "settings-page", new: { page: "index", mid: "m12", tag: "nav", text: "General Appearance", comment: "Collapse it" } });
    // Its pin over the page, where the bridge reports its element.
    await $('//button[@aria-label="Comment 1"]').click();
    await expect(box()).toHaveText(expect.stringContaining('nav · m12 · "General Appearance"'));
    await expect(box()).toHaveText(expect.stringContaining("⌘↵ sends to the chat"));
    await fill('//div[@role="dialog"][@aria-label="Comment"]//textarea', "Collapse into a menu on phone");
    await box().$(inside("Send")).click();
    await expect(box()).not.toBeExisting();
    await expect(card(1)).toBeDisplayed();
    await expect(card(1)).toHaveText(expect.stringContaining("Comment from the canvas"));
    await expect(card(1)).toHaveText(expect.stringContaining('Comment on index.html [data-mid=m12] (nav "General Appearance"): Collapse into a menu on phone'));
    await browser.waitUntil(() => typeof pins()[0]?.sent_at === "number", { timeoutMsg: "the pin was not marked sent" });
    const entry = rail().$('.//article[@aria-label="Comment 1"]');
    await expect(entry).toHaveText(expect.stringMatching(/Sent \d\d:\d\d/));
    await expect(entry).toHaveText(expect.stringContaining("Collapse into a menu on phone"));
    await expect(entry.$(inside("Show in chat"))).toBeDisplayed();
    await expect(row()).toHaveText(expect.stringContaining("1"));
  });

  it("lists kept pins as Not sent, and Send all sends them in one message, one line each", async () => {
    const ws = workspaceId();
    rpc(w, "design.comment.put", { workspace: ws, slug: "settings-page", new: { page: "index", mid: "m25", tag: "h2", text: "Git", comment: "Make Git the first section" } });
    rpc(w, "design.comment.put", { workspace: ws, slug: "settings-page", new: { page: "index", mid: "m30", tag: "p", text: "Warn before losing unpushed work", comment: "More space between the rows" } });
    const second = rail().$('.//article[@aria-label="Comment 2"]');
    await expect(second).toHaveText(expect.stringContaining("Not sent"));
    await expect(rail()).toHaveText(expect.stringContaining("2 not sent yet, one line each"));
    await rail().$(inside("Send all")).click();
    await expect(card(2)).toBeDisplayed();
    await expect(card(3)).toHaveText(expect.stringContaining('Comment on index.html [data-mid=m30] (p "Warn before losing unpushed work"): More space between the rows'));
    // One message: both cards in the same one.
    await expect(chat().$('.//*[@data-comment-pin="2"]/following-sibling::*[@data-comment-pin="3"]')).toBeExisting();
    await expect(rail()).toHaveText(expect.stringContaining("All sent"));
  });

  it("shows a sent pin's card in the chat", async () => {
    await rail().$('.//article[@aria-label="Comment 1"]').$(inside("Show in chat")).click();
    await expect(card(1)).toBeDisplayedInViewport();
  });

  it("resolves a pin, which moves to Resolved and off the design's count", async () => {
    await rail().$('.//article[@aria-label="Comment 1"]').$(inside("Resolve")).click();
    await expect(rail().$('.//article[@aria-label="Comment 1"]')).not.toBeExisting();
    await browser.waitUntil(() => pins().find((p) => p.n === 1)?.state === "resolved", { timeoutMsg: "the pin was not resolved" });
    await rail().$('.//button[starts-with(normalize-space(), "Resolved")]').click();
    await expect(rail().$('.//article[@aria-label="Comment 1"]')).toBeDisplayed();
    await rail().$('.//button[starts-with(normalize-space(), "Open")]').click();
    await expect(row()).toHaveText(expect.stringContaining("2"));
  });

  it("moves a pin whose element is gone after the page is written again to Orphaned", async () => {
    writeFileSync(join(dir(), "pages", "index.html"), page(false));
    const orphaned = rail().$('.//section[@aria-label="Orphaned"]');
    await expect(orphaned).toBeDisplayed();
    await expect(orphaned).toHaveText(expect.stringContaining("The element is gone after the last change"));
    await expect(orphaned.$('.//article[@aria-label="Comment 3"]')).toBeExisting();
    // The pin still on the page keeps its place over it after the reload.
    await expect($('//button[@aria-label="Comment 2"]')).toBeDisplayed();
    await orphaned.$(inside("Resolve")).click();
    await expect(orphaned).not.toBeExisting();
  });

  it("counts each page's open comments in Overview", async () => {
    await $('//nav[@aria-label="Pages"]//button[normalize-space()="Overview"]').click();
    await expect($('//button[@aria-label="index.html"]')).toHaveText(expect.stringContaining("1"));
    await expect($$('//button[@aria-label="index.html"]//*[@title="1 open comment"]')).toBeElementsArrayOfSize(1);
  });
});
