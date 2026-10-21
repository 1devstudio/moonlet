// Keep in sync (X60). A second scratch daemon plays the central host, on
// ::1 as in worker-link.e2e.ts. Its project `shop` is a clone of a repository
// this Mac also has as a project, so both know it as the same project and
// the copy lives in this Mac's own repository. The app pairs with the host,
// keeps a session there in sync (making it the central host on the way),
// approves its setup, and sees files move both ways; a file both sides
// change differs until it is resolved from the popover.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { BIN_DIR, closeSettings, fill, openSettings, rpc, sel, socketRpc, world } from "../fixtures";

const w = world();
const home = join(w.root, "sync-central-home");
// A short path: a Unix socket's must stay under ~104 bytes.
const sock = join(w.root, "sync.sock");
const env = { ...w.env, MOONLET_HOME: home, MOONLET_SOCK: sock, MOONLET_MOBILE_ADDRS: "::1" };
const original = join(w.root, "shop");
// Named `shop` on the central host too: a project is named after its folder.
const clone = join(w.root, "central", "shop");
const SESSION = "Fix cart";
const dialog = '//div[@role="dialog"][@aria-label="Add host"]';

/** One request to the central host's daemon over its socket. */
const centralRpc = <T>(method: string, params: object = {}) => socketRpc<T>(sock, env, method, params);

/** Runs `moonletd pair` on the central host; resolves with the link it prints. */
function startPairing(): { proc: ChildProcess; link: Promise<string> } {
  const proc = spawn(join(BIN_DIR, "moonletd"), ["pair"], { env });
  const link = new Promise<string>((resolve, reject) => {
    let out = "";
    proc.stdout!.on("data", (d) => {
      out += d.toString();
      const m = out.match(/^(moonlet:\/\/pair\?\S+)$/m);
      if (m) resolve(m[1]);
    });
    proc.on("exit", (code) => reject(new Error(`moonletd pair exited ${code} before printing a link: ${out}`)));
  });
  return { proc, link };
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: w.env, stdio: "pipe" });

/** The app's only copy, from this Mac's daemon. */
const theCopy = () => rpc<{ id: string; path: string; differs: string[] }[]>(w, "sync.list", {})[0];

/** Right-clicks a session row: the embedded driver has no right click. */
async function rightClick(xpath: string) {
  await browser.execute((xp: string) => {
    const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 }));
  }, xpath);
}

