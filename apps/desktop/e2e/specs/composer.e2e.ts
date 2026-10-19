// The new-session composer's layout and source picks (X54): a header with the
// project, the task and the source picker; a branch row for the git things.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { fill, projectId, rpc, sel, world } from "../fixtures";

const w = world();
const fakeGh = join(w.root, "bin", "gh");
// `gh pr list --json number,title,body,url,headRefName` and `gh issue list`, as gh prints them.
const PRS = JSON.stringify([
  { number: 214, title: "Clean up the side nav before the Storefront release", body: "Drops A/B Testing and Security from the side nav.", url: "https://github.com/acme/storefront/pull/214", headRefName: "fix/side-nav-cleanup" },
]);
// `gh pr view 214 --json author,body,reviews,comments`, trimmed.
const PR_VIEW = JSON.stringify({ author: { login: "sam-rivera" }, body: "Drops A/B Testing and Security from the side nav.", reviews: [{ author: { login: "jo-park" }, authorAssociation: "MEMBER", state: "CHANGES_REQUESTED", body: "Keep Security for admins." }], comments: [] });
const ISSUES = JSON.stringify([{ number: 57, title: "Terminal flickers when resizing a split", body: "Resizing a split redraws the whole terminal.", url: "https://github.com/acme/storefront/issues/57" }]);

// While this file exists, gh answers the issue list late (a slow network).
const slowIssues = join(w.root, "gh-slow-issues");
const git = (...args: string[]) => execFileSync("git", args, { cwd: w.repo, env: w.env, stdio: "pipe" });
// The PR's head lives where `git fetch origin pull/214/head` finds it.
const origin = join(w.root, "origin.git");
const dialog = '//div[@role="dialog"][@aria-label="New session"]';
const header = `${dialog}//div[@role="group"][@aria-label="Project and task"]`;
const row = `${dialog}//div[@role="group"][@aria-label="Branch"]`;
const open = async () => {
  await $('button[title="New session"]').click();
  await $(row).waitForDisplayed({ timeout: 10_000 });
};

