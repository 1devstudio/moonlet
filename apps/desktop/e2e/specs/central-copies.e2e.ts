// The central host's own app lists the sessions other members run (X86).
// Here the app's daemon is the central host: a second scratch daemon, on
// ::1 and named MacBook, pairs with it as a member, with a code from
// `moonletd pair` on the app's daemon. Its project is a clone of the app's,
// so both know it as the same project, and its session `Fix cart` is
// copied to the app's daemon (X72). The app lists it with the host icon,
// opens it without what the MacBook refuses through the central host,
// shows it read only while the MacBook is gone, and drops it once the
// MacBook archives it, so later specs see none.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { accountSnapshot, BIN_DIR, restoreAccount, rpc, sel, socketRpc, world } from "../fixtures";

const w = world();
const home = join(w.root, "copies-book-home");
// A short path: a Unix socket's must stay under ~104 bytes.
const sock = join(w.root, "book.sock");
const env = { ...w.env, MOONLET_HOME: home, MOONLET_SOCK: sock, MOONLET_MOBILE_ADDRS: "::1" };
const clone = join(w.root, "book", "repo");
const SESSION = "Fix cart";
const row = sel.sessionRow(SESSION);

/** One request to the MacBook's daemon over its socket. */
const bookRpc = <T>(method: string, params: object = {}) => socketRpc<T>(sock, env, method, params);

/** Runs `moonletd pair` on the app's daemon; resolves with the link it prints. */
function startPairing(): { proc: ChildProcess; link: Promise<string> } {
  const proc = spawn(join(BIN_DIR, "moonletd"), ["pair"], { env: w.env });
  const link = new Promise<string>((resolve, reject) => {
    let out = "";
    let err = "";
    proc.stdout!.on("data", (d) => {
      out += d.toString();
      const m = out.match(/^(moonlet:\/\/pair\?\S+)$/m);
      if (m) resolve(m[1]);
    });
    proc.stderr!.on("data", (d) => (err += d.toString()));
    proc.on("exit", (code) => reject(new Error(`moonletd pair exited ${code} before printing a link: ${out} ${err}`)));
  });
  return { proc, link };
}

describe("the central host's copies of other members' sessions (X86)", () => {
  let pairing: ChildProcess | undefined;
  let session = "";
  // What the app's daemon shared while linked goes again (X68).
  let shared = { workspaces: [] as string[], sections: [] as string[] };

  before(async () => {
    shared = accountSnapshot(w);
    rpc(w, "mobile.set_enabled", { enabled: true });
    mkdirSync(join(w.root, "book"), { recursive: true });
    execFileSync("git", ["clone", "-q", w.repo, clone], { env: w.env, stdio: "pipe" });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "mobile.json"), '{ "enabled": true, "port": 0 }\n');
    execFileSync(join(BIN_DIR, "moonletd"), ["start"], { env, stdio: "pipe" });
    await bookRpc("link.set", { worker: { name: "MacBook" } });
  });

  after(() => {
    pairing?.kill();
    try {
      execFileSync(join(BIN_DIR, "moonlet"), ["rpc", "daemon.shutdown", "{}"], { env, stdio: "pipe" });
    } catch {
      // Already gone.
    }
    rpc(w, "mobile.set_enabled", { enabled: false });
    restoreAccount(w, shared);
  });

  it("lists the MacBook's session with the host icon naming it", async () => {
    const started = startPairing();
    pairing = started.proc;
    const link = new URL(await started.link);
    await bookRpc("link.pair", { central: { name: link.searchParams.get("host"), addrs: [link.searchParams.get("addr")] }, code: link.searchParams.get("code") });
    const project = await bookRpc<{ id: string }>("project.add", { path: clone });
    session = (await bookRpc<{ id: string }>("session.create", { project_id: project.id, name: SESSION, agent: "none" })).id;

    await expect($(`${row}//span[@aria-label="Running on MacBook"]`)).toBeDisplayed({ wait: 30_000 });
  });

  it("opens it without Files, and offers only Open and Archive in its menu", async () => {
    await $(row).click();
    await expect($('//div[@role="tablist"]//*[normalize-space()="Changes"]')).toBeDisplayed({ wait: 10_000 });
    await expect($('//div[@role="tablist"]//*[normalize-space()="Files"]')).not.toBeExisting();

    // The embedded driver has no right click.
    await browser.execute((xp: string) => {
      const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 }));
    }, row);
    await expect($(sel.button("Archive"))).toBeDisplayed();
    await expect($(sel.button("Keep in sync with this Mac"))).not.toBeExisting();
    await expect($(sel.button("Run only on"))).not.toBeExisting();
    await browser.keys("Escape");
  });

  it("shows it read only while the MacBook is gone", async () => {
    execFileSync(join(BIN_DIR, "moonlet"), ["rpc", "daemon.shutdown", "{}"], { env, stdio: "pipe" });
    await expect($(`${row}//span[starts-with(@aria-label, "Running on MacBook · offline")]`)).toBeDisplayed({ wait: 30_000 });
    await expect($('//div[@role="status"][starts-with(normalize-space(), "MacBook is asleep. This is the copy on ")]')).toBeDisplayed({ wait: 10_000 });
    // Started again, it links again with what it kept.
    execFileSync(join(BIN_DIR, "moonletd"), ["start"], { env, stdio: "pipe" });
    await expect($(`${row}//span[@aria-label="Running on MacBook"]`)).toBeDisplayed({ wait: 30_000 });
  });

  it("drops it once the MacBook archives it", async () => {
    // The MacBook archives it, so later specs see no copy of it.
    await browser.waitUntil(
      async () => {
        try {
          await bookRpc("session.archive", { id: session });
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 30_000, timeoutMsg: "the MacBook did not archive its session" },
    );
    await $(row).waitForExist({ reverse: true, timeout: 30_000 });
  });
});
