// The chat input's + menu (X29), with a fake `claude` that answers
// `initialize` the way Claude Code 2.1.292 does: commands and subagents.

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { PROJECT, hover, rpc, sel, world } from "../fixtures";

const w = world();
const FAKE = join(w.root, "bin", "claude");
const SESSION = "Tidy the settings page";
const EDITOR = '//textarea[@placeholder="Ask for a change, @ to mention a file, / for commands"]';

/** printf, because /bin/sh's echo expands the \n in the JSON. */
const FAKE_CLAUDE = String.raw`#!/bin/sh
out() { printf '%s\n' "$1"; }
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) out '{"type":"control_response","response":{"subtype":"success","request_id":"init-1","response":{"commands":[{"name":"review","description":"Review changes","argumentHint":""},{"name":"compact","description":"Compact the conversation","argumentHint":""}],"agents":[{"name":"Plan","description":"Software architect agent for designing implementation plans.","model":"inherit"}]}}}' ;;
  esac
done
`;

describe("+ menu", () => {
  let blocked = "";
  let sessionId = "";

  before(async () => {
    blocked = readFileSync(FAKE, "utf8");
    writeFileSync(FAKE, FAKE_CLAUDE);
    chmodSync(FAKE, 0o755);
    const project = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!;
    sessionId = rpc<{ id: string }>(w, "session.create", { project_id: project.id, name: SESSION, agent: "claude" }).id;
    await $(sel.sessionRow(SESSION)).click();
    // Tabs switch on mousedown, which the embedded driver's click does not send.
    await browser.execute(() => {
      const tab = document.evaluate('//span[normalize-space()="claude"]', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      tab?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await expect($(EDITOR)).toBeDisplayed({ wait: 30_000 });
  });

  after(async () => {
    rpc(w, "session.archive", { id: sessionId });
    await expect($(sel.sessionRow(SESSION))).not.toBeExisting();
    writeFileSync(FAKE, blocked);
  });

  it("inserts a slash command from the agent's list", async () => {
    await $('button[title="Add files, commands and more"]').click();
    await expect($(sel.button("Attach files or images"))).toBeDisplayed();
    await hover($(sel.button("Slash commands")));
    await $(sel.button("/review")).click();
    // getValue, because toHaveValue trims the trailing space.
    expect(await $(EDITOR).getValue()).toBe("/review ");
    await expect($(sel.button("Slash commands"))).not.toBeExisting();
  });

  it("mentions a subagent with its description in the list", async () => {
    await $('button[title="Add files, commands and more"]').click();
    await hover($(sel.button("Subagents")));
    await expect($(sel.text("Software architect agent for designing implementation plans."))).toBeDisplayed();
    await $('//button[span[normalize-space()="Plan"]][span[starts-with(normalize-space(), "Software architect")]]').click();
    expect(await $(EDITOR).getValue()).toBe("/review @agent-Plan ");
  });
});
