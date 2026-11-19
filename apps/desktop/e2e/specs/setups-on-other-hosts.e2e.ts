// Setups on other members (X60). A scratch daemon plays the central host,
// on ::1 as in session-moves.e2e.ts. Its account holds what a member with
// no app, `studio-mini`, reports of its routing copies' setups: one waiting
// for approval and one that failed. The app pairs with the host, makes it
// its central host, and answers both from this Mac.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { accountSnapshot, BIN_DIR, closeSettings, fill, openSettings, restoreAccount, rpc, sel, socketRpc, world } from "../fixtures";

const w = world();
const home = join(w.root, "setups-central-home");
// A short path: a Unix socket's must stay under ~104 bytes.
const sock = join(w.root, "setups.sock");
// It takes this Node for its app, so the spec can start a pairing as the
// central host's app would (X75).
const env = { ...w.env, MOONLET_HOME: home, MOONLET_SOCK: sock, MOONLET_MOBILE_ADDRS: "::1", MOONLET_TEST_APP_EXE: process.execPath };
const CENTRAL = "5a1c0e2b-7d3f-4e61-9a0f-2c4d6e8b1f37";
const MINI = "0f6c2a9e-9d2b-4f5e-8f1a-2b3c4d5e6f70";
const identity = { origin: "github.com/acme/shop", root: "4171b03ff0d2bd434751f17bc9d34da784f97e72" };
const WAITING = "pnpm install --frozen-lockfile";
const FAILED = "pnpm i";
const dialog = '//div[@role="dialog"][@aria-label="Add host"]';

const centralApp = <T>(method: string, params: object = {}) => socketRpc<T>(sock, env, method, params, readFileSync(join(home, "run", "app-token"), "utf8").trim());

/** studio-mini's setup records, as its daemon writes them into the account. */
function studioMiniReports() {
  const log = `${MINI}.bbbbbb`;
  let seq = 0;
  const at = Date.now();
  const set = (kind: string, id: string, field: string, value: unknown) => ({ stamp: { ms: at, n: seq, member: log }, seq: ++seq, kind, id, op: { set: { field, value } } });
  const setup = (command: string, fields: Record<string, unknown>) =>
    Object.entries({ project: "shop", identity, command, ...fields }).map(([f, v]) => set("setup", `${MINI}|${identity.origin}|${identity.root}|${command}`, f, v));
  return [
    set("member", log, "name", "studio-mini"),
    ...setup(WAITING, { state: "waiting" }),
    ...setup(FAILED, { state: "failed", exit: 3, line: "ERR_PNPM_FETCH_404 left-pad" }),
  ];
}

interface Listed {
  copy: string;
  command: string;
  on?: string;
  approved?: boolean;
}

describe("setups waiting on another member (X60)", () => {
  let name = "";
  let shared = { workspaces: [] as string[], sections: [] as string[] };

  before(() => {
    shared = accountSnapshot(w);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "mobile.json"), '{ "enabled": true, "port": 0 }\n');
    writeFileSync(join(home, "link.json"), JSON.stringify({ central: null, worker: { id: CENTRAL, name: "central", enabled: false } }));
    writeFileSync(join(home, "account.json"), JSON.stringify({ member: `${CENTRAL}.aaaaaa`, changes: studioMiniReports() }));
    execFileSync(join(BIN_DIR, "moonletd"), ["start"], { env, stdio: "pipe" });
  });

  after(async () => {
    // The app's daemon keeps link.json across specs: leave none.
    await openSettings("Hosts");
    if (name && (await $(`button[title="Remove ${name}"]`).isExisting())) await $(`button[title="Remove ${name}"]`).click();
    await closeSettings();
    try {
      execFileSync(join(BIN_DIR, "moonlet"), ["rpc", "daemon.shutdown", "{}"], { env, stdio: "pipe" });
    } catch {
      // Already gone.
    }
    restoreAccount(w, shared);
  });

  it("asks on this Mac about the setups of a host with no app, and approves one for the account", async () => {
    const link = (await centralApp<{ url: string }>("mobile.pair_start", { kind: "desktop" })).url;
    name = new URL(link).searchParams.get("host")!;
    await openSettings("Hosts");
    await $(sel.settingsButton("Add host")).click();
    await fill(`${dialog}//input`, link);
    await $(`${dialog}//button[normalize-space()="Add"]`).click();
    await $(`//*[@data-setting="host-${name}"]//*[starts-with(normalize-space(), "Connected · moonletd ")]`).waitForExist({ timeout: 20000 });
    await $(`button[title="Make ${name} this Mac's central host"]`).click();
    await closeSettings();

    // The failed one: Not now leaves it as it is.
    const failed = sel.confirm("Setup failed");
    await expect($(`${failed}//pre[normalize-space()=${JSON.stringify(FAILED)}]`)).toBeDisplayed({ wait: 30_000 });
    await expect($(sel.text("shop's setup failed in the copy on studio-mini (exit 3): ERR_PNPM_FETCH_404 left-pad. Heavy commands do not run there until it does."))).toBeDisplayed();
    await $(`${failed}//button[normalize-space()="Not now"]`).click();

    // The waiting one, named after its host, with the exact command.
    const modal = sel.confirm("Run setup");
    await expect($(`${modal}//pre[normalize-space()=${JSON.stringify(WAITING)}]`)).toBeDisplayed({ wait: 10_000 });
    await expect($(sel.text("Run shop's setup in the copy on studio-mini? (from .moonlet/config.toml)"))).toBeDisplayed();
    await $(`${modal}//button[normalize-space()="Run setup"]`).click();
    await expect($(modal)).not.toBeExisting({ wait: 5000 });

    // The central host made the approval its own, and it is back here:
    // studio-mini runs it once it hears, and no app asks again.
    await browser.waitUntil(() => rpc<Listed[]>(w, "exec.setups", { all: true }).some((s) => s.on === "studio-mini" && s.command === WAITING && s.approved === true), {
      timeout: 20_000,
      timeoutMsg: "the approval did not come back from the central host",
    });
    await expect($(modal)).not.toBeExisting();
  });
});
