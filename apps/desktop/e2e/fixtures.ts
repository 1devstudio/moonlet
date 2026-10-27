// Scratch world for the e2e tests (X12): a MOONLET_HOME, a git repo, a daemon
// that can never start a real agent, and helpers the specs share.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { $, browser, expect } from "@wdio/globals";
import type { ChainablePromiseElement } from "webdriverio";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const BIN_DIR = join(here, "..", "..", "..", "target", "e2e", "debug");
export const APP = join(BIN_DIR, "moonlet-app");

export const PROJECT = "e2e-repo";
export const SESSION = "Fix checkout button";

/** The config the specs start from: comments to keep, no run command. */
export const CONFIG = `# storefront scripts

setup = "echo setting-up"   # install deps

[agents]
# fake agent for testing
fake = "sh -c 'echo fake-agent-ready; sleep 600'"
`;

export interface World {
  root: string;
  home: string;
  repo: string;
  /** Environment for moonletd, moonlet and the app. */
  env: Record<string, string>;
}

/** The mock tracker server's port for this world: fixed per scratch root, so the app and the specs agree. */
export function trackerPort(root: string): number {
  let h = 0;
  for (const c of root) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 40_000 + (h % 20_000);
}

/** The world created by the launcher, shared with workers through env. */
export function world(): World {
  const root = process.env.MOONLET_E2E_ROOT;
  if (!root) throw new Error("MOONLET_E2E_ROOT is not set; run the specs through wdio.conf.ts");
  return makeWorld(root);
}

function makeWorld(root: string): World {
  const home = join(root, "moonlet-home");
  const fakeBin = join(root, "bin");
  return {
    root,
    home,
    repo: join(root, PROJECT),
    env: {
      // A clean environment: no user rc files, no real agent on PATH.
      HOME: join(root, "home"),
      USER: process.env.USER ?? "",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      LANG: "en_US.UTF-8",
      // zsh, as on a stock Mac, so shells get the integration (T3, T8).
      SHELL: "/bin/zsh",
      PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      MOONLET_HOME: home,
      MOONLET_BIN_DIR: BIN_DIR,
      MOONLET_E2E_ROOT: root,
      // Phones (X39) reach the scratch daemon on loopback, not Tailscale.
      MOONLET_MOBILE_ADDRS: "127.0.0.1",
      // Remotes are local folders; an origin that names github.com (X44) never reaches the network.
      GIT_ALLOW_PROTOCOL: "file",
      // Linear, Jira and ClickUp go to a mock server the specs start (X44; e2e builds only).
      MOONLET_TRACKER_BASE: `http://127.0.0.1:${trackerPort(root)}`,
      // Cloud machines (X63) are scratch daemons made by the fake provider, steered by files there.
      MOONLET_CLOUD_FAKE: join(root, "cloud-fake"),
    },
  };
}

/** Creates the scratch dirs, the repo and a running daemon with a project
 *  and one session. */
export function setUp(): World {
  const w = makeWorld(mkdtempSync(join(tmpdir(), "moonlet-e2e-")));
  try {
    seed(w);
  } catch (e) {
    // A half-built world (a daemon running, a temp dir) is not left behind.
    tearDown(w);
    throw e;
  }
  return w;
}

function seed(w: World) {
  mkdirSync(w.home, { recursive: true });
  mkdirSync(w.env.HOME, { recursive: true });
  // If anything ever resolves a real agent, it gets this instead.
  const fakeBin = join(w.root, "bin");
  mkdirSync(fakeBin);
  for (const name of ["claude", "codex"]) {
    const p = join(fakeBin, name);
    writeFileSync(p, `#!/bin/sh\necho "e2e: real ${name} is blocked" >&2\nexit 1\n`);
    chmodSync(p, 0o755);
  }
  // moonletd gives terminals and agents the PATH of a login shell (SHELL is
  // zsh here), not its own, so the fakes must come first there too. Each
  // zsh startup file sets it again: /etc/zprofile's path_helper reorders
  // PATH after .zshenv.
  const fakeFirst = `PATH="${fakeBin}:$PATH"; export PATH\n`;
  for (const rc of [".profile", ".zshenv", ".zprofile", ".zshrc"]) writeFileSync(join(w.env.HOME, rc), fakeFirst);
  mkdirSync(join(w.repo, ".moonlet"), { recursive: true });
  writeFileSync(join(w.repo, ".moonlet", "config.toml"), CONFIG);
  writeFileSync(join(w.repo, "README.md"), "e2e\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: w.repo, env: w.env, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.email=e2e@moonlet.test", "-c", "user.name=e2e", "commit", "-qm", "init");

  // Any free port, so a run never collides with another daemon's (X39).
  writeFileSync(join(w.home, "mobile.json"), '{ "port": 0 }\n');
  execFileSync(join(BIN_DIR, "moonletd"), ["start"], { env: w.env, stdio: "pipe" });
  const project = rpc<{ id: string }>(w, "project.add", { path: w.repo });
  rpc(w, "session.create", { project_id: project.id, name: SESSION, agent: "none" });
}

