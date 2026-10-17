// Queued messages, Send now and Ask aside (X49), with a fake `claude` that
// holds a long command open, the way Claude Code 2.1.301 queues a message
// sent during a tool call.

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { PROJECT, fill, hover, rpc, sel, world } from "../fixtures";

const w = world();
const FAKE = join(w.root, "bin", "claude");
const SESSION = "Move the api port";
const PORT = "wait, which port did we end up on for the api?";
const QUEUE_EDITOR = '//textarea[@placeholder="Queue a message for Claude"]';
const QUEUED = '//section[@aria-label="Queued messages"]';
const ASIDE = '//section[@aria-label="Aside"]';

/** Runs `pnpm stack:check` for the first message and never finishes it, so
 *  later messages wait in the queue. Send now stops it and answers;
 *  cancel_async_message withdraws a message; a `--fork-session` run is an
 *  aside. printf, because /bin/sh's echo expands the \n in the JSON. */
const FAKE_CLAUDE = String.raw`#!/bin/sh
out() { printf '%s\n' "$1"; }
field() { printf '%s' "$1" | sed 's/.*"'"$2"'":"\([^"]*\)".*/\1/'; }
case "$*" in
  *--fork-session*) out '{"type":"result","subtype":"success","is_error":false,"result":"**4000.** You moved it from 3001 earlier in this session.","duration_ms":3200,"total_cost_usd":0.0015}'; exit 0 ;;
esac
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) out '{"type":"system","subtype":"init","session_id":"e2e-queue","model":"e2e-model","slash_commands":[]}' ;;
    *'"subtype":"cancel_async_message"'*)
      out '{"type":"control_response","response":{"subtype":"success","request_id":"'"$(field "$line" request_id)"'","response":{"cancelled":true}}}'
      out '{"type":"command_lifecycle","command_uuid":"'"$(field "$line" message_uuid)"'","state":"cancelled"}' ;;
    *'"send_now":true'*)
      out '{"type":"control_response","response":{"subtype":"success","request_id":"'"$(field "$line" request_id)"'","response":{"still_queued":[],"send_now":"stopped"}}}'
      out '{"type":"result","subtype":"error_during_execution","is_error":true,"usage":{}}'
      out '{"type":"command_lifecycle","command_uuid":"'"$(field "$line" message_uuid)"'","state":"started"}'
      out '{"type":"assistant","message":{"id":"m2","content":[{"type":"text","text":"The api is on port 4000."}]}}'
      out '{"type":"result","subtype":"success","is_error":false,"usage":{}}' ;;
    *'Run the full stack check'*)
      out '{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"b1","name":"Bash","input":{"command":"pnpm stack:check"}}]}}' ;;
  esac
done
`;

async function press(key: string, mods: { altKey?: boolean } = {}) {
  await browser.execute(
    (k: string, m: object) => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...m })),
    key,
    mods,
  );
}

describe("queued messages", () => {
  let blocked = "";
  let sessionId = "";

  before(async () => {
    blocked = readFileSync(FAKE, "utf8");
    writeFileSync(FAKE, FAKE_CLAUDE);
    chmodSync(FAKE, 0o755);
    // A background window holds CSS animations, which would keep the cards at opacity 0.
    await browser.execute(() => {
      const style = document.createElement("style");
      style.id = "no-card-in";
      style.textContent = ".moonlet-card-in { animation: none !important; }";
      document.head.appendChild(style);
    });
    const project = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!;
    sessionId = rpc<{ id: string }>(w, "session.create", { project_id: project.id, name: SESSION, agent: "claude", prompt: "Run the full stack check before we push." }).id;
    await $(sel.sessionRow(SESSION)).click();
    // Tabs switch on mousedown, which the embedded driver's click does not send.
    await browser.execute(() => {
      const tab = document.evaluate('//span[normalize-space()="claude"]', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      tab?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await expect($(QUEUE_EDITOR)).toBeDisplayed({ wait: 30_000 });
  });

  after(async () => {
    rpc(w, "session.archive", { id: sessionId });
    await expect($(sel.sessionRow(SESSION))).not.toBeExisting();
    writeFileSync(FAKE, blocked);
    await browser.execute(() => document.getElementById("no-card-in")?.remove());
  });

  it("shows a message sent during a command as queued, with Send now and Ask aside", async () => {
    await fill(QUEUE_EDITOR, PORT);
    await press("Enter");
    await expect($(`${QUEUED}//*[normalize-space()="Queued · Claude reads it after pnpm stack:check"]`)).toBeDisplayed();
    await expect($(`${QUEUED}//div[normalize-space()=${JSON.stringify(PORT)}]`)).toBeDisplayed();
    await expect($(`${QUEUED}${sel.button("Send now")}`)).toBeDisplayed();
    await expect($(`${QUEUED}${sel.button("Ask aside")}`)).toBeDisplayed();
    await expect($(sel.text("· 1 queued"))).toBeDisplayed();
  });

  it("puts Working, the queue count and Stop on a line above the input (X51)", async () => {
    const status = '//section[@aria-label="Chat input"]/div[@role="status"]';
    await expect($(`${status}//span[normalize-space()="Working"]`)).toBeDisplayed();
    await expect($(`${status}//span[normalize-space()="· 1 queued"]`)).toBeDisplayed();
    await expect($(`${status}${sel.button("Stop")}`)).toBeDisplayed();
  });

  it("warns that Send now stops the command while it is pointed at", async () => {
    await hover($(`${QUEUED}${sel.button("Send now")}`));
    await expect($(`${QUEUED}/div[1]`)).toHaveText(/^Send now stops pnpm stack:check \(running \d+:\d\d\)$/);
  });

  it("asks the typed text aside with ⌥↵ and closes the card with esc", async () => {
    await fill(QUEUE_EDITOR, "and the web port?");
    await press("Enter", { altKey: true });
    await expect($(`${ASIDE}//*[normalize-space()="and the web port?"]`)).toBeDisplayed();
    await expect($(`${ASIDE}//*[normalize-space()="4000. You moved it from 3001 earlier in this session."]`)).toBeDisplayed();
    await expect($(`${ASIDE}//*[normalize-space()="3s · $0.0015"]`)).toBeDisplayed();
    await press("Escape");
    await expect($(ASIDE)).not.toBeExisting();
    await expect($(QUEUED)).toBeDisplayed();
  });

  it("takes the message out of Claude's queue to ask it aside, and puts it back", async () => {
    await $(`${QUEUED}${sel.button("Ask aside")}`).click();
    await expect($(`${ASIDE}//*[normalize-space()=${JSON.stringify(PORT)}]`)).toBeDisplayed();
    await expect($(QUEUED)).not.toBeExisting();
    await $(`${ASIDE}${sel.button("Queue for Claude")}`).click();
    await expect($(ASIDE)).not.toBeExisting();
    await expect($(`${QUEUED}//div[normalize-space()=${JSON.stringify(PORT)}]`)).toBeDisplayed();
  });

  it("delivers the message with Send now and marks where the command stopped", async () => {
    await $(`${QUEUED}${sel.button("Send now")}`).click();
    await expect($(sel.text("The api is on port 4000."))).toBeDisplayed();
    await expect($(QUEUED)).not.toBeExisting();
    await expect($('//div[starts-with(normalize-space(), "Interrupted by you")]')).toHaveText(/^Interrupted by you · pnpm stack:check stopped at \d+:\d\d$/);
    await expect($(`//div[contains(@class, "bg-raised")][normalize-space()=${JSON.stringify(PORT)}]`)).toBeDisplayed();
  });
});
