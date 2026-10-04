// Pull the base branch (X13): the sidebar shows what origin has that the
// local main lacks, and Pull fast-forwards main.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { $, expect } from "@wdio/globals";
import { CONFIG, resetConfig, sel, world } from "../fixtures";

const w = world();
const origin = join(w.root, "origin.git");
const other = join(w.root, "other");
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=e2e@jaunt.test", "-c", "user.name=e2e", ...args], { cwd, env: w.env, stdio: "pipe" }).toString().trim();

const chip = () => $('button[title="main is 2 commits behind origin/main"]');
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
  });

  after(() => {
    git(w.repo, "remote", "remove", "origin");
  });

  it("shows how far main is behind origin and lists the incoming commits", async () => {
    // A projects.changed event makes the app fetch.
    resetConfig(w, CONFIG);
    await expect(chip()).toBeDisplayed({ wait: 30_000 });
    await expect(chip()).toHaveText("2");
    await chip().click();
    await expect(popover()).toBeDisplayed();
    await expect($(sel.text("main is 2 commits behind origin"))).toBeDisplayed();
    await expect($(sel.text("Merge pull request #128 from 1devstudio/github-pr-sessions"))).toBeDisplayed();
    await expect($(sel.text("Open sessions from GitHub PRs"))).toBeDisplayed();
  });

  it("pulls main to origin's head and hides the chip", async () => {
    const tip = git(other, "rev-parse", "HEAD");
    await $(sel.button("Pull main")).click();
    await expect($(sel.text(`Pulled 2 commits into main. New sessions start from ${tip.slice(0, 7)}.`))).toBeDisplayed();
    await expect(chip()).not.toBeExisting();
    expect(git(w.repo, "rev-parse", "main")).toBe(tip);
  });
});
