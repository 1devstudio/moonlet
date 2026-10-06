// The plan approval card (X20), with a fake `claude` in Plan mode that
// proposes a plan for every message and answers the two ways a plan can be
// resolved: approved into Accept edits, or sent back with feedback.

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { PROJECT, fill, rpc, sel, world } from "../fixtures";

const w = world();
const FAKE = join(w.root, "bin", "claude");
const SESSION = "Add a dark theme";
const PLAN_FILE = "/tmp/plans/dark-theme.md";

/** Each message gets an ExitPlanMode ask. An approval with the setMode
 *  update reports Accept edits and starts implementing; the feedback is
 *  answered with a revision. printf, because /bin/sh's echo expands the \n
 *  in the JSON. */
const FAKE_CLAUDE = String.raw`#!/bin/sh
out() { printf '%s\n' "$1"; }
plan='{"plan":"# Add a dark theme\n\n- Add a ` + "`theme`" + String.raw` setting\n- Read it in **App**\n","planFilePath":"${PLAN_FILE}"}'
n=0
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) out '{"type":"system","subtype":"init","session_id":"e2e-plan","model":"e2e-model","permissionMode":"plan","slash_commands":[]}' ;;
    *'"setMode"'*)
      out '{"type":"system","subtype":"status","status":null,"permissionMode":"acceptEdits"}'
      out "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"p$n\",\"content\":\"User has approved your plan.\"}]}}"
      out "{\"type\":\"assistant\",\"message\":{\"id\":\"a$n\",\"content\":[{\"type\":\"text\",\"text\":\"Implementing the plan.\"}]}}"
      out '{"type":"result","subtype":"success","is_error":false,"usage":{}}' ;;
    *'Use a feature flag instead'*)
      out "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"p$n\",\"is_error\":true,\"content\":\"Use a feature flag instead\"}]}}"
      out "{\"type\":\"assistant\",\"message\":{\"id\":\"a$n\",\"content\":[{\"type\":\"text\",\"text\":\"Revising the plan with a feature flag.\"}]}}"
      out '{"type":"result","subtype":"success","is_error":false,"usage":{}}' ;;
    *'"type":"user"'*)
      n=$((n+1))
      out "{\"type\":\"assistant\",\"message\":{\"id\":\"m$n\",\"content\":[{\"type\":\"tool_use\",\"id\":\"p$n\",\"name\":\"ExitPlanMode\",\"input\":$plan}]}}"
      out "{\"type\":\"control_request\",\"request_id\":\"r$n\",\"request\":{\"subtype\":\"can_use_tool\",\"tool_name\":\"ExitPlanMode\",\"tool_use_id\":\"p$n\",\"input\":$plan,\"requires_user_interaction\":true}}" ;;
  esac
done
`;

const card = '//div[.//span[normalize-space()="Claude has a plan"]][contains(@class, "jaunt-card-in")]';
const modeChip = 'button[title="Permission mode"]';

describe("plan approval", () => {
  let blocked = "";
  let sessionId = "";

  before(async () => {
    blocked = readFileSync(FAKE, "utf8");
    writeFileSync(FAKE, FAKE_CLAUDE);
    chmodSync(FAKE, 0o755);
    const project = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!;
    sessionId = rpc<{ id: string }>(w, "session.create", { project_id: project.id, name: SESSION, agent: "claude", mode: "plan", prompt: "Plan a dark theme" }).id;
    // A window in the background never runs the card's entry animation, so
    // the card would stay at opacity 0 and never count as displayed.
    await browser.execute(() => {
      const style = document.createElement("style");
      style.textContent = ".jaunt-card-in { animation: none !important; }";
      document.head.append(style);
    });
    await $(sel.sessionRow(SESSION)).click();
    // The repo's setup script opens first; the conversation is the next tab.
    // Tabs switch on mousedown, which the embedded driver's click does not
    // send. The tab may not exist yet, so retry until the card shows.
    await browser.waitUntil(
      async () => {
        await browser.execute(() => {
          const tab = document.evaluate('//span[normalize-space()="claude"]', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
          tab?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        });
        return $(card).isDisplayed();
      },
      { timeout: 30_000, timeoutMsg: "the plan card never showed" },
    );
  });

  after(async () => {
    try {
      rpc(w, "session.archive", { id: sessionId });
      await expect($(sel.sessionRow(SESSION))).not.toBeExisting();
    } finally {
      // Later specs must never get the plan-only fake.
      writeFileSync(FAKE, blocked);
    }
  });

  it("shows the plan formatted, with its file", async () => {
    await expect($(`${card}//h1[normalize-space()="Add a dark theme"]`)).toBeDisplayed();
    await expect($(`${card}//strong[normalize-space()="App"]`)).toBeDisplayed();
    await expect($(`${card}//code[normalize-space()="theme"]`)).toBeDisplayed();
    await expect($(`${card}//*[normalize-space()="${PLAN_FILE}"]`)).toBeDisplayed();
    await expect($(sel.text("Waiting for your approval"))).toBeDisplayed();
    await expect($(modeChip)).toHaveText("Plan");
  });

  it("sends feedback back with Keep planning", async () => {
    await $(sel.button("Keep planning")).click();
    await expect($(sel.button("Send feedback"))).toBeDisabled();
    await fill('//textarea[@aria-label="What should change in the plan?"]', "Use a feature flag instead");
    await $(sel.button("Send feedback")).click();
    await expect($(sel.text("Revising the plan with a feature flag."))).toBeDisplayed();
    await expect($(card)).not.toBeExisting();
    await expect($(modeChip)).toHaveText("Plan");
  });

  it("switches to Accept edits when approved that way", async () => {
    const chat = rpc<{ id: number; chat: boolean; session_id?: string }[]>(w, "terminal.list", {}).find((t) => t.chat && t.session_id === sessionId)!;
    rpc(w, "chat.send", { id: chat.id, text: "Plan it again" });
    await expect($(card)).toBeDisplayed();
    await $(sel.button("Approve, accept edits")).click();
    await expect($(sel.text("Implementing the plan."))).toBeDisplayed();
    await expect($(card)).not.toBeExisting();
    await expect($(modeChip)).toHaveText("Accept edits");
  });

  it("keeps the approved plan readable in the transcript", async () => {
    // The second turn's call is the approved one.
    await $(`(${sel.button("1 tool call")})[last()]`).click();
    await $('(//button[.//span[normalize-space()="ExitPlanMode"]])[last()]').click();
    await expect($('//h1[normalize-space()="Add a dark theme"]')).toBeDisplayed();
    // The tool's result stays readable beside the plan.
    await expect($(sel.text("User has approved your plan."))).toBeDisplayed();
  });
});
