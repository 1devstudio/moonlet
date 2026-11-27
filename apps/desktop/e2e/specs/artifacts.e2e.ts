// Artifacts (X114): a plan a session's agent proposes is listed under
// Artifacts in the sidebar, named after its session, found by its text,
// and opened in the main area with its versions.

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { PROJECT, fill, rpc, sel, world } from "../fixtures";

const w = world();
const FAKE = join(w.root, "bin", "claude");
const SESSION = "Search for the product list";
const READER = "Search results page";

/** Proposes one plan for every message, as Claude's ExitPlanMode call with
 *  its plan file, and ends the turn. printf, because /bin/sh's echo expands
 *  the \n in the JSON. */
const FAKE_CLAUDE = String.raw`#!/bin/sh
out() { printf '%s\n' "$1"; }
plan='{"plan":"# Search the products\n\n1. Add a search box with a 150 ms debounce\n2. Show a result count\n","planFilePath":"/tmp/plans/search-products.md"}'
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) out '{"type":"system","subtype":"init","session_id":"e2e-artifacts","model":"e2e-model","slash_commands":[]}' ;;
    *'"type":"user"'*)
      out "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"content\":[{\"type\":\"tool_use\",\"id\":\"p1\",\"name\":\"ExitPlanMode\",\"input\":$plan}]}}"
      out '{"type":"result","subtype":"success","is_error":false,"usage":{}}' ;;
  esac
done
`;

const artifactsRow = '//nav//button[normalize-space()="Artifacts"]';
const planRow = `//button[.//span[normalize-space()=${JSON.stringify(SESSION)}]]`;

