// The central host's own app lists the sessions other members run (X88).
// Here the app's daemon is the central host: a second scratch daemon, on
// ::1 and named MacBook, pairs with it as a member, with the code Settings ›
// Hosts › Let another Mac connect shows (only the app manages tailnet
// access and pairing). Its project is a clone of the app's,
// so both know it as the same project, and its session `Fix cart` is
// copied to the app's daemon (X72). The app lists it with the host icon,
// opens it without what the MacBook refuses through the central host,
// shows it read only while the MacBook is gone, and drops it once the
// MacBook archives it, so later specs see none.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { accountSnapshot, BIN_DIR, closeSettings, openSettings, restoreAccount, sel, socketRpc, world } from "../fixtures";

const w = world();
const home = join(w.root, "copies-book-home");
// A short path: a Unix socket's must stay under ~104 bytes.
const sock = join(w.root, "book.sock");
// It takes this Node for its app, as the daemon's own tests do, so the spec
// can manage its link as the MacBook's app would (X75).
const env = { ...w.env, MOONLET_HOME: home, MOONLET_SOCK: sock, MOONLET_MOBILE_ADDRS: "::1", MOONLET_TEST_APP_EXE: process.execPath };
const clone = join(w.root, "book", "repo");
const SESSION = "Fix cart";
const row = sel.sessionRow(SESSION);

/** One request to the MacBook's daemon over its socket. */
const bookRpc = <T>(method: string, params: object = {}) => socketRpc<T>(sock, env, method, params);
/** One as the MacBook's own app, which alone manages its link (X75). */
const bookApp = <T>(method: string, params: object = {}) => socketRpc<T>(sock, env, method, params, readFileSync(join(home, "run", "app-token"), "utf8").trim());

const allow = sel.settingsSwitch("Allow connections from my tailnet");

/** The pairing link Settings › Hosts shows for another Mac, with tailnet
 * access turned on first. Settings stays open: leaving it cancels the code. */
async function macPairingLink(): Promise<URL> {
  await openSettings("Hosts");
  if ((await $(allow).getAttribute("aria-checked")) !== "true") await $(allow).click();
  const letIn = sel.settingsButton("Let another Mac connect");
  await $(letIn).waitForEnabled({ timeout: 15_000 });
  await $(letIn).click();
  const code = $('//code[starts-with(@title, "moonlet://pair?")]');
  await code.waitForExist({ timeout: 10_000 });
  return new URL((await code.getAttribute("title"))!);
}

describe("the central host's copies of other members' sessions (X88)", () => {
  let session = "";
  // What the app's daemon shared while linked goes again (X68).
  let shared = { workspaces: [] as string[], sections: [] as string[] };

  before(async () => {
    shared = accountSnapshot(w);
    mkdirSync(join(w.root, "book"), { recursive: true });
    execFileSync("git", ["clone", "-q", w.repo, clone], { env: w.env, stdio: "pipe" });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "mobile.json"), '{ "enabled": true, "port": 0 }\n');
    execFileSync(join(BIN_DIR, "moonletd"), ["start"], { env, stdio: "pipe" });
    await bookApp("link.set", { worker: { name: "MacBook" } });
  });

  after(async () => {
    try {
      execFileSync(join(BIN_DIR, "moonlet"), ["rpc", "daemon.shutdown", "{}"], { env, stdio: "pipe" });
    } catch {
      // Already gone.
    }
    // Tailnet access is the daemon's setting, kept for the rest of the run: off again.
    if (await $(sel.settings).isExisting()) await closeSettings();
    await openSettings("Hosts");
    if ((await $(allow).getAttribute("aria-checked")) === "true") await $(allow).click();
    await closeSettings();
    restoreAccount(w, shared);
  });

  it("lists the MacBook's session with the host icon naming it", async () => {
    const link = await macPairingLink();
    await bookApp("link.pair", { central: { name: link.searchParams.get("host"), addrs: [link.searchParams.get("addr")] }, code: link.searchParams.get("code") });
    await closeSettings();
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
    await expect($(sel.button("Where it runs"))).not.toBeExisting();
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