export function tearDown(w: World) {
  try {
    rpc(w, "daemon.shutdown", {});
  } catch {
    // Already gone.
  }
  rmSync(w.root, { recursive: true, force: true });
}

export function rpc<T = unknown>(w: World, method: string, params: object): T {
  const out = execFileSync(join(BIN_DIR, "moonlet"), ["rpc", method, JSON.stringify(params)], { env: w.env, stdio: "pipe" });
  return JSON.parse(out.toString() || "null") as T;
}

/** The workspaces and sections on the app's daemon. A spec that links it
 * with another daemon takes one first, as the members of an account share
 * their workspaces (X68) and the daemon keeps them across specs. */
export function accountSnapshot(w: World): { workspaces: string[]; sections: string[] } {
  const ids = (method: string) => rpc<{ id: string }[]>(w, method, {}).map((x) => x.id);
  return { workspaces: ids("workspace.list"), sections: ids("section.list") };
}

/** Removes the workspaces and sections the app's daemon got since `before`,
 * once it is no longer linked, so the next spec sees only its own. */
export function restoreAccount(w: World, before: { workspaces: string[]; sections: string[] }) {
  // One that cannot go (a section with live sessions, say) stays, and the
  // rest still go: a cleanup never fails the spec it follows.
  const tryRpc = (method: string, id: string) => {
    try {
      rpc(w, method, { id });
    } catch (e) {
      console.warn(`restoreAccount: ${method} ${id}: ${e}`);
    }
  };
  for (const s of rpc<{ id: string }[]>(w, "section.list", {})) if (!before.sections.includes(s.id)) tryRpc("section.delete", s.id);
  for (const ws of rpc<{ id: string }[]>(w, "workspace.list", {})) if (!before.workspaces.includes(ws.id)) tryRpc("workspace.delete", ws.id);
}

/** One JSON frame of the daemon's protocol: `[u32 len][u8 kind 1][json]`. */
export function jsonFrame(msg: object): Buffer {
  const json = Buffer.from(JSON.stringify(msg));
  const head = Buffer.alloc(5);
  head.writeUInt32BE(json.length + 1, 0);
  head.writeUInt8(1, 4);
  return Buffer.concat([head, json]);
}

/** One request to a second scratch daemon over its socket `sock`, as any
 *  client may send it. `env` points `moonletd status` at that daemon. */
