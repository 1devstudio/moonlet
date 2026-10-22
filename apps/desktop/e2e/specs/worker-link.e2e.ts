// This Mac links to its central host as a worker (X41). A second scratch
// daemon plays the central host. It listens on ::1, because the app's own
// daemon counts 127.0.0.1 as one of its addresses and never links to itself.
// The app pairs with it, makes it the central host, turns on "Use this Mac for
// heavy commands", and the central host lists this Mac as a worker.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { BIN_DIR, closeSettings, fill, openSettings, rpc, sel, socketRpc, world } from "../fixtures";

const w = world();
const home = join(w.root, "central-home");
// A short path: a Unix socket's must stay under ~104 bytes.
const sock = join(w.root, "central.sock");
const env = { ...w.env, MOONLET_HOME: home, MOONLET_SOCK: sock, MOONLET_MOBILE_ADDRS: "::1" };
const dialog = '//div[@role="dialog"][@aria-label="Add host"]';
const heavy = '//*[@data-setting="heavy-commands"]';
/** The tag beside a host's name that says it is the central host. */
const centralTag = (row: string) => `${row}//span[normalize-space()="Central host"]`;

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

describe("worker link", () => {
  let pairing: ChildProcess | undefined;
  let name = "";
  const row = () => `//*[@data-setting="host-${name}"]`;

  before(() => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "mobile.json"), '{ "enabled": true, "port": 0 }\n');
    execFileSync(join(BIN_DIR, "moonletd"), ["start"], { env, stdio: "pipe" });
  });

  after(async () => {
    pairing?.kill();
    // The app's daemon keeps link.json across specs: leave it unlinked.
    if (name && (await $(`button[title="Remove ${name}"]`).isExisting())) await $(`button[title="Remove ${name}"]`).click();
    if ((await $(`${heavy}//button[@role="switch"]`).isExisting()) && (await $(`${heavy}//button[@role="switch"]`).getAttribute("aria-checked")) === "true") {
      await $(`${heavy}//button[@role="switch"]`).click();
    }
    try {
      execFileSync(join(BIN_DIR, "moonlet"), ["rpc", "daemon.shutdown", "{}"], { env, stdio: "pipe" });
    } catch {
      // Already gone.
    }
    if (await $(sel.settings).isExisting()) await closeSettings();
  });

  it("marks a paired tailnet host as the central host", async () => {
    const started = startPairing();
    pairing = started.proc;
    const link = await started.link;
    name = new URL(link).searchParams.get("host")!;

    await openSettings("Hosts");
    await expect($(`${heavy}//*[normalize-space()="Not linked"]`)).toBeDisplayed();
    await $(sel.settingsButton("Add host")).click();
    await fill(`${dialog}//input`, link);
    await $(`${dialog}//button[normalize-space()="Add"]`).click();
    await $(`${row()}//*[starts-with(normalize-space(), "Connected · moonletd ")]`).waitForExist({ timeout: 20000 });

    await expect($(centralTag(row()))).not.toBeExisting();
    await $(`${row()}//button[normalize-space()="Make central host"]`).click();
    await expect($(`${row()}//button[normalize-space()="Clear central host"]`)).toBeDisplayed();
    await expect($(centralTag(row()))).toBeDisplayed();
  });

  it("links this Mac when heavy commands are on, and the central host lists it", async () => {
    await $(`${heavy}//button[@role="switch"]`).click();
    await $(`${heavy}//*[starts-with(normalize-space(), "Linked to ${name} since ")]`).waitForExist({ timeout: 20000 });
    await browser.waitUntil(async () => (await centralRpc<unknown[]>("worker.list")).length === 1, {
      timeout: 10000,
      timeoutMsg: "the central host does not list this Mac",
    });
  });

  it("Clear central host clears it, and the link goes", async () => {
    await $(`${row()}//button[normalize-space()="Clear central host"]`).click();
    await expect($(`${row()}//button[normalize-space()="Make central host"]`)).toBeDisplayed();
    await expect($(centralTag(row()))).not.toBeExisting();
    await $(`${heavy}//*[normalize-space()="Not linked"]`).waitForExist({ timeout: 10000 });
    await browser.waitUntil(async () => (await centralRpc<unknown[]>("worker.list")).length === 0, {
      timeout: 10000,
      timeoutMsg: "the central host still lists this Mac",
    });
  });

  it("removing the central host from this Mac's list clears it", async () => {
    const centralName = () => rpc<{ central: { name: string } | null }>(w, "link.get", {}).central?.name ?? null;
    await $(`${row()}//button[normalize-space()="Make central host"]`).click();
    await browser.waitUntil(async () => centralName() === name, { timeout: 10000, timeoutMsg: "the host never became central" });
    await $(`button[title="Remove ${name}"]`).click();
    if (await $(sel.confirmButton("Remove")).isExisting()) await $(sel.confirmButton("Remove")).click();
    await $(row()).waitForExist({ reverse: true, timeout: 10000 });
    await browser.waitUntil(async () => centralName() === null, { timeout: 10000, timeoutMsg: "the removed host is still the central host" });
  });
});
