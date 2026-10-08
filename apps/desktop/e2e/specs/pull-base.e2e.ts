// Pull the base branch (X13): the sidebar shows what origin has that the
// local main lacks on hover, and a click fast-forwards main.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, $$, browser, expect } from "@wdio/globals";
import { CONFIG, hover, resetConfig, rpc, sel, world } from "../fixtures";

const w = world();
const origin = join(w.root, "origin.git");
const other = join(w.root, "other");
// A second project, one commit behind its own origin.
const second = join(w.root, "e2e-second");
const secondOrigin = join(w.root, "e2e-second-origin.git");
const secondOther = join(w.root, "e2e-second-other");
let secondId = "";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=e2e@moonlet.test", "-c", "user.name=e2e", ...args], { cwd, env: w.env, stdio: "pipe" }).toString().trim();

const chip = () => $('button[aria-label="main is 2 commits behind origin/main"]');
const secondChip = () => $('button[aria-label="main is 1 commit behind origin/main"]');
const popover = () => $('[role="dialog"][aria-label="Pull main"]');

describe("Pull base branch", () => {
  before(() => {
    // GitHub stand-in: a bare origin that gets two merges the project lacks.
    git(w.root, "init", "-q", "--bare", "-b", "main", origin);
    git(w.repo, "remote", "add", "origin", origin);
    git(w.repo, "push", "-q", "origin", "main");
    git(w.root, "clone", "-q", origin, other);
    git(other, "commit", "-q", "--allow-empty", "-m", "Open sessions from GitHub PRs");
    git(other, "commit", "-q", "--allow-empty", "-m", "Merge pull request #128 from 1devstudio/github-pr-sessions");
    git(other, "push", "-q", "origin", "main");

    mkdirSync(second);
    writeFileSync(join(second, "README.md"), "second\n");
    git(second, "init", "-q", "-b", "main");
    git(second, "add", "-A");
    git(second, "commit", "-qm", "init");
    git(w.root, "init", "-q", "--bare", "-b", "main", secondOrigin);
    git(second, "remote", "add", "origin", secondOrigin);
    git(second, "push", "-q", "origin", "main");
    git(w.root, "clone", "-q", secondOrigin, secondOther);
    git(secondOther, "commit", "-q", "--allow-empty", "-m", "Tidy the second project");
    git(secondOther, "push", "-q", "origin", "main");
    secondId = rpc<{ id: string }>(w, "project.add", { path: second }).id;
  });

  after(() => {
    git(w.repo, "remote", "remove", "origin");
    rpc(w, "project.remove", { id: secondId });
  });

  it("shows how far main is behind origin and lists the incoming commits", async () => {
    // A projects.changed event makes the app fetch.
    resetConfig(w, CONFIG);
    await expect(chip()).toBeDisplayed({ wait: 30_000 });
    await expect(chip()).toHaveText("2");
    await hover(chip());
    await expect(popover()).toBeDisplayed();
    await expect($(sel.text("main is 2 commits behind origin"))).toBeDisplayed();
    await expect($(sel.text("Merge pull request #128 from 1devstudio/github-pr-sessions"))).toBeDisplayed();
    await expect($(sel.text("Open sessions from GitHub PRs"))).toBeDisplayed();
    // The chip is the pull button; the popover only informs.
    await expect(popover().$("button")).not.toBeExisting();
    // Scrolling the commit list keeps the popover open.
    const commit = await $(sel.text("Open sessions from GitHub PRs"));
    await browser.execute((el) => el.dispatchEvent(new Event("scroll")), commit);
    await expect(popover()).toBeDisplayed();
  });

  it("keeps one pull popover open at a time", async () => {
    await browser.keys("Escape");
    await expect(popover()).not.toBeExisting();
    await expect(secondChip()).toBeDisplayed({ wait: 30_000 });
    await hover(secondChip());
    await expect($(sel.text("Tidy the second project"))).toBeDisplayed();
    await hover(chip());
    await expect($$('[role="dialog"][aria-label="Pull main"]')).toBeElementsArrayOfSize(1);
    await expect($(sel.text("Open sessions from GitHub PRs"))).toBeDisplayed();
    await expect($(sel.text("Tidy the second project"))).not.toBeExisting();
  });

  it("pulls main to origin's head when the chip is clicked, and hides the chip", async () => {
    const tip = git(other, "rev-parse", "HEAD");
    await chip().click();
    await expect($(sel.text(`Pulled 2 commits into main. New sessions start from ${tip.slice(0, 7)}.`))).toBeDisplayed();
    await expect(chip()).not.toBeExisting();
    expect(git(w.repo, "rev-parse", "main")).toBe(tip);
  });
});
