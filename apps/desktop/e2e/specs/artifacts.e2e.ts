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

  before(async () => {
    blocked = readFileSync(FAKE, "utf8");
    writeFileSync(FAKE, FAKE_CLAUDE);
    chmodSync(FAKE, 0o755);
    const project = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!;
    const workspace = rpc<{ id: string; name: string }[]>(w, "workspace.list", {})[0]?.id;
    sessionId = rpc<{ id: string }>(w, "session.create", { project_id: project.id, name: SESSION, agent: "claude", workspace_id: workspace }).id;
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
});
