// A chat's transcript loads when the chat is shown (X81), not when the app
// connects: a chat that answered while another session was open shows its
// conversation once its session opens. A fake `claude` answers at once.

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { PROJECT, SESSION as OTHER_SESSION, rpc, sel, world } from "../fixtures";

const w = world();
const FAKE = join(w.root, "bin", "claude");
const SESSION = "Check the transcript loads";
const ANSWER = "The transcript came from the daemon when the chat was shown.";

/** An init, then for any message an answer. printf, because /bin/sh's echo
 *  expands the \n in the JSON. */
const FAKE_CLAUDE = String.raw`#!/bin/sh
out() { printf '%s\n' "$1"; }
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) out '{"type":"system","subtype":"init","session_id":"e2e-x81","model":"e2e-model","slash_commands":[]}' ;;
    *'"type":"user"'*)
      out '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"The transcript came from the daemon when the chat was shown."}]}}'
      out '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.01,"usage":{"input_tokens":3,"output_tokens":2}}' ;;
  esac
done
`;

describe("a chat's transcript (X81)", () => {
  let blocked = "";
  let sessionId = "";

  before(async () => {
    blocked = readFileSync(FAKE, "utf8");
    writeFileSync(FAKE, FAKE_CLAUDE);
    chmodSync(FAKE, 0o755);
    // Another session is open while the new one's chat answers.
    await $(sel.sessionRow(OTHER_SESSION)).click();
    const project = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!;
    sessionId = rpc<{ id: string }>(w, "session.create", { project_id: project.id, name: SESSION, agent: "claude", prompt: "Where does the transcript come from?" }).id;
    await browser.waitUntil(
      () => {
        const chat = rpc<{ id: number; chat: boolean; session_id?: string }[]>(w, "terminal.list", {}).find((t) => t.chat && t.session_id === sessionId);
        const st = chat && rpc<{ items: { text: string }[] }>(w, "chat.state", { id: chat.id });
        return !!st?.items.some((i) => i.text === ANSWER);
      },
      { timeout: 30_000, timeoutMsg: "the chat never answered" },
    );
  });

  after(async () => {
    rpc(w, "session.archive", { id: sessionId });
    await expect($(sel.sessionRow(SESSION))).not.toBeExisting();
    writeFileSync(FAKE, blocked);
  });

  it("loads a chat's transcript when the chat is shown", async () => {
    await expect($(sel.text(ANSWER))).not.toBeExisting();
    await $(sel.sessionRow(SESSION)).click();
    // The repo's setup script opens first; the conversation is the next tab.
    // Tabs switch on mousedown, which the embedded driver's click does not send.
    await browser.waitUntil(
      async () => {
        await browser.execute(() => {
          const tab = document.evaluate('//span[normalize-space()="claude"]', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
          tab?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        });
        return $(sel.text(ANSWER)).isDisplayed();
      },
      { timeout: 30_000, timeoutMsg: "the chat's transcript never showed" },
    );
  });

  it("shows the transcript again when its session opens again", async () => {
    await $(sel.sessionRow(OTHER_SESSION)).click();
    await expect($(sel.text(ANSWER))).not.toBeDisplayed();
    await $(sel.sessionRow(SESSION)).click();
    await expect($(sel.text(ANSWER))).toBeDisplayed({ wait: 10_000 });
  });
});
