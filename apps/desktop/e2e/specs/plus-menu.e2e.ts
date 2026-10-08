// The chat input's + menu (X29), with a fake `claude` that answers
// `initialize` and `mcp_status` the way Claude Code 2.1.292 does.

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
    *'"subtype":"mcp_status"'*)
      id=$(printf '%s' "$line" | sed 's/.*"request_id":"\([^"]*\)".*/\1/')
      out '{"type":"control_response","response":{"subtype":"success","request_id":"'"$id"'","response":{"mcpServers":[{"name":"claude.ai Slack","status":"connected","config":{"type":"claudeai-proxy","url":"https://mcp.slack.com/mcp"},"scope":"claudeai","tools":[{"name":"slack_send_message"},{"name":"slack_read_channel"}]},{"name":"claude.ai Linear","status":"needs-auth","config":{"type":"claudeai-proxy","url":"https://mcp.linear.app/mcp"},"scope":"claudeai","tools":[]},{"name":"broken","status":"failed","error":"ENOENT: no such file or directory, posix_spawn '"'stdio'"'","config":{"type":"stdio","command":"/nonexistent/mcp-server","args":["--stdio"]},"scope":"dynamic","tools":[]}]}}}' ;;
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

  it("lists the agent's MCP servers with the one that needs sign-in first", async () => {
    await $('button[title="Add files, commands and more"]').click();
    await hover($(sel.button("MCP servers")));
    await expect($(sel.text("MCP servers · 1/3"))).toBeDisplayed();
    await expect($('[title="1 server needs sign-in"]')).toBeDisplayed();
    const card = (name: string) => `//div[@aria-label="MCP server ${name}"]`;
    await expect($(`${card("claude.ai Linear")}//*[normalize-space()="Authentication required"]`)).toBeDisplayed();
    await expect($(`${card("claude.ai Linear")}//*[normalize-space()="https://mcp.linear.app/mcp"]`)).toBeDisplayed();

    await hover($('//button[span[normalize-space()="claude.ai Slack"]]'));
    await expect($(`${card("claude.ai Slack")}//*[normalize-space()="2 tools"]`)).toBeDisplayed();
    await expect($(`${card("claude.ai Slack")}//*[normalize-space()="slack_send_message"]`)).toBeDisplayed();

    await hover($('//button[span[normalize-space()="broken"]]'));
    await expect($(`${card("broken")}//*[normalize-space()="ENOENT: no such file or directory, posix_spawn 'stdio'"]`)).toBeDisplayed();
    await expect($(`${card("broken")}//button[normalize-space()="Retry"]`)).toBeDisplayed();
    await browser.keys("Escape");
    // The + keeps a dot while a server waits for sign-in.
    await expect($('[aria-label="MCP servers need sign-in"]')).toBeDisplayed();
  });

  it("mentions a subagent with its description in the list", async () => {
    await $('button[title="Add files, commands and more"]').click();
    await hover($(sel.button("Subagents")));
    await expect($(sel.text("Software architect agent for designing implementation plans."))).toBeDisplayed();
    await $('//button[span[normalize-space()="Plan"]][span[starts-with(normalize-space(), "Software architect")]]').click();
    expect(await $(EDITOR).getValue()).toBe("/review @agent-Plan ");
  });
});
