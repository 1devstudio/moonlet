// Slash commands in the new-session composer (X111): the prompt's `/` menu
// and `+` › Slash commands list Claude's commands and the project's own,
// read from its folder, and Create sends the chosen command as the first
// message.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { fill, hover, rpc, sel, world } from "../fixtures";

const w = world();
const FAKE = join(w.root, "bin", "claude");
const SENT = join(w.root, "claude-user");
// A project of its own, with its own command: every spec of a run shares
// one daemon, and the composer may open on a project another spec added.
const NAME = "release-app";
const REPO = join(w.root, NAME);
const PROMPT = '//textarea[@placeholder="What do you want to work on?"]';
const HEADER = '//div[@role="dialog"][@aria-label="New session"]//div[@role="group"][@aria-label="Project and task"]';

/** Answers `initialize` with the user's `review`; keeps each user message. */
const FAKE_CLAUDE = String.raw`#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*)
      id=$(printf '%s' "$line" | sed 's/.*"request_id":"\([^"]*\)".*/\1/')
      printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"commands":[{"name":"review","description":"Review changes","argumentHint":""}],"models":[]}}}\n' "$id" ;;
    *'"type":"user"'*) printf '%s\n' "$line" >> "${SENT}" ;;
  esac
done
`;

/** Opens the composer on this spec's project. */
async function openComposer() {
  await $('button[title="New session"]').click();
  const project = $(`(${HEADER}//button)[1]`);
  await project.waitForDisplayed({ timeout: 10_000 });
  if (!(await project.getText()).startsWith(NAME)) {
    await project.click();
    await $(`//div[@data-menu-panel]//button[starts-with(normalize-space(), "${NAME}")]`).click();
  }
  await expect($(`${HEADER}//button[starts-with(normalize-space(), "${NAME}")]`)).toBeDisplayed();
}

describe("slash commands in the new-session composer (X111)", () => {
  let blocked = "";
  let projectId = "";

  before(async () => {
    blocked = readFileSync(FAKE, "utf8");
    writeFileSync(FAKE, FAKE_CLAUDE);
    chmodSync(FAKE, 0o755);
    mkdirSync(join(REPO, ".claude", "commands"), { recursive: true });
    writeFileSync(join(REPO, ".claude", "commands", "release-notes.md"), "Write the release notes\n");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: REPO, env: w.env, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("-c", "user.email=e2e@moonlet.test", "-c", "user.name=e2e", "commit", "-qm", "init");
    projectId = rpc<{ id: string }>(w, "project.add", { path: REPO }).id;
  });

  after(async () => {
    for (const s of rpc<{ id: string; project_id: string }[]>(w, "session.list", {})) if (s.project_id === projectId) rpc(w, "session.archive", { id: s.id });
    rpc(w, "project.remove", { id: projectId });
    writeFileSync(FAKE, blocked);
  });

  it("puts a command from + › Slash commands at the start of the prompt", async () => {
    await openComposer();
    await fill(PROMPT, "the cart changes");
    await $('button[title="Add files, commands and more"]').click();
    await hover($(sel.button("Slash commands")));
    await $(sel.button("/release-notes")).waitForDisplayed({ timeout: 30_000 });
    await $(sel.button("/release-notes")).click();
    // getValue, because toHaveValue trims.
    expect(await $(PROMPT).getValue()).toBe("/release-notes the cart changes");
    await browser.keys("Escape");
    await expect($(PROMPT)).not.toBeExisting();
  });

  it("lists the project's own command for a typed / and sends it as the first message", async () => {
    await openComposer();
    await fill(PROMPT, "/rel");
    await expect($(sel.button("/release-notes"))).toBeDisplayed({ wait: 30_000 });
    // Escape closes the menu, not the composer; an edit opens it again.
    await browser.keys("Escape");
    await expect($(sel.button("/release-notes"))).not.toBeExisting();
    await expect($(PROMPT)).toBeDisplayed();
    await fill(PROMPT, "/rele");
    await expect($(sel.button("/release-notes"))).toBeDisplayed();
    await browser.keys("Enter");
    expect(await $(PROMPT).getValue()).toBe("/release-notes ");
    // The menu closed: Enter now creates the session.
    await fill(PROMPT, "/release-notes for v2");
    await expect($(sel.button("/release-notes"))).not.toBeExisting();
    await browser.keys("Enter");
    await expect($(PROMPT)).not.toBeExisting({ wait: 30_000 });
    await browser.waitUntil(() => existsSync(SENT) && readFileSync(SENT, "utf8").includes("/release-notes for v2"), { timeout: 30_000, timeoutMsg: "Claude never got the command" });
    const first = JSON.parse(readFileSync(SENT, "utf8").split("\n")[0]);
    expect(JSON.stringify(first.message.content)).toContain('"/release-notes for v2"');
  });
});
