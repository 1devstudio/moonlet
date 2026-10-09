// Collapsed tool calls and thinking rows in the agent view (X14) and the
// footer under the final message (X16), with a fake `claude` that replays
// one recorded-style turn.

import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, $$, browser, expect } from "@wdio/globals";
import { PROJECT, SESSION as OTHER_SESSION, choose, fill, rpc, sel, world } from "../fixtures";

const w = world();
const FAKE = join(w.root, "bin", "claude");
const SESSION = "Check the login page";
const THOUGHT = "The resume URL is session-bound so I cannot fetch it. Try the probe with cookies kept.";
const ANSWER = "Found the error, and it is a one-setting fix.";

/** Speaks just enough stream-json: an init, then for any message a turn of
 *  thinking, two Bash calls and an answer. printf, because /bin/sh's echo
 *  expands the \n in the JSON. */
const FAKE_CLAUDE = String.raw`#!/bin/sh
out() { printf '%s\n' "$1"; }
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) out '{"type":"system","subtype":"init","session_id":"e2e-1","model":"e2e-model","slash_commands":[]}' ;;
    *'"type":"user"'*)
      out '{"type":"assistant","message":{"id":"m1","content":[{"type":"thinking","thinking":"The resume URL is session-bound so I cannot fetch it.\nTry the probe with cookies kept."},{"type":"tool_use","id":"b1","name":"Bash","input":{"command":"echo first\necho the-tail-the-row-cuts-off"}}]}}'
      out '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"b1","content":"first-output"}]}}'
      out '{"type":"assistant","message":{"id":"m2","content":[{"type":"tool_use","id":"b2","name":"Bash","input":{"command":"echo second"}}]}}'
      out '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"b2","content":"second-output"}]}}'
      out '{"type":"assistant","message":{"id":"m3","content":[{"type":"text","text":"Found the error, and it is a one-setting fix."}]}}'
      out '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.01,"usage":{"input_tokens":3,"output_tokens":2}}' ;;
  esac
done
`;

const bashRows = () => $$('//button[.//span[normalize-space()="Bash"]]');
const toolSetting = '//div[@role="dialog"]//label[span[normalize-space()="Tool calls in the conversation"]]//select';

async function setToolCalls(value: "collapsed" | "expanded") {
  await $('button[title="Settings (⌘,)"]').click();
  await choose(toolSetting, value);
  await $('[role="dialog"][aria-label="Settings"] button[title="Close"]').click();
}

describe("agent view", () => {
  let blocked = "";
  let sessionId = "";

  before(async () => {
    blocked = readFileSync(FAKE, "utf8");
    writeFileSync(FAKE, FAKE_CLAUDE);
    chmodSync(FAKE, 0o755);
    const project = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!;
    sessionId = rpc<{ id: string }>(w, "session.create", { project_id: project.id, name: SESSION, agent: "claude", prompt: "Why does login fail?" }).id;
    await $(sel.sessionRow(SESSION)).click();
    // The repo's setup script opens first; the conversation is the next tab.
    // Tabs switch on mousedown, which the embedded driver's click does not send.
    await browser.execute(() => {
      const tab = document.evaluate('//span[normalize-space()="claude"]', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      tab?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await expect($(sel.text(ANSWER))).toBeDisplayed({ wait: 30_000 });
  });

  after(async () => {
    // Back to the default, and to a claude that can never run. The session's
    // view stays mounted while it exists, and later specs select by text.
    await setToolCalls("collapsed");
    rpc(w, "session.archive", { id: sessionId });
    await expect($(sel.sessionRow(SESSION))).not.toBeExisting();
    writeFileSync(FAKE, blocked);
  });

  it("folds the tool calls into one row and keeps text and thinking visible", async () => {
    await expect($(sel.button("2 tool calls"))).toBeDisplayed();
    await expect(bashRows()).toBeElementsArrayOfSize(0);
    await expect($('//button[.//span[normalize-space()="Thinking"]]')).toBeDisplayed();

    await $(sel.button("2 tool calls")).click();
    await expect(bashRows()).toBeElementsArrayOfSize(2);
    await bashRows()[0].click();
    await expect($(sel.text("first-output"))).toBeDisplayed();
  });

  it("shows the whole command when a Bash row is opened", async () => {
    // The row shows only the command's first line; the opened row shows all of it.
    await expect(bashRows()[0]).toHaveText(/echo first/);
    await expect(bashRows()[0]).not.toHaveText(/the-tail-the-row-cuts-off/);
    await expect($(`//pre[normalize-space()=${JSON.stringify("$ echo first echo the-tail-the-row-cuts-off")}]`)).toBeDisplayed();
  });

  it("shows the whole thought without a click, and folds it to one line on click", async () => {
    const row = '//button[.//span[normalize-space()="Thinking"]]';
    const body = `//div[not(ancestor::button)][normalize-space()=${JSON.stringify(THOUGHT)}]`;
    const preview = `${row}//span[normalize-space()=${JSON.stringify(THOUGHT)}]`;
    await expect($(body)).toBeDisplayed();
    await expect($(preview)).not.toBeExisting();
    await $(row).click();
    await expect($(body)).not.toBeExisting();
    await expect($(preview)).toBeDisplayed();
  });

  it("shows the response time under the answer and copies it", async () => {
    const footer = $(`//div[contains(@class, "chat-md")][normalize-space()=${JSON.stringify(ANSWER)}]/following-sibling::div[button[@title="Copy final message"]]`);
    // The fake turn is instant; the end time follows the system's locale.
    await expect(footer).toHaveText(/^\d+s · \S/);
    await $('button[title="Copy final message"]').click();
    await expect($(sel.text("Copied message"))).toBeDisplayed();
    expect(execFileSync("pbpaste", { encoding: "utf8" })).toBe(ANSWER);
  });

  it("keeps unsent text when another session opens and this one comes back", async () => {
    const editor = '//textarea[@placeholder="Ask for a change, @ to mention a file, / for commands"]';
    await fill(editor, "Also check the signup page");
    await $(sel.sessionRow(OTHER_SESSION)).click();
    await expect($(editor)).not.toBeExisting();
    await $(sel.sessionRow(SESSION)).click();
    await expect($(editor)).toHaveValue("Also check the signup page");
  });

  it("shows one row per call when Settings says Expanded", async () => {
    await setToolCalls("expanded");
    await expect($(sel.button("2 tool calls"))).not.toBeExisting();
    await expect(bashRows()).toBeElementsArrayOfSize(2);
    await expect($(sel.text(ANSWER))).toBeDisplayed();
  });
});
