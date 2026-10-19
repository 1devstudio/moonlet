// The in-app confirm modal (X23), through its most used case: archiving a
// session from the ⋯ menu.

import { execFileSync } from "node:child_process";
import { $, expect } from "@wdio/globals";
import { PROJECT, rpc, sel, world } from "../fixtures";

const w = world();
const SESSION = "Archive me";
const KEPT = 'Archive "Archive me"? Its terminals stop and the worktree folder is removed. The branch is kept.';
const DELETED = 'Archive "Archive me"? Its terminals stop and the worktree folder is removed. The branch is deleted too.';
const modal = () => $(sel.confirm("Archive session"));
const branchExists = (branch: string) => execFileSync("git", ["-C", w.repo, "branch", "--list", branch], { encoding: "utf8" }).trim() !== "";

async function openArchive() {
  await $('button[title="More"]').click();
  await $(sel.button("Archive session…")).click();
  await expect(modal()).toBeDisplayed();
}

describe("confirm modal", () => {
  let branch = "";

  after(() => {
    rpc(w, "git.set_settings", { archive_branch: "merged" });
  });

  before(async () => {
    // The checkbox is Settings › Git's "Ask each time" (X55).
    rpc(w, "git.set_settings", { archive_branch: "ask" });
    const project = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!;
    branch = rpc<{ branch: string }>(w, "session.create", { project_id: project.id, name: SESSION, agent: "none" }).branch;
    await $(sel.sessionRow(SESSION)).click();
  });

  it("asks before archiving, says what happens to the branch, and cancels", async () => {
    await openArchive();
    await expect($(sel.text(KEPT))).toBeDisplayed();
    await expect($(sel.confirmButton("Archive"))).toBeFocused();

    await $(`${sel.confirm("Archive session")}//label[normalize-space()="Also delete the branch"]/input`).click();
    await expect($(sel.text(DELETED))).toBeDisplayed();

    await $(sel.confirmButton("Cancel")).click();
    await expect(modal()).not.toBeExisting();
    await expect($(sel.sessionRow(SESSION))).toBeDisplayed();
  });

  it("archives and keeps the branch when confirmed with the box clear", async () => {
    await openArchive();
    await expect($(sel.text(KEPT))).toBeDisplayed();
    await $(sel.confirmButton("Archive")).click();
    await expect(modal()).not.toBeExisting();
    await expect($(sel.sessionRow(SESSION))).not.toBeExisting({ wait: 15_000 });
    expect(branchExists(branch)).toBe(true);
  });
});
