// A new tab is an agent, and its empty chat offers the session's other
// chats and plans as context (X38). A fake `claude` answers every message
// with a plan; ⇧⌘T still opens a shell.

import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { PROJECT, rpc, sel, world } from "../fixtures";

const w = world();
const FAKE = join(w.root, "bin", "claude");
const SESSION = "Theme work";
const PROMPT = "Plan a dark theme";
/** FNV-1a of the plan file's path, which names its context file. */
const PLAN_FILE = "plan-add-a-dark-theme-8b63e294.md";

/** Each message gets a plan through ExitPlanMode, already answered. printf,
 *  because /bin/sh's echo expands the \n in the JSON. */
const FAKE_CLAUDE = String.raw`#!/bin/sh
out() { printf '%s\n' "$1"; }
plan='{"plan":"# Add a dark theme\n\n1. Add a theme setting\n","planFilePath":"/tmp/plans/dark-theme.md"}'
n=0
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) out '{"type":"system","subtype":"init","session_id":"e2e-new-tab","model":"e2e-model","permissionMode":"default","slash_commands":[]}' ;;
    *'"type":"user"'*)
      n=$((n+1))
      out "{\"type\":\"assistant\",\"message\":{\"id\":\"m$n\",\"content\":[{\"type\":\"tool_use\",\"id\":\"p$n\",\"name\":\"ExitPlanMode\",\"input\":$plan}]}}"
      out "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"p$n\",\"content\":\"ok\"}]}}"
      out "{\"type\":\"assistant\",\"message\":{\"id\":\"a$n\",\"content\":[{\"type\":\"text\",\"text\":\"Planned.\"}]}}"
      out '{"type":"result","subtype":"success","is_error":false,"usage":{}}' ;;
  esac
done
`;

interface Term {
  id: number;
  kind: string;
  chat?: boolean;
  session_id?: string;
}

/** Sends a key to whatever has focus, as the app's shortcuts see it. */
async function press(key: string, code: string, mods: { metaKey?: boolean; shiftKey?: boolean } = {}) {
  await browser.execute(
    (k: string, c: string, m: object) =>
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, code: c, bubbles: true, cancelable: true, ...m })),
    key,
    code,
    mods,
  );
}

/** True once some chat input holds `text`. */
const inputHas = (text: string) =>
  browser.execute((t: string) => [...document.querySelectorAll("textarea")].some((el) => el.value.includes(t)), text);

describe("new agent tab", () => {
  let blocked = "";
  let sessionId = "";
  let path = "";
  let firstChat = 0;
  const terms = () => rpc<Term[]>(w, "terminal.list", {}).filter((t) => t.session_id === sessionId);

  before(async () => {
    blocked = readFileSync(FAKE, "utf8");
    writeFileSync(FAKE, FAKE_CLAUDE);
    chmodSync(FAKE, 0o755);
    const project = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!;
    const session = rpc<{ id: string; path: string }>(w, "session.create", { project_id: project.id, name: SESSION, agent: "claude", prompt: PROMPT });
    sessionId = session.id;
    path = session.path;
    // The first chat has answered with its plan before the new tab opens.
    await browser.waitUntil(
      () => {
        const chat = terms().find((t) => t.chat);
        const st = chat && rpc<{ items: { tool?: { name: string } }[] }>(w, "chat.state", { id: chat.id });
        firstChat = chat?.id ?? 0;
        return !!st?.items.some((i) => i.tool?.name === "ExitPlanMode");
      },
      { timeout: 30_000, timeoutMsg: "the first chat never planned" },
    );
    await $(sel.sessionRow(SESSION)).click();
  });

  after(() => {
    try {
      rpc(w, "session.archive", { id: sessionId });
    } finally {
      // Later specs must never get this fake.
      writeFileSync(FAKE, blocked);
    }
  });

  it("opens the session's agent with ⌘T, offering its other chat and plan", async () => {
    const chats = terms().filter((t) => t.chat).length;
    await press("t", "KeyT", { metaKey: true });
    await browser.waitUntil(() => terms().filter((t) => t.chat).length === chats + 1, { timeoutMsg: "⌘T opened no agent" });
    await expect($(sel.text(`New chat in ${path}.`))).toBeDisplayed();
    await expect($(sel.text("Add chat transcripts:"))).toBeDisplayed();
    await expect($(`//button[@title="${PROMPT}"]`)).toBeDisplayed();
    await expect($(sel.text("Add plans:"))).toBeDisplayed();
    await expect($('//button[@title="Add a dark theme"]')).toBeDisplayed();
  });

  it("writes the plan to a git-ignored file and mentions it", async () => {
    await $('//button[@title="Add a dark theme"]').click();
    await browser.waitUntil(() => inputHas(`@.moonlet/context/${PLAN_FILE}`), { timeoutMsg: "the plan was never mentioned" });
    expect(readFileSync(join(path, ".moonlet/context", PLAN_FILE), "utf8")).toBe("# Add a dark theme\n\n1. Add a theme setting\n");
    expect(readFileSync(join(path, ".moonlet/context/.gitignore"), "utf8")).toBe("*\n");
  });

  it("writes the other chat's transcript and mentions it", async () => {
    await $(`//button[@title="${PROMPT}"]`).click();
    const file = `chat-plan-a-dark-theme-${firstChat}.md`;
    await browser.waitUntil(() => inputHas(`@.moonlet/context/${file}`), { timeoutMsg: "the chat was never mentioned" });
    const text = readFileSync(join(path, ".moonlet/context", file), "utf8");
    expect(text.startsWith(`# Chat transcript: ${PROMPT}\n\n> ${PROMPT}\n\n`)).toBe(true);
    expect(text).toContain("Planned.");
  });

  it("refuses to write through a symlinked context folder, with a toast", async () => {
    const outside = join(w.root, "outside");
    mkdirSync(outside);
    rmSync(join(path, ".moonlet/context"), { recursive: true });
    symlinkSync(outside, join(path, ".moonlet/context"));
    await $('//button[@title="Add a dark theme"]').click();
    await expect($('//*[contains(text(), "is outside")]')).toBeDisplayed();
    expect(readdirSync(outside)).toEqual([]);
  });

  it("opens a shell with ⇧⌘T", async () => {
    const shells = terms().filter((t) => t.kind === "shell").length;
    await press("T", "KeyT", { metaKey: true, shiftKey: true });
    await browser.waitUntil(() => terms().filter((t) => t.kind === "shell").length === shells + 1, { timeoutMsg: "⇧⌘T opened no shell" });
  });

  it("opens an agent with the + button, and a shell from its menu's Terminal ⇧⌘T", async () => {
    const chats = terms().filter((t) => t.chat).length;
    await $('button[title="New agent (⌘T)"]').click();
    await browser.waitUntil(() => terms().filter((t) => t.chat).length === chats + 1, { timeoutMsg: "+ opened no agent" });
    const shells = terms().filter((t) => t.kind === "shell").length;
    await $('button[title="New agent or split"]').click();
    await $('//button[starts-with(normalize-space(), "Terminal")][contains(., "⇧⌘T")]').click();
    await browser.waitUntil(() => terms().filter((t) => t.kind === "shell").length === shells + 1, { timeoutMsg: "Terminal opened no shell" });
  });
});
