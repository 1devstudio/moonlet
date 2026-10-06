// Plan approval (X20) and the Plan panel (X24), with a fake `claude` in Plan
// mode that proposes a plan for every message and answers the ways a plan
// can be resolved: approved into Auto or Accept edits, or sent back with
// feedback.

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, $$, browser, expect } from "@wdio/globals";
import { PROJECT, choose, fill, rpc, sel, world } from "../fixtures";

const w = world();
const FAKE = join(w.root, "bin", "claude");
const SESSION = "Add a dark theme";
const PLAN_FILE = "/tmp/plans/dark-theme.md";

/** Each message gets an ExitPlanMode ask. An approval with the setMode
 *  update reports the mode it asked for and starts implementing; the feedback is
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
      case "$line" in
        *'"mode":"auto"'*) out '{"type":"system","subtype":"status","status":null,"permissionMode":"auto"}' ;;
        *) out '{"type":"system","subtype":"status","status":null,"permissionMode":"acceptEdits"}' ;;
      esac
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

/** The plan's card in the conversation, by its status label. */
const card = (label: string) => `//div[contains(@class, "jaunt-card-in")][.//div[normalize-space()=${JSON.stringify(label)}]]`;
const waiting = card("Claude has a plan · waiting for approval");
const planTab = '//button[@role="tab"][normalize-space()="Plan"]';
const modeChip = 'button[title="Permission mode"]';
const composer = '//textarea[@placeholder="What should change in the plan?"]';

/** Settings live in the webview's storage, which outlives the scratch world. */
async function setPlanApproveMode(mode: "auto" | "acceptEdits") {
  await $('button[title="Settings (⌘,)"]').click();
  await choose('//div[@role="dialog"][@aria-label="Settings"]//label[span[normalize-space()="When a plan is approved, switch to"]]//select', mode);
  await $('[role="dialog"][aria-label="Settings"] button[title="Close"]').click();
}

describe("plan approval", () => {
  let blocked = "";
  let sessionId = "";
  const chatId = () => rpc<{ id: number; chat: boolean; session_id?: string }[]>(w, "terminal.list", {}).find((t) => t.chat && t.session_id === sessionId)!.id;

  before(async () => {
    await setPlanApproveMode("auto");
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
    // The plan must open the Plan tab by itself.
    await browser.execute(() => {
      const files = document.evaluate('//button[@role="tab"][normalize-space()="Files"]', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement | null;
      files?.click();
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
        return $(waiting).isDisplayed();
      },
      { timeout: 30_000, timeoutMsg: "the plan card never showed" },
    );
  });

  after(async () => {
    try {
      await setPlanApproveMode("auto");
      rpc(w, "session.archive", { id: sessionId });
      await expect($(sel.sessionRow(SESSION))).not.toBeExisting();
    } finally {
      // Later specs must never get the plan-only fake.
      writeFileSync(FAKE, blocked);
    }
  });

  it("opens the Plan tab with the plan formatted, and its file", async () => {
    await expect($(planTab)).toHaveAttribute("aria-selected", "true");
    // The panel below is the Plan tab's tabpanel.
    await expect($(planTab)).toHaveAttribute("aria-controls", "right-tabpanel");
    await expect($('[role="tabpanel"]#right-tabpanel')).toHaveAttribute("aria-labelledby", "right-tab-plan");
    await expect($('//h1[normalize-space()="Add a dark theme"]')).toBeDisplayed();
    await expect($('//strong[normalize-space()="App"]')).toBeDisplayed();
    await expect($('//code[normalize-space()="theme"]')).toBeDisplayed();
    await expect($(`//*[normalize-space()="${PLAN_FILE}"]`)).toBeDisplayed();
    // The card names the plan and holds the approval.
    await expect($(`${waiting}//div[normalize-space()="Add a dark theme"]`)).toBeDisplayed();
    await expect($(`${waiting}${sel.button("Approve, auto mode")}`)).toBeDisplayed();
    await expect($(sel.text("Waiting for your approval"))).toBeDisplayed();
    await expect($(modeChip)).toHaveText("Plan");
  });

  it("offers Open plan while another tab shows, with a dot on Plan", async () => {
    await $('//button[@role="tab"][normalize-space()="Files"]').click();
    await expect($('[aria-label="plan waiting"]')).toBeDisplayed();
    await $(`${waiting}${sel.button("Open plan")}`).click();
    await expect($(planTab)).toHaveAttribute("aria-selected", "true");
    await expect($(sel.button("Open plan"))).not.toBeExisting();
  });

  it("sends feedback from the composer with Keep planning", async () => {
    await $(sel.button("Keep planning")).click();
    await expect($(composer)).toBeFocused();
    await fill(composer, "Use a feature flag instead");
    await browser.execute((xp: string) => {
      const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement;
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    }, composer);
    await expect($(sel.text("Revising the plan with a feature flag."))).toBeDisplayed();
    await expect($(card("Plan · revising with your feedback"))).toBeDisplayed();
    await expect($(composer)).not.toBeExisting();
    await expect($(modeChip)).toHaveText("Plan");
  });

  it("switches to Auto when approved, the default", async () => {
    rpc(w, "chat.send", { id: chatId(), text: "Plan it again" });
    await expect($(waiting)).toBeDisplayed();
    await $(sel.button("Approve, auto mode")).click();
    await expect($(sel.text("Implementing the plan."))).toBeDisplayed();
    await expect($(card("Plan approved · auto mode"))).toBeDisplayed();
    await expect($(sel.text("Approved · auto mode"))).toBeDisplayed();
    await expect($(modeChip)).toHaveText("Auto");
  });

  it("switches to Accept edits when Settings say so", async () => {
    await setPlanApproveMode("acceptEdits");
    rpc(w, "chat.send", { id: chatId(), text: "Plan once more" });
    await expect($(waiting)).toBeDisplayed();
    await $(sel.button("Approve, accept edits")).click();
    await expect($(card("Plan approved · accepting edits"))).toBeDisplayed();
    await expect($(modeChip)).toHaveText("Accept edits");
  });

  it("keeps the approved plan readable in the transcript", async () => {
    // The last turn's call is the approved one.
    await $(`(${sel.button("1 tool call")})[last()]`).click();
    await $('(//button[.//span[normalize-space()="ExitPlanMode"]])[last()]').click();
    // One heading in the Plan tab, one in the opened row.
    await expect($$('//h1[normalize-space()="Add a dark theme"]')).toBeElementsArrayOfSize(2);
    // The tool's result stays readable beside the plan.
    await expect($(`(${sel.text("User has approved your plan.")})[last()]`)).toBeDisplayed();
  });
});
