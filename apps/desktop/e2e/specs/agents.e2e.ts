// The Agents tab (X42), with a fake `claude` that launches two background
// subagents the way claude 2.1.296 reports them: one asks to write a file,
// the other keeps running until it is stopped.

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { PROJECT, rpc, sel, world } from "../fixtures";

const w = world();
const FAKE = join(w.root, "bin", "claude");
const SESSION = "Split the work";

/** The first message launches both agents and ends the main turn while they
 *  run. Allowing the write finishes the first; `stop_task` stops the second. */
const FAKE_CLAUDE = String.raw`#!/bin/sh
out() { printf '%s\n' "$1"; }
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) out '{"type":"system","subtype":"init","session_id":"e2e-agents","model":"e2e-model","slash_commands":[]}' ;;
    *'"subtype":"stop_task"'*)
      out '{"type":"system","subtype":"task_updated","task_id":"a2","patch":{"status":"killed","end_time":'"$(date +%s)000"'}}'
      out '{"type":"system","subtype":"task_notification","task_id":"a2","tool_use_id":"toolu_a2","status":"stopped","summary":"List files"}' ;;
    *'"request_id":"q1"'*)
      out '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"w1","type":"tool_result","content":"File created successfully at: /repo/hello.txt"}]},"parent_tool_use_id":"toolu_a1","agent_id":"a1"}'
      out '{"type":"system","subtype":"task_updated","task_id":"a1","patch":{"status":"completed","end_time":'"$(date +%s)000"'}}'
      out '{"type":"system","subtype":"task_notification","task_id":"a1","tool_use_id":"toolu_a1","status":"completed","summary":"Created hello.txt with hi.","usage":{"total_tokens":10682,"tool_uses":1,"duration_ms":3175}}' ;;
    *'"type":"user"'*)
      out '{"type":"assistant","message":{"id":"m1","model":"claude-haiku-5-5","content":[{"type":"tool_use","id":"toolu_a1","name":"Agent","input":{"description":"Write hello file","prompt":"Create hello.txt containing hi.","subagent_type":"general-purpose"}},{"type":"tool_use","id":"toolu_a2","name":"Agent","input":{"description":"List files","prompt":"List the files.","subagent_type":"general-purpose"}}]}}'
      out '{"type":"system","subtype":"task_started","task_id":"a1","tool_use_id":"toolu_a1","description":"Write hello file","subagent_type":"general-purpose","is_backgrounded":true,"prompt":"Create hello.txt containing hi."}'
      out '{"type":"system","subtype":"task_started","task_id":"a2","tool_use_id":"toolu_a2","description":"List files","subagent_type":"general-purpose","is_backgrounded":true,"prompt":"List the files."}'
      out '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_a1","type":"tool_result","content":"Async agent launched successfully."},{"tool_use_id":"toolu_a2","type":"tool_result","content":"Async agent launched successfully."}]}}'
      out '{"type":"assistant","message":{"id":"s1","model":"claude-haiku-5-5","content":[{"type":"tool_use","id":"w1","name":"Write","input":{"file_path":"/repo/hello.txt","content":"hi\n"}}]},"parent_tool_use_id":"toolu_a1","agent_id":"a1"}'
      out '{"type":"system","subtype":"task_progress","task_id":"a1","tool_use_id":"toolu_a1","description":"Writing hello.txt","usage":{"total_tokens":9721,"tool_uses":1,"duration_ms":1522},"last_tool_name":"Write"}'
      out '{"type":"assistant","message":{"id":"s2","model":"claude-haiku-5-5","content":[{"type":"tool_use","id":"g1","name":"Glob","input":{"pattern":"*"}}]},"parent_tool_use_id":"toolu_a2","agent_id":"a2"}'
      out '{"type":"system","subtype":"task_progress","task_id":"a2","tool_use_id":"toolu_a2","description":"Finding *","usage":{"total_tokens":9709,"tool_uses":1,"duration_ms":1488},"last_tool_name":"Glob"}'
      out '{"type":"control_request","request_id":"q1","request":{"subtype":"can_use_tool","tool_name":"Write","display_name":"Write","input":{"file_path":"/repo/hello.txt","content":"hi\n"},"description":"hello.txt","permission_suggestions":[],"tool_use_id":"w1","agent_id":"a1"}}'
      out '{"type":"assistant","message":{"id":"m2","model":"claude-haiku-5-5","content":[{"type":"text","text":"Both agents are running in the background."}]}}'
      out '{"type":"result","subtype":"success","is_error":false,"usage":{}}' ;;
  esac
done
`;

const tab = (label: string) => `//button[@role="tab"][normalize-space()="${label}"]`;
/** A row of the Agents tab, by the agent's description. */
const row = (name: string) => `//div[@role="button"][@data-agent=${JSON.stringify(name)}]`;
const strip = '//div[@aria-label="Agents"]';
const chip = (t: string) => `${sel.sessionRow(SESSION)}//span[normalize-space()=${JSON.stringify(t)}]`;
const text = (t: string) => `//*[normalize-space()=${JSON.stringify(t)}]`;