export function socketRpc<T>(sock: string, env: NodeJS.ProcessEnv, method: string, params: object = {}): Promise<T> {
  const { protocol } = JSON.parse(execFileSync(join(BIN_DIR, "moonletd"), ["status"], { env }).toString()) as { protocol: number };
  return new Promise((resolve, reject) => {
    const s = connect(sock, () => s.write(Buffer.concat([jsonFrame({ t: "hello", protocol, client: "e2e" }), jsonFrame({ t: "request", id: 1, method, params })])));
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

/** The scratch daemon's socket, where moonlet places it (`paths::default_socket_path`). */
export function daemonSock(w: World): string {
  const path = join(w.home, "run", "moonletd.sock");
  if (path.length < 100) return path;
  // A long home falls back to a short per-user directory, by an FNV-1a hash of the home.
  let hash = 0xcbf29ce484222325n;
  for (const b of Buffer.from(w.home)) hash = BigInt.asUintN(64, (hash ^ BigInt(b)) * 0x100000001b3n);
  return `/tmp/moonlet-${process.getuid!()}-${(hash & 0xffffffffn).toString(16).padStart(8, "0")}/moonletd.sock`;
}

export const projectId = (w: World) => rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!.id;

/** Puts `text` on disk and, when it parses, tells the app through a no-op
 *  save (which emits `projects.changed`), so the Run button refetches. The
 *  specs avoid reloading the window: after a second reload the embedded
 *  driver's typing no longer reaches React. */
export function resetConfig(w: World, text: string) {
  writeConfig(w, text);
  const id = projectId(w);
  const file = rpc<{ version: string; config: object; error?: string | null }>(w, "project.config_file", { id });
  if (file.error) return;
  try {
    rpc(w, "project.set_config", { id, version: file.version, config: file.config });
  } catch {
    // A config the daemon rejects (a test of validation) is left as written.
  }
}

export const configPath = (w: World) => join(w.repo, ".moonlet", "config.toml");

/** Types into the input that matches `xpath` once it is usable. The
 *  embedded driver's `isEnabled` and `setValue` ignore a disabled
 *  `<fieldset>` around an input, so text typed while a form is still
 *  loading would be replaced when it finishes. `:disabled` does account for
 *  the fieldset. Typing works like the driver's: the native value setter
 *  plus an `input` event, which React listens for. */
export async function fill(xpath: string, text: string) {
  await browser.waitUntil(
    () =>
      browser.execute(
        (xp: string, value: string) => {
          const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLInputElement | HTMLTextAreaElement | null;
          if (!el || el.matches(":disabled")) return false;
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          el.focus();
          Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
          return true;
        },
        xpath,
        text,
      ),
    { timeoutMsg: `no enabled input for ${xpath}` },
  );
}
/** Picks `value` in the `<select>` that matches `xpath`, the way `fill`
 *  types: the native value setter plus a `change` event for React. */
export async function choose(xpath: string, value: string) {
  await browser.waitUntil(
    () =>
      browser.execute(
        (xp: string, v: string) => {
          const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLSelectElement | null;
          if (!el || el.matches(":disabled")) return false;
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, v);
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        },
        xpath,
        value,
      ),
    { timeoutMsg: `no enabled select for ${xpath}` },
  );
}
/** Moves the pointer onto `el`. The embedded driver's `moveTo` raises no
 *  mouse events, so this dispatches the `mouseover` React builds
 *  `onMouseEnter` from. */
export async function hover(el: ChainablePromiseElement) {
  const target = await el.getElement();
  await browser.execute((e) => {
    e.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
  }, target);
}
export const readConfig = (w: World) => readFileSync(configPath(w), "utf8");
export const writeConfig = (w: World, text: string) => writeFileSync(configPath(w), text);

// ---------------------------------------------------------------- selectors

/** An XPath string literal for any text (handles both quote kinds). */
const lit = (s: string) => (!s.includes('"') ? `"${s}"` : !s.includes("'") ? `'${s}'` : `concat("${s.replace(/"/g, `", '"', "`)}")`);

export const sel = {
  /** A button by its visible text (ignoring nested hints such as ⌘↵). */
  button: (text: string) => `//button[starts-with(normalize-space(), ${lit(text)})]`,
  text: (text: string) => `//*[normalize-space()=${lit(text)}]`,
  /** The confirm modal (X23), by its title. */
  confirm: (title: string) => `//div[@role="dialog"][@aria-modal="true"][@aria-label=${lit(title)}]`,
  /** A button in the open confirm modal, by its visible text. */
  confirmButton: (text: string) => `//div[@role="dialog"][@aria-modal="true"]//button[normalize-space()=${lit(text)}]`,
  sessionRow: (name: string) => `//div[@role="button"][.//span[normalize-space()=${lit(name)}]]`,
  /** The settings page (X43). */
  settings: '[role="region"][aria-label="Settings"]',
  /** An entry of the settings nav, by its label; `current` only while its page is open. */
  navEntry: (label: string, current = false) => `//nav[@aria-label="Settings"]//button${current ? '[@aria-current="page"]' : ""}[span[normalize-space()=${lit(label)}]]`,
  /** A field on the settings page, by the text of its <label for>. */
  settingsField: (label: string) => `//*[@aria-label="Settings"]//*[@id=//label[normalize-space()=${lit(label)}]/@for]`,
  /** A button on the settings page, by its visible text (ignoring hints such as ⌘↵). */
  settingsButton: (text: string) => `//*[@aria-label="Settings"]//button[starts-with(normalize-space(), ${lit(text)})]`,
  /** A switch on the settings page, by the text of the row that labels it. */
  settingsSwitch: (label: string) => `//*[@aria-label="Settings"]//button[@role="switch"][@aria-labelledby=//*[normalize-space()=${lit(label)}]/@id]`,
  /** An option of a radio group (segmented control or list) on the settings page. */
  settingsOption: (group: string, option: string) =>
    `//*[@aria-label="Settings"]//*[@role="radiogroup"][@aria-labelledby=//*[normalize-space()=${lit(group)}]/@id]//button[@role="radio"][starts-with(normalize-space(), ${lit(option)})]`,
};

/** Opens the settings page (X43) from the sidebar's gear, at `page` in its nav. */
export async function openSettings(page: string) {
  await $('button[title="Settings (⌘,)"]').click();
  await expect($(sel.settings)).toBeDisplayed();
  await $(sel.navEntry(page)).click();
  await expect($(sel.navEntry(page, true))).toBeExisting();
}

export async function closeSettings() {
  await $('button[title="Close settings (Esc)"]').click();
  await expect($(sel.settings)).not.toBeExisting();
}

/** The shell input editor (T6). */
export const commandInput = '//textarea[@placeholder="Type a command…"]';

/** Types `command` into the input editor and presses Enter there. Right
 *  after a terminal opens, typed text does not always reach React, so it is
 *  typed again until the editor's mirror layer (just before the textarea)
 *  shows it. Enter goes to the editor itself, since a new terminal can take
 *  focus back from it. */
export async function run(command: string) {
  const shown = () =>
    browser.execute(
      (xp: string, c: string) => {
        const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as Element | null;
        return el?.previousElementSibling?.textContent?.startsWith(c) ?? false;
      },
      commandInput,
      command,
    );
  await browser.waitUntil(
    async () => {
      await fill(commandInput, command);
      await browser.pause(300);
      return shown();
    },
    { timeout: 15_000, timeoutMsg: `the editor never showed ${command}` },
  );
  await browser.execute((xp: string) => {
    const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    el?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }, commandInput);
}