describe("artifacts", () => {
  let blocked = "";
  let sessionId = "";
  let readerId = "";
  let workspace = "";

  before(async () => {
    blocked = readFileSync(FAKE, "utf8");
    writeFileSync(FAKE, FAKE_CLAUDE);
    chmodSync(FAKE, 0o755);
    const project = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!;
    workspace = rpc<{ id: string; name: string }[]>(w, "workspace.list", {})[0]?.id;
    sessionId = rpc<{ id: string }>(w, "session.create", { project_id: project.id, name: SESSION, agent: "claude", workspace_id: workspace }).id;
    readerId = rpc<{ id: string }>(w, "session.create", { project_id: project.id, name: READER, agent: "claude", workspace_id: workspace }).id;
    await browser.waitUntil(() => rpc<{ chat: boolean; session_id?: string }[]>(w, "terminal.list", {}).some((t) => t.chat && t.session_id === sessionId), {
      timeoutMsg: "the session's chat never started",
    });
    const chat = rpc<{ id: number; chat: boolean; session_id?: string }[]>(w, "terminal.list", {}).find((t) => t.chat && t.session_id === sessionId)!.id;
    rpc(w, "chat.send", { id: chat, text: "Plan a product search" });
    await browser.waitUntil(() => rpc<{ id: string }[]>(w, "artifact.list", { workspace }).some((a) => a.id === `plan:${sessionId}:search-products`), {
      timeout: 20_000,
      timeoutMsg: "the plan never became an artifact",
    });
  });

  after(async () => {
    try {
      if (await $(artifactsRow).isExisting()) {
        const on = await $(artifactsRow).getAttribute("class");
        if (on?.includes("bg-bg")) await $(artifactsRow).click();
      }
      rpc(w, "session.archive", { id: sessionId });
      rpc(w, "session.archive", { id: readerId });
    } finally {
      // Later specs must never get the planning fake.
      writeFileSync(FAKE, blocked);
    }
  });

  it("lists the plan under Artifacts, named after its session", async () => {
    await $(artifactsRow).click();
    await expect($(planRow)).toBeDisplayed();
    await expect($(`${planRow}//span[normalize-space()=${JSON.stringify(PROJECT)}]`)).toBeDisplayed();
  });

  it("finds the plan by its text and marks where", async () => {
    await fill('//input[@aria-label="Search artifacts"]', "debounce");
    await expect($(`${planRow}//mark[normalize-space()="debounce"]`)).toBeDisplayed();
    await expect($(sel.text('1 result for "debounce"'))).toBeDisplayed();
  });

  it("opens the plan with its text and versions", async () => {
    await $(planRow).click();
    await expect($('//h1[normalize-space()="Search the products"]')).toBeDisplayed();
    await expect($(sel.text("Versions"))).toBeDisplayed();
    await expect($('//button[.//span[normalize-space()="v1"]]')).toBeDisplayed();
  });

  it("attaches the plan to another session, whose next message refers to it live", async () => {
    await $(sel.button("Attach to session…")).click();
    await $(`//button[normalize-space()=${JSON.stringify(READER)}]`).click();
    // The session shows, the plan as a live chip in its input. The repo's
    // setup script opens first; the conversation is the next tab, which
    // switches on mousedown.
    const chip = `//section[@aria-label="Chat input"]//span[@title=${JSON.stringify(`${SESSION}: a live reference, read only`)}]`;
    await browser.waitUntil(
      async () => {
        await browser.execute(() => {
          const tab = document.evaluate('//span[normalize-space()="claude"]', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
          tab?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        });
        return $(chip).isDisplayed();
      },
      { timeout: 20_000, timeoutMsg: "the plan's chip never showed in the session's input" },
    );
    await expect($(`${chip}//span[normalize-space()="live"]`)).toBeDisplayed();
    const input = '//section[@aria-label="Chat input"]//textarea';
    await fill(input, "Build the results page from the plan");
    await browser.execute((xp: string) => {
      const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement;
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }, input);
    await expect($(chip)).not.toBeExisting();
    // The message shows the plan as a chip, without ×, above what was typed; the line itself is the agent's.
    await expect($(sel.text("Build the results page from the plan"))).toBeDisplayed();
    await expect($(`//span[contains(@title, "plan-search-products")][.//span[normalize-space()=${JSON.stringify(SESSION)}]]`)).toBeDisplayed();
    await expect($('//*[contains(text(), "It always holds the latest version")]')).not.toBeExisting();
    const id = `plan:${sessionId}:search-products`;
    await browser.waitUntil(() => rpc<{ id: string; used_by: string[] }[]>(w, "artifact.list", { workspace }).find((a) => a.id === id)?.used_by.includes(readerId) ?? false, {
      timeout: 15_000,
      timeoutMsg: "the plan never listed the session using it",
    });
    // The message its agent got starts with the plan's live line.
    const chat = rpc<{ id: number; chat: boolean; session_id?: string }[]>(w, "terminal.list", {}).find((t) => t.chat && t.session_id === readerId)!.id;
    const sent = () => rpc<{ items: { kind: string; text: string }[] }>(w, "chat.state", { id: chat }).items.filter((i) => i.kind === "user").at(-1)?.text ?? "";
    await browser.waitUntil(() => sent().endsWith("Build the results page from the plan"), { timeout: 15_000, timeoutMsg: "the message never reached the session's agent" });
    expect(sent()).toMatch(new RegExp(`^Artifact "${SESSION}" \\(plan, live, read only\\): /.+/artifacts/refs/${readerId}/plan-search-products\\. It always holds the latest version; it changes only in its home\\.\\n\\nBuild the results page from the plan$`));
  });

  it("@ lists the plan under Plans and the session's files under Files; Tab narrows, Enter picks", async () => {
    const input = '//section[@aria-label="Chat input"]//textarea';
    const typed = (text: string) =>
      browser.execute(
        (xp: string, t: string) => {
          const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLTextAreaElement;
          return el.value === t;
        },
        input,
        text,
      );
    const key = (k: string, shift = false) =>
      browser.execute(
        (xp: string, name: string, sh: boolean) => {
          const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement;
          el.dispatchEvent(new KeyboardEvent("keydown", { key: name, shiftKey: sh, bubbles: true }));
        },
        input,
        k,
        shift,
      );
    const picker = '//section[@aria-label="Chat input"]//div[.//span[normalize-space()="↑↓ move"]]';
    await fill(input, "Match @product");
    await expect($(`${picker}//div[normalize-space()="Plans"]`)).toBeDisplayed();
    await expect($(`${picker}//button[.//span[normalize-space()=${JSON.stringify(SESSION)}]]`)).toBeDisplayed();
    // Tab narrows to Plans; Enter picks the plan: a chip, the @word gone.
    await key("Tab");
    await expect($(`${picker}//button[starts-with(normalize-space(), "Plans")]`)).toHaveAttribute("class", expect.stringContaining("bg-hover"));
    await key("Enter");
    const chip = `//section[@aria-label="Chat input"]//span[@title=${JSON.stringify(`${SESSION}: a live reference, read only`)}]`;
    await expect($(chip)).toBeDisplayed();
    await browser.waitUntil(() => typed("Match "), { timeoutMsg: "the @word stayed in the input" });
    // Files: the session's own, inserted as @path.
    await fill(input, "See @READ");
    await key("Tab", true);
    await expect($(`${picker}//div[normalize-space()="Files"]`)).toBeDisplayed();
    await key("Enter");
    await browser.waitUntil(() => typed("See @README.md "), { timeoutMsg: "the file never went in as @path" });
    await fill(input, "");
    await $(`${chip}//button[@title="Remove"]`).click();
    await expect($(chip)).not.toBeExisting();
  });
});
