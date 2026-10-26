// A remote host links to this Mac's central host as a worker (X61). Two
// scratch daemons play the central host, on ::1, and the remote host, on
// 127.0.0.1: each counts its own address as its own and never takes the
// other's for itself. The app pairs with both, marks the first Central host
// and turns on "Use for heavy commands" on the second, which then pairs with
// the central host using a code from `moonletd pair` there.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { accountSnapshot, BIN_DIR, closeSettings, fill, openSettings, restoreAccount, sel, socketRpc, world } from "../fixtures";

const w = world();
const dialog = (label: string) => `//div[@role="dialog"][@aria-label="${label}"]`;

/** A scratch daemon with tailnet access on, listening on `addr` only. */
function daemon(dir: string, addr: string) {
  const home = join(w.root, `${dir}-home`);
  // A short path: a Unix socket's must stay under ~104 bytes.
  const sock = join(w.root, `${dir}.sock`);
  const env = { ...w.env, MOONLET_HOME: home, MOONLET_SOCK: sock, MOONLET_MOBILE_ADDRS: addr };
  return {
    env,
    start() {
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "mobile.json"), '{ "enabled": true, "port": 0 }\n');
      execFileSync(join(BIN_DIR, "moonletd"), ["start"], { env, stdio: "pipe" });
    },
    stop() {
      try {
        execFileSync(join(BIN_DIR, "moonlet"), ["rpc", "daemon.shutdown", "{}"], { env, stdio: "pipe" });
      } catch {
        // Already gone.
      }
    },
    rpc: <T>(method: string, params: object = {}) => socketRpc<T>(sock, env, method, params),
  };
}

const central = daemon("central", "::1");
const remote = daemon("remote", "127.0.0.1");

/** Runs `moonletd pair` on `d`; resolves with the link it prints. */
function startPairing(d: ReturnType<typeof daemon>): { proc: ChildProcess; link: Promise<string> } {
  const proc = spawn(join(BIN_DIR, "moonletd"), ["pair"], { env: d.env });
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

/** Adds the host behind a fresh pairing link on `d` as `name`: both
 * daemons run on this machine, so their own labels are the same. */
async function addHost(d: ReturnType<typeof daemon>, name: string) {
  const started = startPairing(d);
  pairings.push(started.proc);
  const link = new URL(await started.link);
  link.searchParams.set("host", name);
  await $(sel.settingsButton("Add host")).click();
  await fill(`${dialog("Add host")}//input`, link.toString());
  await $(`${dialog("Add host")}//button[normalize-space()="Add"]`).click();
  await $(`//*[@data-setting="host-${name}"]//*[starts-with(normalize-space(), "Connected · moonletd ")]`).waitForExist({ timeout: 20000 });
}

const pairings: ChildProcess[] = [];
const heavy = '//*[@data-setting="heavy-commands-build-box"]';
const heavySwitch = `${heavy}//button[@role="switch"]`;

describe("remote worker", () => {
  // What the app's daemon shared while linked goes again (X68).
  let shared = { workspaces: [] as string[], sections: [] as string[] };
  before(() => {
    shared = accountSnapshot(w);
    central.start();
    remote.start();
  });

  after(async () => {
    for (const p of pairings) p.kill();
    // Removing the central host also clears it as this Mac's.
    for (const name of ["build-box", "studio-mini"]) {
      if (await $(`button[title="Remove ${name}"]`).isExisting()) {
        await $(`button[title="Remove ${name}"]`).click();
        if (await $(sel.confirmButton("Remove")).isExisting()) await $(sel.confirmButton("Remove")).click();
        await $(`//*[@data-setting="host-${name}"]`).waitForExist({ reverse: true, timeout: 10000 });
      }
    }
    central.stop();
    remote.stop();
    if (await $(sel.settings).isExisting()) await closeSettings();
    restoreAccount(w, shared);
  });

  it("offers the switch on a connected tailnet host, not on the central host", async () => {
    await openSettings("Hosts");
    await addHost(central, "studio-mini");
    await addHost(remote, "build-box");
    await expect($(`${heavy}//*[normalize-space()="Choose a central host first"]`)).toBeDisplayed();
    await expect($(heavySwitch)).toBeDisabled();

    await $(`//*[@data-setting="host-studio-mini"]//button[normalize-space()="Make central host"]`).click();
    await $(`${heavy}//*[normalize-space()="Not linked"]`).waitForExist({ timeout: 10000 });
    await expect($('//*[@data-setting="heavy-commands-studio-mini"]')).not.toExist();
  });

  it("pairs the remote host with the central host with a code, and links it", async () => {
    await $(heavySwitch).click();
    const code = dialog("Pair build-box with studio-mini");
    await $(code).waitForExist({ timeout: 5000 });
    // A code the central host never gave: the dialog says so and stays.
    await fill(`${code}//input`, "7KQ2M-X9PDA");
    await $(`${code}//button[normalize-space()="Pair"]`).click();
    await expect($(`${code}//*[@role="alert"]`)).toHaveText("The code was not accepted. Start pairing again on studio-mini.", { wait: 20000 });
    await expect($(heavySwitch)).toHaveAttribute("aria-checked", "false");

    const started = startPairing(central);
    pairings.push(started.proc);
    await fill(`${code}//input`, new URL(await started.link).searchParams.get("code")!);
    await $(`${code}//button[normalize-space()="Pair"]`).click();
    await $(code).waitForExist({ reverse: true, timeout: 20000 });

    await $(`${heavy}//*[starts-with(normalize-space(), "Linked to studio-mini since ")]`).waitForExist({ timeout: 20000 });
    await expect($(heavySwitch)).toHaveAttribute("aria-checked", "true");
    // This Mac is linked too, as a member of the account without heavy
    // commands (X68): the remote host is the one worker taking them.
    await browser.waitUntil(async () => (await central.rpc<{ heavy: boolean }[]>("worker.list")).filter((x) => x.heavy).length === 1, {
      timeout: 10000,
      timeoutMsg: "the central host does not list the remote host for heavy commands",
    });
  });

  it("turns off, and on again without a code", async () => {
    // Off, it stays linked as a member of the account (X68), and takes no
    // heavy commands.
    await $(heavySwitch).click();
    await expect($(heavySwitch)).toHaveAttribute("aria-checked", "false", { wait: 10000 });
    await expect($(`${heavy}//*[starts-with(normalize-space(), "Linked to studio-mini since ")]`)).toExist();
    await browser.waitUntil(async () => (await central.rpc<{ heavy: boolean }[]>("worker.list")).every((x) => !x.heavy), {
      timeout: 10000,
      timeoutMsg: "the central host still sends the remote host heavy commands",
    });

    await $(heavySwitch).click();
    await expect($(heavySwitch)).toHaveAttribute("aria-checked", "true", { wait: 10000 });
    await expect($(dialog("Pair build-box with studio-mini"))).not.toExist();
    await browser.waitUntil(async () => (await central.rpc<{ heavy: boolean }[]>("worker.list")).filter((x) => x.heavy).length === 1, {
      timeout: 10000,
      timeoutMsg: "the central host does not list the remote host for heavy commands again",
    });
  });
});