describe("keep in sync", () => {
  let pairing: ChildProcess | undefined;
  let name = "";
  let sessionPath = "";
  const row = sel.sessionRow(SESSION);
  const mark = (text: string) => $(`${row}//button[starts-with(@aria-label, ${JSON.stringify(`Keep in sync: ${text}`)})]`);

  before(async () => {
    // The project: on this Mac as `shop`, and cloned on the central host.
    mkdirSync(join(original, ".moonlet"), { recursive: true });
    writeFileSync(join(original, ".moonlet", "config.toml"), 'setup = "touch ignored-by-setup"\n');
    writeFileSync(join(original, ".gitignore"), "ignored-by-setup\n");
    writeFileSync(join(original, "README.md"), "shop\n");
    git(original, "init", "-q", "-b", "main");
    git(original, "add", "-A");
    git(original, "-c", "user.email=e2e@moonlet.test", "-c", "user.name=e2e", "commit", "-qm", "init");
    mkdirSync(join(w.root, "central"), { recursive: true });
    git(w.root, "clone", "-q", original, clone);
    rpc(w, "project.add", { path: original });

    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "mobile.json"), '{ "enabled": true, "port": 0 }\n');
    execFileSync(join(BIN_DIR, "moonletd"), ["start"], { env, stdio: "pipe" });
    const project = await centralRpc<{ id: string }>("project.add", { path: clone });
    const session = await centralRpc<{ path: string }>("session.create", { project_id: project.id, name: SESSION, agent: "none" });
    sessionPath = session.path;
  });

  after(async () => {
    pairing?.kill();
    // The app's daemon keeps link.json and its copies across specs: leave neither.
    await openSettings("Hosts");
    if (name && (await $(`button[title="Remove ${name}"]`).isExisting())) await $(`button[title="Remove ${name}"]`).click();
    await closeSettings();
    try {
      execFileSync(join(BIN_DIR, "moonlet"), ["rpc", "daemon.shutdown", "{}"], { env, stdio: "pipe" });
    } catch {
      // Already gone.
    }
  });

  it("pairs with the host and shows its session", async () => {
    const started = startPairing();
    pairing = started.proc;
    const link = await started.link;
    name = new URL(link).searchParams.get("host")!;
    await openSettings("Hosts");
    await $(sel.settingsButton("Add host")).click();
    await fill(`${dialog}//input`, link);
    await $(`${dialog}//button[normalize-space()="Add"]`).click();
    await $(`//*[@data-setting="host-${name}"]//*[starts-with(normalize-space(), "Connected · moonletd ")]`).waitForExist({ timeout: 20000 });
    await closeSettings();

    // The host's workspace, from the switcher.
    await $('button[aria-label^="Switch workspace, current: "]').click();
    await $(`//div[@role="menu"][@aria-label="Workspaces"]/div[div[normalize-space()=${JSON.stringify(name)}]]//button`).click();
    await expect($(row)).toBeDisplayed({ wait: 10_000 });
  });

  it("keeps the session in sync, making the host the central host first, and runs the approved setup", async () => {
    await rightClick(row);
    await $(sel.button("Keep in sync with this Mac")).click();
    await expect($(sel.text(`Keeping ${SESSION} in sync needs ${name} as this Mac's central host. Make it the central host?`))).toBeDisplayed();
    await $(sel.confirmButton("Make it the central host")).click();

    // The setup modal shows the exact command.
    const modal = sel.confirm("Run setup");
    await expect($(`${modal}//pre[normalize-space()="touch ignored-by-setup"]`)).toBeDisplayed({ wait: 30_000 });
    await expect($(sel.text("Run shop's setup in the copy on this Mac? (from .moonlet/config.toml)"))).toBeDisplayed();
    await $(`${modal}//button[normalize-space()="Run setup"]`).click();

    await expect(mark("In sync · ")).toBeExisting({ wait: 30_000 });
    const copy = theCopy();
    // Ignored, so it never syncs: here, only the copy's own setup made it.
    await browser.waitUntil(() => existsSync(join(copy.path, "ignored-by-setup")), { timeout: 10_000, timeoutMsg: "setup did not run in the copy" });
    expect(readFileSync(join(copy.path, "README.md"), "utf8")).toBe("shop\n");
  });

  it("brings a file written on the central host to the copy", async () => {
    writeFileSync(join(sessionPath, "notes.md"), "from the central host\n");
    const copy = theCopy();
    await browser.waitUntil(() => existsSync(join(copy.path, "notes.md")) && readFileSync(join(copy.path, "notes.md"), "utf8") === "from the central host\n", {
      timeout: 10_000,
      timeoutMsg: "notes.md never reached the copy",
    });
  });

  it("opens the popover's Open in menu over it", async () => {
    await mark("In sync · ").click();
    const popover = '//div[@role="dialog"][@aria-label="Keep in sync"]';
    await expect($(popover)).toBeDisplayed();
    await $(`${popover}//button[starts-with(normalize-space(), "Open in")]`).click();
    // The menu draws in a portal of its own; pressing in it is no press
    // outside the popover. Only a mousedown: picking an item would open the
    // copy in a real app on this Mac.
    await expect($('//div[@data-menu-panel]//button[normalize-space()="Terminal"]')).toBeDisplayed();
    await browser.execute(() => document.querySelector("[data-menu-panel]")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await expect($(popover)).toBeDisplayed();
    await expect($('//div[@data-menu-panel]')).toBeDisplayed();
    await browser.keys("Escape");
    await browser.keys("Escape");
    await expect($(popover)).not.toBeExisting();
  });

  it("shows a file both sides changed until this Mac's version is kept", async () => {
    const copy = theCopy();
    // Both edits land before either side hears of the other's: with the
    // central host's daemon frozen meanwhile, the agent's edit cannot reach
    // the copy first and simply be overwritten by this Mac's.
    const { pid } = await centralRpc<{ pid: number }>("daemon.info");
    process.kill(pid, "SIGSTOP");
    try {
      writeFileSync(join(sessionPath, "README.md"), "shop, as the agent wrote it\n");
      writeFileSync(join(copy.path, "README.md"), "shop, as I wrote it\n");
      await browser.pause(1000);
    } finally {
      process.kill(pid, "SIGCONT");
    }
    await expect(mark("1 file differs")).toBeExisting({ wait: 20_000 });

    await mark("1 file differs").click();
    const popover = '//div[@role="dialog"][@aria-label="Keep in sync"]';
    await expect($(`${popover}//*[normalize-space()="README.md"]`)).toBeDisplayed();
    await $(`${popover}//button[normalize-space()="Keep this Mac's"]`).click();
    await browser.waitUntil(() => readFileSync(join(sessionPath, "README.md"), "utf8") === "shop, as I wrote it\n", {
      timeout: 10_000,
      timeoutMsg: "this Mac's README.md never reached the central host",
    });
    await expect(mark("In sync · ")).toBeExisting({ wait: 10_000 });
    expect(readFileSync(join(copy.path, "README.md"), "utf8")).toBe("shop, as I wrote it\n");
  });

  it("stops keeping it in sync, removing the copy", async () => {
    const copy = theCopy();
    await rightClick(row);
    await $(sel.button("Keep in sync with this Mac")).click();
    await expect($(sel.text(`Stop keeping ${SESSION} in sync? The copy on this Mac is removed.`))).toBeDisplayed();
    await $(sel.confirmButton("Stop keeping in sync")).click();
    await expect($(sel.text(`Stopped keeping ${SESSION} in sync.`))).toBeDisplayed({ wait: 10_000 });
    await expect($(`${row}//button[starts-with(@aria-label, "Keep in sync")]`)).not.toBeExisting();
    expect(existsSync(copy.path)).toBe(false);
  });
});