/** Tabs and rows react to a JS click; the embedded driver's click is not always delivered. */
const jsClick = (xpath: string) =>
  browser.execute((x: string) => {
    const el = document.evaluate(x, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement | null;
    el?.click();
    return !!el;
  }, xpath);

describe("agents tab", () => {
  let blocked = "";
  let sessionId = "";

  before(async () => {
    blocked = readFileSync(FAKE, "utf8");
    writeFileSync(FAKE, FAKE_CLAUDE);
    chmodSync(FAKE, 0o755);
    const project = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!;
    sessionId = rpc<{ id: string }>(w, "session.create", { project_id: project.id, name: SESSION, agent: "claude", prompt: "Split the work across two agents" }).id;
    // A window in the background never runs the permission card's entry animation.
    await browser.execute(() => {
      const style = document.createElement("style");
      style.textContent = ".moonlet-card-in { animation: none !important; }";
      document.head.append(style);
    });
    await $(sel.sessionRow(SESSION)).click();
    // The repo's setup script opens first; the conversation is the next tab,
    // which switches on mousedown. Retry until the strip shows.
    await browser.waitUntil(
      async () => {
        await browser.execute(() => {
          const tab = document.evaluate('//span[normalize-space()="claude"]', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
          tab?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        });
        return $(strip).isDisplayed();
      },
      { timeout: 30_000, timeoutMsg: "the agents strip never showed" },
    );
  });

  after(() => {
    try {
      rpc(w, "session.archive", { id: sessionId });
    } finally {
      // Later specs must never get this fake.
      writeFileSync(FAKE, blocked);
    }
  });

  it("lists the agents, and the one that asks shows a dot and its ask", async () => {
    await browser.waitUntil(async () => (await jsClick(tab("Files"))) && $(`${tab("Agents")}//span[@aria-label="agent waiting"]`).isExisting(), {
      timeout: 30_000,
      timeoutMsg: "the Agents tab never showed a waiting agent",
    });
    await jsClick(tab("Agents"));
    await expect($(row("Write hello file"))).toBeDisplayed();
    await expect($(row("Write hello file") + text("Wants to edit /repo/hello.txt"))).toBeExisting();
    await expect($(row("List files") + text("Finding *"))).toBeExisting();
    await expect($('//span[starts-with(normalize-space(), "2 agents ·")]')).toBeDisplayed();
    await expect($(`${strip}//span[normalize-space()="2 agents"]`)).toBeDisplayed();
    await expect($(`${strip}//span[normalize-space()="· 1 needs you"]`)).toBeDisplayed();
    await expect($(chip("needs input"))).toBeDisplayed();
    // The conversation shows the launch and names the agent that asks.
    await expect($('//span[normalize-space()="Launched 2 agents"]')).toBeDisplayed();
    await expect($('//div[contains(@class, "moonlet-card-in")][.//span[normalize-space()="Write hello file"]][.//span[normalize-space()="Allow Write?"]]')).toBeDisplayed();
  });

  it("shows the asking agent's model, tokens, edits and permission card in its detail", async () => {
    await jsClick(row("Write hello file"));
    const panel = '//*[@id="right-tabpanel"]';
    await expect($(`${panel}//div[contains(normalize-space(), "needs you · Haiku 5.5 ·") and contains(normalize-space(), "· 9.7k tokens")]`)).toBeDisplayed();
    await expect($(`${panel}//span[normalize-space()="+1"]/following-sibling::span[normalize-space()="−0"]`)).toBeDisplayed();
    await expect($(`${panel}//span[normalize-space()="Allow Write?"]`)).toBeDisplayed();
    // The tab itself goes back to the list.
    await jsClick(tab("Agents"));
    await expect($(row("List files"))).toBeDisplayed();
  });

  it("allows the ask from the row, and the agent finishes", async () => {
    await jsClick(`${row("Write hello file")}//button[normalize-space()="Allow"]`);
    await browser.waitUntil(async () => !(await $(`${row("Write hello file")}//button[normalize-space()="Allow"]`).isExisting()), {
      timeout: 10_000,
      timeoutMsg: "the row kept its Allow button",
    });
    await expect($(`${tab("Agents")}//span[@aria-label="agent waiting"]`)).not.toBeExisting();
    // Its report shows in the conversation.
    await expect($(text("Created hello.txt with hi."))).toBeDisplayed();
    // One agent still runs: the session row says so (X42).
    await expect($(chip("1 agent"))).toBeDisplayed();
  });

  it("opens an agent's detail with its brief and tool calls, and stops it", async () => {
    await jsClick(row("List files"));
    await expect($(text("Brief · List the files."))).toBeDisplayed();
    await expect($('//span[normalize-space()="Glob"]')).toBeDisplayed();
    await expect($('//*[@id="right-tabpanel"]//span[normalize-space()="running"]')).toBeDisplayed();
    await jsClick('//*[@id="right-tabpanel"]//button[normalize-space()="Stop"]');
    await expect($('//*[@id="right-tabpanel"]//span[normalize-space()="stopped"]')).toBeDisplayed();
    await jsClick('//*[@id="right-tabpanel"]//button[normalize-space()="Agents"]');
    await expect($(row("List files") + text("Stopped"))).toBeExisting();
    // One was stopped, so they did not all finish.
    await expect($(`${strip}//span[contains(normalize-space(), "2 agents · 1 done · 1 stopped")]`)).toBeDisplayed();
    await expect($(chip("1 agent"))).not.toBeExisting();
    await expect($('//span[starts-with(normalize-space(), "2 agents finished in")]')).toBeDisplayed();
  });
});
