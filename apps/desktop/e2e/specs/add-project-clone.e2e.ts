// Adding a project from GitHub (X59): pick a repository gh lists, clone it
// with live progress, and land in the new session composer.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { choose, fill, rpc, sel, world } from "../fixtures";

const w = world();
const fakeGh = join(w.root, "bin", "gh");
const ghFixture = (name: string) => join(process.cwd(), "../../crates/moonlet-core/tests/fixtures", name);
const origin = join(w.root, "clone-origin");
const clonedPath = join(w.env.HOME, "moonlet", "storefront-admin");
const dialog = '//div[@role="dialog"][@aria-label="Add project"]';
let previousGh: string | null = null;

const key = (k: string) =>
  browser.execute((name: string) => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })), k);

const openAddProject = async () => {
  await browser.execute(() =>
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", metaKey: true, bubbles: true, cancelable: true })),
  );
  await fill('//div[@role="dialog"][@aria-label="Run action"]//input', "Add project");
  await browser.execute(() => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true })));
  await $(dialog).waitForDisplayed();
};

describe("Add project from GitHub", () => {
  before(async () => {
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: w.env, stdio: "pipe" });
    mkdirSync(join(origin, "src"), { recursive: true });
    writeFileSync(join(origin, "src", "README.md"), "admin\n");
    git(join(origin, "src"), "init", "-q", "-b", "main");
    git(join(origin, "src"), "add", "-A");
    git(join(origin, "src"), "-c", "user.email=e2e@moonlet.test", "-c", "user.name=e2e", "commit", "-qm", "init");
    git(origin, "clone", "-q", "--bare", "src", "storefront-admin.git");
    // gh is signed in, lists the fixture's repositories, views any one as
    // the fixture's storefront under its own name, and clones the local
    // bare repository. Specs share bin/gh: put back what was there after.
    previousGh = existsSync(fakeGh) ? readFileSync(fakeGh, "utf8") : null;
    writeFileSync(
      fakeGh,
      `#!/bin/sh\ncase "$1 $2" in\n  "auth status") cat '${ghFixture("gh-auth-status.txt")}' ;;\n  "repo view") sed "s#acme/storefront#$3#" '${ghFixture("gh-repo-view.json")}' ;;\n  "api user/repos"*) cat '${ghFixture("gh-user-repos.json")}' ;;\n  "repo clone") if [ "$3" = acme/big ]; then mkdir -p "$4"; printf "remote: Counting objects: 100%% (12840/12840), done.\\nReceiving objects:  64%% (8213/12840), 21.40 MiB | 6.20 MiB/s\\r" >&2; exec sleep 60; fi; exec git clone --progress "file://${join(origin, "storefront-admin.git")}" "$4" ;;\n  *) exit 1 ;;\nesac\n`,
    );
    chmodSync(fakeGh, 0o755);
    await browser.execute(() => localStorage.removeItem("moonlet.cloneParents"));
  });

  after(async () => {
    const added = rpc<{ id: string; path: string }[]>(w, "project.list", {}).find((p) => p.path.endsWith("/moonlet/storefront-admin"));
    if (added) rpc(w, "project.remove", { id: added.id });
    rmSync(clonedPath, { recursive: true, force: true });
    if (previousGh === null) rmSync(fakeGh, { force: true });
    else writeFileSync(fakeGh, previousGh);
    await browser.execute(() => localStorage.removeItem("moonlet.cloneParents"));
    if (await $('//div[@role="dialog"]').isExisting()) await browser.keys("Escape");
  });

  it("clones a repository picked from the user's list and opens the composer for it", async () => {
    await openAddProject();
    await $(`${dialog}//button[@role="radio"][normalize-space()="Clone from GitHub"]`).click();
    await expect($(`${dialog}//*[normalize-space()="gh signed in on This Mac"]`)).toBeDisplayed();
    await fill(`${dialog}//input[@aria-label="Repository"]`, "store");
    const list = `${dialog}//div[@role="listbox"][@aria-label="Your repositories"]`;
    await expect($(`${list}//*[normalize-space()="from gh · acme, sam-rivera"]`)).toBeDisplayed();
    await expect($(`${dialog}//*[normalize-space()="Not listed? Type owner/repo or paste any URL you can access."]`)).toBeDisplayed();
    // One match: ↓ wraps onto it and Enter picks it.
    await fill(`${dialog}//input[@aria-label="Repository"]`, "storefront-admin");
    await $(`${list}//button[.//span[normalize-space()="acme/storefront-admin"]]`).waitForDisplayed();
    await key("ArrowDown");
    await key("Enter");
    await expect($(`${dialog}//input[@aria-label="Repository"]`)).toHaveValue("acme/storefront-admin");
    await expect($(`${dialog}//*[normalize-space()="A GitHub URL, owner/repo, or an SSH address."]`)).toBeDisplayed();

    const card = `${dialog}//div[@aria-label="Repository found"]`;
    await expect($(`${card}//*[normalize-space()="Found"]`)).toBeDisplayed();
    await expect($(`${card}//*[normalize-space()="Next.js storefront for the Acme shop"]`)).toBeDisplayed();
    await expect($(`${dialog}//input[@aria-label="Parent folder"]`)).toHaveValue("~/moonlet");
    await expect($(`${dialog}//input[@aria-label="Folder name"]`)).toHaveValue("storefront-admin");
    const cloneButton = $(`${dialog}//button[normalize-space()="Clone and add"]`);
    await cloneButton.waitForEnabled();
    await cloneButton.click();

    await $('//div[@role="dialog"][@aria-label="New session"]').waitForDisplayed({ timeout: 20_000 });
    await expect($(sel.text("Added storefront-admin"))).toBeDisplayed();
    const project = rpc<{ name: string; path: string }[]>(w, "project.list", {}).find((p) => p.name === "storefront-admin");
    expect(project?.path.endsWith("/moonlet/storefront-admin")).toBe(true);
    expect(existsSync(join(clonedPath, "README.md"))).toBe(true);
    await browser.keys("Escape");
  });

  it("adds a repository that is a project of another workspace to the chosen section without cloning it", async () => {
    const holders = (id: string) =>
      rpc<{ name: string; project_ids: string[] }[]>(w, "section.list", {})
        .filter((x) => x.project_ids.includes(id))
        .map((x) => x.name);
    const project = rpc<{ id: string; name: string; path: string }[]>(w, "project.list", {}).find((p) => p.name === "storefront-admin")!;
    // Its origin is the repository gh lists, as a cloned project's would be.
    execFileSync("git", ["remote", "set-url", "origin", "git@github.com:acme/storefront-admin.git"], { cwd: project.path, env: w.env, stdio: "pipe" });
    const studio = rpc<{ id: string }>(w, "workspace.create", { name: "Studio", color: "blue" });
    const side = rpc<{ id: string }>(w, "section.create", { workspace_id: studio.id, name: "Side" });
    const projectsBefore = rpc<{ id: string }[]>(w, "project.list", {}).length;
    const row = `${dialog}//div[@role="listbox"][@aria-label="Your repositories"]//button[.//span[normalize-space()="acme/storefront-admin"]]`;
    try {
      await openAddProject();
      await $(`${dialog}//button[@role="radio"][normalize-space()="Clone from GitHub"]`).click();
      await fill(`${dialog}//input[@aria-label="Repository"]`, "storefront-admin");
      // In the section the dialog starts on, the project is already there.
      await $(row).waitForDisplayed();
      await expect($(`${row}//*[normalize-space()="Already added"]`)).toBeDisplayed();
      await expect($(row)).toBeDisabled();

      // Another workspace's section: the same row now adds the folder there.
      await choose(`${dialog}//select[option[normalize-space()="Studio › Side"]]`, side.id);
      await expect($(`${row}//*[normalize-space()="Add to this section"]`)).toBeDisplayed();
      await $(row).click();
      await $('//div[@role="dialog"][@aria-label="New session"]').waitForDisplayed({ timeout: 20_000 });
      expect(holders(project.id)).toContain("Side");
      expect(holders(project.id).length).toBe(2);
      expect(rpc<{ id: string }[]>(w, "project.list", {}).length).toBe(projectsBefore);
      await browser.keys("Escape");
    } finally {
      rpc(w, "section.delete", { id: side.id });
      rpc(w, "workspace.delete", { id: studio.id });
    }
  });

  it("sends a URL typed as a folder to the clone tab, which sees the folder is taken", async () => {
    await openAddProject();
    await fill(`${dialog}//input[@placeholder="~/code/my-project"]`, "https://github.com/acme/storefront-admin");
    await expect($(`${dialog}//*[normalize-space()="That's a GitHub repository, not a folder."]`)).toBeDisplayed();
    await expect($(`${dialog}//button[normalize-space()="Add project"]`)).toBeDisabled();
    await $(`${dialog}//button[starts-with(normalize-space(), "Clone acme/storefront-admin")]`).click();

    await expect($(`${dialog}//input[@aria-label="Repository"]`)).toHaveValue("https://github.com/acme/storefront-admin");
    // The parent the last clone used is remembered; the folder is there now.
    await expect($(`${dialog}//*[normalize-space()="~/moonlet/storefront-admin already exists"]`)).toBeDisplayed();
    await expect($(`${dialog}//button[normalize-space()="Clone and add"]`)).toBeDisabled();
    await $(`${dialog}//button[normalize-space()="Use storefront-admin-2"]`).click();
    await expect($(`${dialog}//input[@aria-label="Folder name"]`)).toHaveValue("storefront-admin-2");
    await $(`${dialog}//button[normalize-space()="Clone and add"]`).waitForEnabled();
    await $(`${dialog}//button[normalize-space()="Cancel"]`).click();
    await expect($(dialog)).not.toBeExisting();
  });

  it("shows git's progress while it clones, and Cancel clone leaves no folder", async () => {
    await openAddProject();
    await $(`${dialog}//button[@role="radio"][normalize-space()="Clone from GitHub"]`).click();
    await fill(`${dialog}//input[@aria-label="Repository"]`, "acme/big");
    const cloneButton = $(`${dialog}//button[normalize-space()="Clone and add"]`);
    await cloneButton.waitForEnabled();
    await cloneButton.click();

    const card = `${dialog}//div[@role="status"]`;
    await expect($(`${card}//*[normalize-space()="Receiving objects 8,213/12,840 · 21.40 MiB · 6.20 MiB/s"]`)).toBeDisplayed();
    await expect($(`${card}//*[normalize-space()="Counting objects 12,840"]`)).toBeDisplayed();
    // 10 + 80 × 8213/12840
    await expect($(`${card}//*[normalize-space()="61%"]`)).toBeDisplayed();
    await expect($(`${dialog}//*[normalize-space()="Closing keeps the clone running in the background."]`)).toBeDisplayed();
    expect(existsSync(join(w.env.HOME, "moonlet", "big"))).toBe(true);

    await $(`${dialog}//button[normalize-space()="Cancel clone"]`).click();
    await cloneButton.waitForEnabled({ timeout: 10_000 });
    expect(existsSync(join(w.env.HOME, "moonlet", "big"))).toBe(false);
    await $(`${dialog}//button[normalize-space()="Cancel"]`).click();
    await expect($(dialog)).not.toBeExisting();
  });
});
