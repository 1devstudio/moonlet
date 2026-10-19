// Settings › Git (X55): a change is kept by the host's daemon, and the
// dialogs it names start the way it says.

import { $, browser, expect } from "@wdio/globals";
import { closeSettings, fill, openSettings, projectId, rpc, sel, SESSION, world } from "../fixtures";

const w = world();
const drafts = sel.settingsSwitch("Open pull requests as drafts");
const prDialog = '//div[@role="dialog"][.//*[normalize-space()="Create pull request"]]';

async function press(key: string, code: string, mods: { metaKey?: boolean; shiftKey?: boolean } = {}) {
  await browser.execute(
    (k: string, c: string, m: object) =>
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, code: c, bubbles: true, cancelable: true, ...m })),
    key,
    code,
    mods,
  );
}

describe("Git settings", () => {
  after(() => {
    rpc(w, "git.set_settings", { draft_prs: false, branch_prefix: "moonlet/" });
  });

  it("is a page of the App group", async () => {
    await openSettings("Git");
    await expect($('//h1[normalize-space()="Git"]')).toBeDisplayed();
    await expect($(sel.text("Commits and pull requests"))).toBeDisplayed();
  });

  it("keeps a change in the host's daemon", async () => {
    await expect($(drafts)).toHaveAttribute("aria-checked", "false");
    await $(drafts).click();
    await expect($(drafts)).toHaveAttribute("aria-checked", "true");
    await browser.waitUntil(() => rpc<{ draft_prs: boolean }>(w, "git.settings", {}).draft_prs, { timeoutMsg: "the daemon never got draft_prs" });
    await closeSettings();
  });

  it("refuses a branch prefix git would reject", async () => {
    await openSettings("Git");
    await fill(sel.settingsField("Branch prefix"), "my prefix/");
    await expect($(sel.text("Branch names cannot hold spaces or ~ ^ : ? * [ \\"))).toBeDisplayed();
    await browser.keys(["Enter"]);
    expect(rpc<{ branch_prefix: string }>(w, "git.settings", {}).branch_prefix).toBe("moonlet/");
  });

  it("names new sessions' branches with the saved prefix", async () => {
    await fill(sel.settingsField("Branch prefix"), "e2e/");
    await expect($(sel.text("e2e/add-search-to-the-product-list"))).toBeDisplayed();
    await browser.keys(["Enter"]);
    await browser.waitUntil(() => rpc<{ branch_prefix: string }>(w, "git.settings", {}).branch_prefix === "e2e/", { timeoutMsg: "the prefix was never saved" });
    const s = rpc<{ id: string; branch: string }>(w, "session.create", { project_id: projectId(w), name: "Prefixed", agent: "none" });
    rpc(w, "session.archive", { id: s.id, delete_branch: true });
    expect(s.branch).toBe("e2e/prefixed");
    await closeSettings();
  });

  it("starts Create pull request as a draft", async () => {
    await $(sel.sessionRow(SESSION)).click();
    await press("P", "KeyP", { metaKey: true, shiftKey: true });
    await expect($(prDialog)).toBeDisplayed();
    await expect($(`${prDialog}//label[contains(normalize-space(), "Draft")]/input`)).toBeSelected();
    await $(`${prDialog}//button[normalize-space()="Cancel"]`).click();
    await expect($(prDialog)).not.toBeExisting();
  });

  it("starts Commit without staging everything when switched off", async () => {
    await openSettings("Git");
    await $(sel.settingsSwitch("Stage all changes before committing")).click();
    await browser.waitUntil(() => !rpc<{ stage_all: boolean }>(w, "git.settings", {}).stage_all, { timeoutMsg: "stage_all was never saved" });
    await closeSettings();
    await $(sel.sessionRow(SESSION)).click();
    await press("k", "KeyK", { metaKey: true });
    await fill('//div[@role="dialog"][@aria-label="Run action"]//input', "commit");
    await press("Enter", "Enter");
    const commit = '//div[@role="dialog"][.//*[normalize-space()="Commit changes"]]';
    await expect($(commit)).toBeDisplayed();
    await expect($(`${commit}//label[contains(normalize-space(), "Stage all changes first")]/input`)).not.toBeSelected();
    await $(`${commit}//button[normalize-space()="Cancel"]`).click();
    rpc(w, "git.set_settings", { stage_all: true });
  });

  it("saves a typed prefix when Settings closes", async () => {
    await openSettings("Git");
    await fill(sel.settingsField("Branch prefix"), "closed/");
    await closeSettings();
    await browser.waitUntil(() => rpc<{ branch_prefix: string }>(w, "git.settings", {}).branch_prefix === "closed/", { timeoutMsg: "the prefix was lost on close" });
    rpc(w, "git.set_settings", { branch_prefix: "moonlet/" });
  });
});