describe("new session composer (X54)", () => {
  // Another spec may have left its own fake gh: put it back afterwards.
  let earlierGh: string | null = null;
  before(() => {
    earlierGh = existsSync(fakeGh) ? readFileSync(fakeGh, "utf8") : null;
    writeFileSync(
      fakeGh,
      `#!/bin/sh\nif [ "$1 $2" = "pr list" ]; then cat <<'JSON'\n${PRS}\nJSON\nexit 0; fi\nif [ "$1 $2" = "issue list" ] && [ -e "${slowIssues}" ]; then sleep 2; fi\nif [ "$1 $2" = "issue list" ]; then cat <<'JSON'\n${ISSUES}\nJSON\nexit 0; fi\nif [ "$*" = "pr view 214 --json author,body,reviews,comments" ]; then cat <<'JSON'\n${PR_VIEW}\nJSON\nexit 0; fi\nif [ "$1 $2 $3 $4 $5" = "pr view 214 --json headRefName" ]; then echo fix/side-nav-cleanup; exit 0; fi\nif [ "$1" = "api" ]; then echo '[]'; exit 0; fi\nexit 1\n`,
    );
    chmodSync(fakeGh, 0o755);
    execFileSync("git", ["init", "-q", "--bare", origin], { env: w.env, stdio: "pipe" });
    git("remote", "add", "origin", `file://${origin}`);
    git("push", "-q", "origin", "main:refs/pull/214/head");
  });
  after(async () => {
    rmSync(slowIssues, { force: true });
    git("remote", "remove", "origin");
    rmSync(origin, { recursive: true, force: true });
    for (const s of rpc<{ id: string; pr?: number | null }[]>(w, "session.list", {})) if (s.pr === 214) rpc(w, "session.archive", { id: s.id });
    if (earlierGh === null) rmSync(fakeGh, { force: true });
    else writeFileSync(fakeGh, earlierGh);
    await browser.execute((id: string) => localStorage.removeItem(`moonlet.composer.${id}`), projectId(w));
  });
  afterEach(async () => {
    // Esc closes the composer from the prompt.
    if (await $(dialog).isExisting()) {
      await $(`${dialog}//textarea`).click();
      await browser.keys("Escape");
      await $(dialog).waitForExist({ reverse: true });
    }
  });

  it("puts the branch, its base and branch options in a row of their own", async () => {
    await open();
    await expect($(`${row}//span[normalize-space()="New branch"]/following-sibling::span[normalize-space()="from main"]`)).toBeDisplayed();
    await expect($(`${row}//button[@title="Branch options"]`)).toBeDisplayed();
    await expect($(`${header}//button[@title="Branch options"]`)).not.toBeExisting();
    // The header reads: the project, a separator, then the source picker at the right end.
    const x = async (xpath: string) => (await $(xpath).getLocation()).x;
    const project = await x(`${header}//button[starts-with(normalize-space(), "e2e-repo")]`);
    const separator = await x(`${header}/span[normalize-space()="|"]`);
    const picker = await x(`${header}//button[@title="Start from a GitHub issue or pull request"]`);
    expect(project < separator && separator < picker).toBe(true);
  });

  it("asks for a ref inside the branch row, and × goes back to the base", async () => {
    await open();
    await $(`${row}//button[@title="Branch options"]`).click();
    await $('//button[normalize-space()="Start from branch or commit…"]').click();
    await fill(`${row}//input[starts-with(@placeholder, "Branch, tag or commit")]`, "main~0");
    await browser.keys("Enter");
    await expect($(`${row}//span[normalize-space()="from main~0"]`)).toBeDisplayed();
    await $(`${row}//button[@title="Start from main instead"]`).click();
    await expect($(`${row}//span[normalize-space()="from main"]`)).toBeDisplayed();
  });

  it("turns the branch row into the PR row on a picked PR, and New branch instead undoes it", async () => {
    await open();
    await $(`${header}//button[@title="Start from a GitHub issue or pull request"]`).click();
    await $('//button[normalize-space()="Pull requests"]').click();
    // The picker says what a pick does (X54).
    await expect($(sel.text("Picking a PR starts the session on its branch, instead of a new branch from main."))).toBeDisplayed();
    await $('//button[.//span[normalize-space()="#214"]]').click();
    await expect($(`${row}//span[normalize-space()="PR #214"]`)).toBeDisplayed();
    await expect($(`${row}//span[normalize-space()="fix/side-nav-cleanup"]`)).toBeDisplayed();
    await expect($(`${row}//span[normalize-space()="existing branch · checks out in a new worktree"]`)).toBeDisplayed();
    await $(`${row}//button[normalize-space()="New branch instead"][@title="Create a new branch from main instead"]`).click();
    await expect($(`${row}//span[normalize-space()="New branch"]`)).toBeDisplayed();
    await expect($(`${row}//span[normalize-space()="PR #214"]`)).not.toBeExisting();
    // The undo button goes, the focus stays in the composer: esc closes it.
    await browser.keys("Escape");
    await expect($(dialog)).not.toBeExisting();
  });

  it("drops a list that arrives after a switch to the other tab: no issue shows as a pull request", async () => {
    writeFileSync(slowIssues, "");
    try {
      await open();
      // The picker opens on Issues, whose list comes 2 s late; Pull requests' comes at once.
      await $(`${header}//button[@title="Start from a GitHub issue or pull request"]`).click();
      await $('//button[normalize-space()="Pull requests"]').click();
      await expect($('//button[.//span[normalize-space()="#214"]]')).toBeDisplayed();
      await browser.pause(3000);
      await expect($('//button[.//span[normalize-space()="#57"]]')).not.toBeExisting();
      await expect($('//button[.//span[normalize-space()="#214"]]')).toBeDisplayed();
    } finally {
      rmSync(slowIssues, { force: true });
    }
  });

  it("adds a picked issue as an attachment whatever the prompt holds, and × removes it", async () => {
    await open();
    await fill(`${dialog}//textarea[@placeholder="What do you want to work on?"]`, "Check Safari too.");
    await $(`${header}//button[@title="Start from a GitHub issue or pull request"]`).click();
    await $('//button[.//span[normalize-space()="#57"]]').click();
    const attachment = $(`${dialog}//div[@role="group"][@aria-label="#57 Terminal flickers when resizing a split · GitHub issue"]`);
    await expect(attachment).toBeDisplayed();
    // What the user typed stays theirs; the placeholder speaks of the issue (X54).
    await expect($(`${dialog}//textarea[@placeholder="Anything to add? Leave empty to start from the issue."]`)).toHaveValue("Check Safari too.");
    await attachment.$('.//button[@title="Remove #57"]').click();
    await expect(attachment).not.toBeExisting();
  });

  it("sends a picked PR's description and reviews first, and starts the session on its branch with its number", async () => {
    await browser.execute((id: string) => localStorage.setItem(`moonlet.composer.${id}`, JSON.stringify({ agent: "fake", model: null, effort: null })), projectId(w));
    await open();
    await $(`${header}//button[@title="Start from a GitHub issue or pull request"]`).click();
    await $('//button[normalize-space()="Pull requests"]').click();
    await $('//button[.//span[normalize-space()="#214"]]').click();
    const attachment = $(`${dialog}//div[@role="group"][@aria-label="PR #214 description and review comments · Clean up the side nav before the Storefront release"]`);
    await attachment.$('.//button[@aria-expanded="false"]').click();
    // The reviews come through gh.pr_context.
    await expect(attachment.$('.//*[normalize-space()="@jo-park, changes requested: Keep Security for admins."]')).toBeDisplayed({ wait: 10_000 });
    await fill(`${dialog}//textarea`, "Address the review comments.");
    await $(`${dialog}${sel.button("Create")}`).click();

    await expect($(sel.sessionRow("Clean up the side nav before the Storefront release"))).toBeDisplayed({ wait: 30_000 });
    const created = rpc<{ id: string; name: string; branch: string; pr?: number | null }[]>(w, "session.list", {}).find((s) => s.pr === 214);
    expect([created?.name, created?.branch]).toEqual(["Clean up the side nav before the Storefront release", "moonlet/pr-214"]);
    const agent = rpc<{ session_id?: string; agent?: string; command: string[] }[]>(w, "terminal.list", {}).find((t) => t.session_id === created?.id && t.agent === "fake");
    expect(agent?.command.join(" ")).toContain(
      "'PR #214 · Clean up the side nav before the Storefront release\n\nDrops A/B Testing and Security from the side nav.\n\nReviews:\n- @jo-park, changes requested: Keep Security for admins.\n\nhttps://github.com/acme/storefront/pull/214\n\nAddress the review comments.'",
    );
  });
});
