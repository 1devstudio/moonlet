// Design systems on every member (X71). A second scratch daemon plays the
// central host, on ::1 as in worker-link.e2e.ts. The app pairs with it and
// makes it the central host, so the two share one account. A design system
// the central host makes shows here as a read-only copy "from" it, and Move
// here makes this Mac its owner, with Sync back.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import {
  accountSnapshot,
  BIN_DIR,
  closeSettings,
  fill,
  openSettings,
  rpc,
  restoreAccount,
  sel,
  socketRpc,
  world,
} from "../fixtures";

const w = world();
const home = join(w.root, "copies-central-home");
// A short path: a Unix socket's must stay under ~104 bytes.
const sock = join(w.root, "copies.sock");
const env = {
  ...w.env,
  MOONLET_HOME: home,
  MOONLET_SOCK: sock,
  MOONLET_MOBILE_ADDRS: "::1",
};
const dialog = '//div[@role="dialog"][@aria-label="Add host"]';
const workspaceId = () => rpc<{ id: string }[]>(w, "workspace.list", {})[0].id;
const mode = (label: string) =>
  $(
    `//div[@role="group"][@aria-label="Mode"]/button[starts-with(@aria-label, "${label}")]`,
  );
const row =
  '//nav[@aria-label="Design systems"]//button[.//span[starts-with(normalize-space(), "Acme web")]]';
const centralRpc = <T>(method: string, params: object = {}) =>
  socketRpc<T>(sock, env, method, params);

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
    proc.on("exit", (code) =>
      reject(
        new Error(
          `moonletd pair exited ${code} before printing a link: ${out}`,
        ),
      ),
    );
  });
  return { proc, link };
}

describe("Design copies", () => {
  let pairing: ChildProcess | undefined;
  let name = "";
  let shared = { workspaces: [] as string[], sections: [] as string[] };

  before(() => {
    shared = accountSnapshot(w);
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "mobile.json"),
      '{ "enabled": true, "port": 0 }\n',
    );
    execFileSync(join(BIN_DIR, "moonletd"), ["start"], { env, stdio: "pipe" });
  });

  after(async () => {
    pairing?.kill();
    try {
      rpc(w, "design.system.remove", {
        workspace: workspaceId(),
        slug: "acme-web",
      });
    } catch {
      // Still a copy, or gone.
    }
    if (await mode("Sessions").isExisting()) await mode("Sessions").click();
    await openSettings("Hosts");
    if (name && (await $(`button[title="Remove ${name}"]`).isExisting())) {
      await $(`button[title="Remove ${name}"]`).click();
      if (await $(sel.confirmButton("Remove")).isExisting())
        await $(sel.confirmButton("Remove")).click();
    }
    if (await $(sel.settings).isExisting()) await closeSettings();
    try {
      execFileSync(join(BIN_DIR, "moonlet"), ["rpc", "daemon.shutdown", "{}"], {
        env,
        stdio: "pipe",
      });
    } catch {
      // Already gone.
    }
    restoreAccount(w, shared);
  });

  it("shows a design system made on the central host as a read-only copy from it", async () => {
    const started = startPairing();
    pairing = started.proc;
    const link = await started.link;
    name = new URL(link).searchParams.get("host")!;
    await openSettings("Hosts");
    await $(sel.settingsButton("Add host")).click();
    await fill(`${dialog}//input`, link);
    await $(`${dialog}//button[normalize-space()="Add"]`).click();
    const host = `//*[@data-setting="host-${name}"]`;
    await $(
      `${host}//*[starts-with(normalize-space(), "Connected · moonletd ")]`,
    ).waitForExist({ timeout: 20000 });
    await $(`${host}//button[normalize-space()="Make central host"]`).click();
    await closeSettings();

    // The central host knows this Mac's workspace once the account synced.
    const ws = workspaceId();
    await browser.waitUntil(
      async () =>
        (await centralRpc<{ id: string }[]>("workspace.list")).some(
          (x) => x.id === ws,
        ),
      {
        timeout: 20000,
        timeoutMsg: "the central host never got this Mac's workspace",
      },
    );
    await centralRpc("design.system.create", {
      workspace: ws,
      name: "Acme web",
      sources: [],
      cover: "none",
      agent: false,
    });
    writeFileSync(
      join(home, "design", ws, "systems", "acme-web", "styles.css"),
      ":root { --brand: #0a66ff; }\n",
    );

    await mode("Design").click();
    await $(
      `${row}//span[starts-with(normalize-space(), "from ")]`,
    ).waitForExist({ timeout: 20000 });
    await $(row).click();
    await expect(
      $(
        '//div[@role="status"][@aria-label="Copy"]//span[starts-with(normalize-space(), "A copy from ")]',
      ),
    ).toBeDisplayed();
    await expect(
      $('//header//button[normalize-space()="Sync"]'),
    ).not.toBeExisting();
  });

  it("Move here makes this Mac the owner, and Sync comes back", async () => {
    await $(
      '//div[@role="status"][@aria-label="Copy"]//button[normalize-space()="Move here"]',
    ).click();
    await $(sel.confirmButton("Move here")).click();
    await $('//header//button[normalize-space()="Sync"]').waitForExist({
      timeout: 15000,
    });
    await expect(
      $('//div[@role="status"][@aria-label="Copy"]'),
    ).not.toBeExisting();
    await expect(
      $(`${row}//span[starts-with(normalize-space(), "from ")]`),
    ).not.toBeExisting();
  });
});
