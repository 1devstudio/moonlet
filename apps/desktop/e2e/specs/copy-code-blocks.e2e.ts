// The copy icon on a code block in an agent's reply (X87), with a fake
// `claude` that answers with one fenced block.

import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { PROJECT, rpc, sel, world } from "../fixtures";

const w = world();
const FAKE = join(w.root, "bin", "claude");
const SESSION = "Copy a code block";
const CODE = 'pnpm install\n\npnpm test -- --run "a b"';

/** Answers any message with a sentence, a fenced block and a closing line.
 *  printf, because /bin/sh's echo expands the \n in the JSON. */
const FAKE_CLAUDE = String.raw`#!/bin/sh
out() { printf '%s\n' "$1"; }
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) out '{"type":"system","subtype":"init","session_id":"e2e-x87","model":"e2e-model","slash_commands":[]}' ;;
    *'"type":"user"'*)
      out '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Run these from the repo root:\n\n` + "```sh" + String.raw`\npnpm install\n\npnpm test -- --run \"a b\"\n` + "```" + String.raw`\n\nThen open the app."}]}}'
      out '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.01,"usage":{"input_tokens":3,"output_tokens":2}}' ;;
  esac
done
`;

const CONTROL = '//div[contains(@class, "code-block")]/span[@aria-label="Copy code"]';
const clipboard = () => execFileSync("pbpaste", { encoding: "utf8" });
const clearClipboard = () => execFileSync("pbcopy", { input: "cleared" });

describe("copying a code block (X87)", () => {
  let blocked = "";
  let sessionId = "";

  before(async () => {
    blocked = readFileSync(FAKE, "utf8");
    writeFileSync(FAKE, FAKE_CLAUDE);
    chmodSync(FAKE, 0o755);
    const project = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!;
    sessionId = rpc<{ id: string }>(w, "session.create", { project_id: project.id, name: SESSION, agent: "claude", prompt: "How do I run the tests?" }).id;
    await $(sel.sessionRow(SESSION)).click();
    // Tabs switch on mousedown, which the embedded driver's click does not send.
    await browser.execute(() => {
      const tab = document.evaluate('//span[normalize-space()="claude"]', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      tab?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await expect($(CONTROL)).toBeExisting({ wait: 30_000 });
  });

  after(async () => {
    rpc(w, "session.archive", { id: sessionId });
    await expect($(sel.sessionRow(SESSION))).not.toBeExisting();
    writeFileSync(FAKE, blocked);
  });

  it("copies the block's code on a click and says so", async () => {
    clearClipboard();
    await $(CONTROL).click();
    await expect($(sel.text("Copied code"))).toBeDisplayed();
    expect(clipboard()).toBe(CODE);
  });

  it("copies the block's code on Enter or Space on the focused control", async () => {
    for (const key of ["Enter", " "]) {
      clearClipboard();
      await browser.execute((xp: string) => (document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement).focus(), CONTROL);
      await browser.keys(key);
      await browser.waitUntil(() => clipboard() !== "cleared", { timeout: 5000, timeoutMsg: `${JSON.stringify(key)} copied nothing` });
      expect(clipboard()).toBe(CODE);
    }
  });
});
