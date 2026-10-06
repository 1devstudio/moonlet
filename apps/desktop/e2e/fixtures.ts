// Scratch world for the e2e tests (X12): a JAUNT_HOME, a git repo, a daemon
// that can never start a real agent, and helpers the specs share.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { browser } from "@wdio/globals";
import type { ChainablePromiseElement } from "webdriverio";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const BIN_DIR = join(here, "..", "..", "..", "target", "e2e", "debug");
export const APP = join(BIN_DIR, "jaunt-app");

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
  /** Environment for jauntd, jaunt and the app. */
  env: Record<string, string>;
}

/** The world created by the launcher, shared with workers through env. */
export function world(): World {
  const root = process.env.JAUNT_E2E_ROOT;
  if (!root) throw new Error("JAUNT_E2E_ROOT is not set; run the specs through wdio.conf.ts");
  return makeWorld(root);
}

function makeWorld(root: string): World {
  const home = join(root, "jaunt-home");
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
      JAUNT_HOME: home,
      JAUNT_BIN_DIR: BIN_DIR,
      JAUNT_E2E_ROOT: root,
    },
  };
}

/** Creates the scratch dirs, the repo and a running daemon with a project
 *  and one session. */
export function setUp(): World {
  const w = makeWorld(mkdtempSync(join(tmpdir(), "jaunt-e2e-")));
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
  // jauntd gives terminals and agents the PATH of a login shell (SHELL is
  // zsh here), not its own, so the fakes must come first there too. Each
  // zsh startup file sets it again: /etc/zprofile's path_helper reorders
  // PATH after .zshenv.
  const fakeFirst = `PATH="${fakeBin}:$PATH"; export PATH\n`;
  for (const rc of [".profile", ".zshenv", ".zprofile", ".zshrc"]) writeFileSync(join(w.env.HOME, rc), fakeFirst);
  mkdirSync(join(w.repo, ".jaunt"), { recursive: true });
  writeFileSync(join(w.repo, ".jaunt", "config.toml"), CONFIG);
  writeFileSync(join(w.repo, "README.md"), "e2e\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: w.repo, env: w.env, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.email=e2e@jaunt.test", "-c", "user.name=e2e", "commit", "-qm", "init");

  execFileSync(join(BIN_DIR, "jauntd"), ["start"], { env: w.env, stdio: "pipe" });
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
  const out = execFileSync(join(BIN_DIR, "jaunt"), ["rpc", method, JSON.stringify(params)], { env: w.env, stdio: "pipe" });
  return JSON.parse(out.toString() || "null") as T;
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

export const configPath = (w: World) => join(w.repo, ".jaunt", "config.toml");

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
  dialog: '[role="dialog"][aria-label="Project settings"]',
  /** A labelled field inside the Project settings dialog. */
  field: (label: string) => `//div[@role="dialog"]//label[span[normalize-space()=${lit(label)}]]//*[self::input or self::select]`,
  /** A button inside the Project settings dialog, by its visible text. */
  dialogButton: (text: string) => `//div[@role="dialog"]//button[starts-with(normalize-space(), ${lit(text)})]`,
  /** A button by its visible text (ignoring nested hints such as ⌘↵). */
  button: (text: string) => `//button[starts-with(normalize-space(), ${lit(text)})]`,
  text: (text: string) => `//*[normalize-space()=${lit(text)}]`,
  /** The confirm modal (X23), by its title. */
  confirm: (title: string) => `//div[@role="dialog"][@aria-modal="true"][@aria-label=${lit(title)}]`,
  /** A button in the open confirm modal, by its visible text. */
  confirmButton: (text: string) => `//div[@role="dialog"][@aria-modal="true"]//button[normalize-space()=${lit(text)}]`,
  sessionRow: (name: string) => `//div[@role="button"][.//span[normalize-space()=${lit(name)}]]`,
};
