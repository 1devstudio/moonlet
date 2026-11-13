// A session follows the Mac you type from (X73). A second scratch daemon
// plays the central host, on ::1 as in keep-in-sync.e2e.ts, with a session
// `Fix cart` whose chat runs a fake `claude`. The app pairs with it, keeps
// the session in sync (making it the central host on the way), then types
// into it: the session moves to this Mac, the message runs here, and the
// sidebar lists it once all along, never twice.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, $$, browser, expect } from "@wdio/globals";
import { accountSnapshot, BIN_DIR, closeSettings, fill, openSettings, rpc, restoreAccount, sel, socketRpc, world } from "../fixtures";

const w = world();
const FAKE = join(w.root, "bin", "claude");
const home = join(w.root, "moves-central-home");
// A short path: a Unix socket's must stay under ~104 bytes.
const sock = join(w.root, "moves.sock");
// It takes this Node for its app, as central-copies.e2e.ts does, so the
// spec can start a pairing as the central host's app would (X75).
const env = { ...w.env, MOONLET_HOME: home, MOONLET_SOCK: sock, MOONLET_MOBILE_ADDRS: "::1", MOONLET_TEST_APP_EXE: process.execPath };
const original = join(w.root, "cart");
// Named `cart` on the central host too: a project is named after its folder.
const clone = join(w.root, "moves-central", "cart");
const SESSION = "Fix cart";
const ASKED = "Add a test for the empty cart";
const ANSWER = "Added the empty cart test.";
const dialog = '//div[@role="dialog"][@aria-label="Add host"]';
const editor = '//textarea[@placeholder="Ask for a change, @ to mention a file, / for commands"]';

/** Answers every message at once. printf, because /bin/sh's echo expands
 *  the \n in the JSON. */
const FAKE_CLAUDE = String.raw`#!/bin/sh
out() { printf '%s\n' "$1"; }
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) out '{"type":"system","subtype":"init","session_id":"0d6e2a4c-1b3f-4a5e-9c7d-8e1f2a3b4c5d","model":"e2e-model","slash_commands":[]}' ;;
    *'"type":"user"'*)
      out '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Added the empty cart test."}]}}'
      out '{"type":"result","subtype":"success","is_error":false,"usage":{}}' ;;
  esac
done
`;

/** One request to the central host's daemon over its socket. */
const centralRpc = <T>(method: string, params: object = {}) => socketRpc<T>(sock, env, method, params);
/** One as the central host's own app, which alone starts a pairing (X75). */
const centralApp = <T>(method: string, params: object = {}) => socketRpc<T>(sock, env, method, params, readFileSync(join(home, "run", "app-token"), "utf8").trim());

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: w.env, stdio: "pipe" });

/** Right-clicks a session row: the embedded driver has no right click. */
async function rightClick(xpath: string) {
  await browser.execute((xp: string) => {
    const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 }));
  }, xpath);
}

/** The rows the sidebar shows for `Fix cart`. */
const rows = () => $$(sel.sessionRow(SESSION));

describe("a session follows the Mac you type from (X73)", () => {
  let blocked = "";
  let name = "";
  let sessionId = "";
  // What the app's daemon shared while linked goes again (X68).
  let shared = { workspaces: [] as string[], sections: [] as string[] };
  const row = sel.sessionRow(SESSION);

  before(async () => {
    shared = accountSnapshot(w);
    blocked = readFileSync(FAKE, "utf8");
    writeFileSync(FAKE, FAKE_CLAUDE);
    chmodSync(FAKE, 0o755);
    // The project: on this Mac as `cart`, and cloned on the central host.
    mkdirSync(original, { recursive: true });
    writeFileSync(join(original, "README.md"), "cart\n");
    git(original, "init", "-q", "-b", "main");
    git(original, "add", "-A");
    git(original, "-c", "user.email=e2e@moonlet.test", "-c", "user.name=e2e", "commit", "-qm", "init");
    mkdirSync(join(w.root, "moves-central"), { recursive: true });
    git(w.root, "clone", "-q", original, clone);
    rpc(w, "project.add", { path: original });

    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "mobile.json"), '{ "enabled": true, "port": 0 }\n');
    execFileSync(join(BIN_DIR, "moonletd"), ["start"], { env, stdio: "pipe" });
    const project = await centralRpc<{ id: string }>("project.add", { path: clone });
    sessionId = (await centralRpc<{ id: string }>("session.create", { project_id: project.id, name: SESSION, agent: "claude" })).id;
  });

  after(async () => {
    try {
      rpc(w, "session.archive", { id: sessionId });
    } catch {
      // Not here.
    }
    // The app's daemon keeps link.json and its copies across specs: leave neither.
    await openSettings("Hosts");
    if (name && (await $(`button[title="Remove ${name}"]`).isExisting())) await $(`button[title="Remove ${name}"]`).click();
    await closeSettings();
    try {
      execFileSync(join(BIN_DIR, "moonlet"), ["rpc", "daemon.shutdown", "{}"], { env, stdio: "pipe" });
    } catch {
      // Already gone.
    }
    writeFileSync(FAKE, blocked);
    restoreAccount(w, shared);
  });

  it("lists the central host's session once, running there", async () => {
    const link = (await centralApp<{ url: string }>("mobile.pair_start", { kind: "desktop" })).url;
    name = new URL(link).searchParams.get("host")!;
    await openSettings("Hosts");
    await $(sel.settingsButton("Add host")).click();
    await fill(`${dialog}//input`, link);
    await $(`${dialog}//button[normalize-space()="Add"]`).click();
    await $(`//*[@data-setting="host-${name}"]//*[starts-with(normalize-space(), "Connected · moonletd ")]`).waitForExist({ timeout: 20000 });
    await closeSettings();
    await $('button[aria-label^="Switch workspace, current: "]').click();
    await $(`//div[@role="menu"][@aria-label="Workspaces"]/div[div[normalize-space()=${JSON.stringify(name)}]]//button`).click();
    await expect($(row)).toBeDisplayed({ wait: 10_000 });

    // A live copy here, which the session moves into: the host becomes
    // this Mac's central host on the way.
    await rightClick(row);
    await $(sel.button("Keep in sync with this Mac")).click();
    await $(sel.confirmButton("Make it the central host")).click();
    await expect($(`${row}//button[starts-with(@aria-label, "Keep in sync: In sync · ")]`)).toBeExisting({ wait: 30_000 });
    await expect(rows()).toBeElementsArrayOfSize(1);
  });

  it("moves the session here when you type into it, and the message runs here", async () => {
    await $(row).click();
    await browser.execute(() => {
      const tab = document.evaluate('//span[normalize-space()="claude"]', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      tab?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await fill(editor, ASKED);
    await browser.execute((xp: string) => {
      const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement;
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    }, editor);

    // Here now: this Mac's daemon runs it, the central host no longer does.
    await browser.waitUntil(() => rpc<{ id: string }[]>(w, "session.list", {}).some((s) => s.id === sessionId), {
      timeout: 60_000,
      timeoutMsg: "the session did not move to this Mac",
    });
    expect((await centralRpc<{ id: string }[]>("session.list", {})).some((s) => s.id === sessionId)).toBe(false);
    await expect($(sel.text(ANSWER))).toBeDisplayed({ wait: 30_000 });
    // One row, with no host icon: it runs on this Mac.
    await expect(rows()).toBeElementsArrayOfSize(1);
    await expect($(`${row}//span[starts-with(@aria-label, "Running on ")]`)).not.toBeExisting();
  });
});
