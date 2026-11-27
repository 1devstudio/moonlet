// Auto-fix pull requests (X117): with the Git setting on, a session's PR
// whose checks failed puts an Auto-fix message in the session's Claude
// chat, labelled as such, and the More menu shows Auto-fix this PR checked.

import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { PROJECT, openSettings, closeSettings, rpc, sel, world } from "../fixtures";

const w = world();
const FAKE_CLAUDE_PATH = join(w.root, "bin", "claude");
const FAKE_GH_PATH = join(w.root, "bin", "gh");
const SESSION = "Gift cards";

/** Answers every message at once, as Claude does when it has nothing to do. */
const FAKE_CLAUDE = String.raw`#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) printf '%s\n' '{"type":"system","subtype":"init","session_id":"e2e-fix","model":"e2e-model","slash_commands":[]}' ;;
    *'"type":"user"'*) printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"usage":{}}' ;;
  esac
done
`;

/** The user is sam-rivera, whose open PR #12 failed its test check. */
const FAKE_GH = String.raw`#!/bin/sh
case "$*" in
  "api user --jq .login") echo sam-rivera; exit 0 ;;
  *author,body,reviews,comments*) echo '{"author":{"login":"sam-rivera"},"body":"","reviews":[],"comments":[]}'; exit 0 ;;
  "api repos/"*) echo '[]'; exit 0 ;;
esac
pr='{"number":12,"url":"https://github.com/acme/web/pull/12","state":"OPEN","title":"Gift cards","isDraft":false,"reviewDecision":"","statusCheckRollup":[{"__typename":"CheckRun","name":"test","status":"COMPLETED","conclusion":"FAILURE","detailsUrl":"https://github.com/acme/web/actions/runs/1/job/2"}],"headRefOid":"abc1234def","createdAt":"2099-01-01T00:00:00Z","updatedAt":"2099-01-01T00:00:00Z"}'
case "$1 $2" in
  "pr list") echo "[$pr]" ;;
  "pr view") echo "$pr" ;;
  *) exit 1 ;;
esac
`;

describe("auto-fix pull requests (X117)", () => {
  let earlier: { claude: string; gh: string | null } = { claude: "", gh: null };
  let sessionId = "";

  before(() => {
    earlier = { claude: readFileSync(FAKE_CLAUDE_PATH, "utf8"), gh: existsSync(FAKE_GH_PATH) ? readFileSync(FAKE_GH_PATH, "utf8") : null };
    writeFileSync(FAKE_CLAUDE_PATH, FAKE_CLAUDE);
    writeFileSync(FAKE_GH_PATH, FAKE_GH);
    chmodSync(FAKE_CLAUDE_PATH, 0o755);
    chmodSync(FAKE_GH_PATH, 0o755);
  });

  after(async () => {
    rpc(w, "git.set_settings", { auto_fix_prs: false });
    if (sessionId) rpc(w, "session.archive", { id: sessionId });
    await expect($(sel.sessionRow(SESSION))).not.toBeExisting();
    writeFileSync(FAKE_CLAUDE_PATH, earlier.claude);
    if (earlier.gh === null) rmSync(FAKE_GH_PATH, { force: true });
    else writeFileSync(FAKE_GH_PATH, earlier.gh);
  });

  it("keeps the switch in the host's daemon", async () => {
    await openSettings("Git");
    const fix = sel.settingsSwitch("Auto-fix pull requests");
    await expect($(fix)).toHaveAttribute("aria-checked", "false");
    await $(fix).click();
    await browser.waitUntil(() => rpc<{ auto_fix_prs: boolean }>(w, "git.settings", {}).auto_fix_prs, { timeoutMsg: "the daemon never got auto_fix_prs" });
    await closeSettings();
  });

  it("puts the PR's failed checks in the session's Claude chat as an Auto-fix message", async () => {
    const project = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!;
    sessionId = rpc<{ id: string }>(w, "session.create", { project_id: project.id, name: SESSION, agent: "claude" }).id;
    await $(sel.sessionRow(SESSION)).click();
    // Opening the session polls its PR, which the host checks for auto-fix.
    await expect($('//*[normalize-space()="Auto-fix"]')).toBeDisplayed({ wait: 30_000 });
    await expect($(sel.text("Checks failed on #12 (abc1234): test."))).toBeDisplayed();
  });

  it("shows Auto-fix this PR checked in the session's More menu", async () => {
    await $('button[aria-label="Session actions"]').click();
    await expect($('//button[@role="menuitemcheckbox"][.//*[normalize-space()="Auto-fix this PR"]]')).toHaveAttribute("aria-checked", "true");
    await $('//div[contains(@class,"fixed inset-0 z-30")]').click();
  });
});
