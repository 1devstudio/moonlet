// A host on the tailnet (X57): a second scratch daemon plays the remote host,
// listening on loopback instead of a Tailscale address. `moonletd pair`
// prints its link; the app pairs with it from Settings › Hosts, connects,
// offers it for new projects, and on Remove the host forgets this Mac.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { BIN_DIR, closeSettings, fill, openSettings, sel, world } from "../fixtures";

const w = world();
const home = join(w.root, "remote-home");
// A short path: a Unix socket's must stay under ~104 bytes.
const sock = join(w.root, "remote.sock");
const env = { ...w.env, MOONLET_HOME: home, MOONLET_SOCK: sock };
const dialog = '//div[@role="dialog"][@aria-label="Add host"]';

/** One request to the remote daemon over its socket, as any client may send it. */
function remoteRpc<T>(method: string, params: object = {}): Promise<T> {
  const { protocol } = JSON.parse(execFileSync(join(BIN_DIR, "moonletd"), ["status"], { env }).toString()) as { protocol: number };
  const frame = (msg: object) => {
    const json = Buffer.from(JSON.stringify(msg));
    const head = Buffer.alloc(5);
    head.writeUInt32BE(json.length + 1, 0);
    head.writeUInt8(1, 4);
    return Buffer.concat([head, json]);
  };
  return new Promise((resolve, reject) => {
    const s = connect(sock, () => s.write(Buffer.concat([frame({ t: "hello", protocol, client: "e2e" }), frame({ t: "request", id: 1, method, params })])));
    let buf = Buffer.alloc(0);
    s.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        const len = buf.readUInt32BE(0);
        const msg = buf[4] === 1 ? JSON.parse(buf.subarray(5, 4 + len).toString()) : null;
        buf = buf.subarray(4 + len);
        if (msg?.t === "response" && msg.id === 1) {
          s.destroy();
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result as T);
        }
      }
    });
    s.on("error", reject);
  });
}

/** Runs `moonletd pair` on the remote host; resolves with the link it prints. */
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

describe("tailnet host", () => {
  let pairing: ChildProcess | undefined;
  let name = "";

  before(() => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "mobile.json"), '{ "enabled": true, "port": 0 }\n');
    execFileSync(join(BIN_DIR, "moonletd"), ["start"], { env, stdio: "pipe" });
  });

  after(async () => {
    pairing?.kill();
    try {
      execFileSync(join(BIN_DIR, "moonlet"), ["rpc", "daemon.shutdown", "{}"], { env, stdio: "pipe" });
    } catch {
      // Already gone.
    }
    if (await $(sel.settings).isExisting()) await closeSettings();
  });

  it("pairs with a pasted link and connects", async () => {
    const started = startPairing();
    pairing = started.proc;
    const link = await started.link;
    name = new URL(link).searchParams.get("host")!;

    await openSettings("Hosts");
    await $(sel.settingsButton("Add host")).click();
    await expect($(dialog)).toBeDisplayed();
    await fill(`${dialog}//input`, link);
    await $(`${dialog}//button[normalize-space()="Add"]`).click();

    const row = `//*[@data-setting="host-${name}"]`;
    await $(`${row}//*[starts-with(normalize-space(), "Connected · moonletd ")]`).waitForExist({ timeout: 20000 });
    await expect($(`${row}//*[normalize-space()="Tailnet"]`)).toBeDisplayed();
    await expect($(`${row}//button[starts-with(normalize-space(), "Install helper")]`)).not.toBeExisting();
    await expect($(`${row}//button[starts-with(normalize-space(), "Reinstall helper")]`)).not.toBeExisting();
    await expect($(dialog)).not.toBeExisting();
    const devices = await remoteRpc<{ devices: { name: string; kind: string }[] }>("mobile.status");
    expect(devices.devices.map((d) => d.kind)).toEqual(["desktop"]);
  });

  it("offers it for new projects", async () => {
    await closeSettings();
    await browser.execute(() =>
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", metaKey: true, bubbles: true, cancelable: true })),
    );
    await fill('//div[@role="dialog"][@aria-label="Run action"]//input', "Add project");
    await browser.execute(() => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true })));
    const host = `//div[@role="dialog"]//label[span[normalize-space()="Host"]]//select/option[normalize-space()=${JSON.stringify(name)}]`;
    await expect($(host)).toBeExisting();
    await $('//div[@role="dialog"]//button[normalize-space()="Cancel"]').click();
  });

  it("refuses a second host with the same name", async () => {
    const again = startPairing();
    pairing = again.proc;
    const link = await again.link;
    await openSettings("Hosts");
    await $(sel.settingsButton("Add host")).click();
    await fill(`${dialog}//input`, link);
    await $(`${dialog}//button[normalize-space()="Add"]`).click();
    await expect($(`${dialog}//*[@role="alert"][normalize-space()=${JSON.stringify(`A host named ${name} already exists.`)}]`)).toBeDisplayed();
    await $(`${dialog}//button[normalize-space()="Cancel"]`).click();
    pairing.kill();
  });

  it("removes it, and the host forgets this Mac", async () => {
    await $(`button[title="Remove ${name}"]`).click();
    await expect($(`//*[@data-setting="host-${name}"]`)).not.toBeExisting();
    await browser.waitUntil(async () => (await remoteRpc<{ devices: unknown[] }>("mobile.status")).devices.length === 0, {
      timeout: 10000,
      timeoutMsg: "the host still lists this Mac",
    });
  });
});
