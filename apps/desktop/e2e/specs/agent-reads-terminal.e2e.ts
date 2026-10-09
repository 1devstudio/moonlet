// X31: an agent in a session runs `moonlet term read`; the app shows the
// output it would get and lets the user allow or deny the read.

import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { BIN_DIR, PROJECT, rpc, sel, world } from "../fixtures";

const w = world();
const SESSION = "Read my terminal";
const OTHER = "Somewhere else";
const TITLE = "Let the agent read a terminal?";
const modal = () => $(sel.confirm(TITLE));

interface Session {
  id: string;
  name: string;
  path: string;
  terminals: number[];
}

let session: Session;
let log = 0;

/** `moonlet term read` as the agent in the session's first terminal runs it;
 * it waits for the user's answer. */
function read(args: string[] = []): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawn(join(BIN_DIR, "moonlet"), ["term", "read", String(log), ...args], {
    env: { ...w.env, MOONLET_TERMINAL_ID: String(session.terminals[0]) },
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, out, err })));
}

describe("an agent reads a terminal", () => {
  before(async () => {
    const project = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!;
    session = rpc<Session>(w, "session.create", { project_id: project.id, name: SESSION, agent: "none" });
    rpc(w, "session.create", { project_id: project.id, name: OTHER, agent: "none" });
    log = rpc<{ id: number }>(w, "terminal.create", {
      cwd: session.path,
      session_id: session.id,
      command: ["/bin/sh", "-c", "printf 'e2e build failed\\nexit code 2\\n'; exec sleep 600"],
      title: "e2e-log",
    }).id;
    await $(sel.sessionRow(SESSION)).waitForDisplayed({ timeout: 15_000 });
    await $(sel.sessionRow(SESSION)).click();
  });

  it("shows the exact output and gives it to the agent on Allow", async () => {
    const result = read();
    await expect(modal()).toBeDisplayed({ wait: 15_000 });
    await expect($(sel.text("The agent in Read my terminal wants the last 2 lines of terminal e2e-log."))).toBeDisplayed();
    await expect($(`${sel.confirm(TITLE)}//pre`)).toHaveText("e2e build failed\nexit code 2");
    await expect($(sel.confirmButton("Allow"))).toBeFocused();

    await $(sel.confirmButton("Allow")).click();
    await expect(modal()).not.toBeExisting();
    expect(await result).toEqual({ code: 0, out: "e2e build failed\nexit code 2\n", err: "" });
  });

  it("tells the agent when the user denies", async () => {
    const result = read();
    await expect(modal()).toBeDisplayed({ wait: 15_000 });
    await $(sel.confirmButton("Deny")).click();
    await expect(modal()).not.toBeExisting();
    expect(await result).toEqual({ code: 1, out: "", err: `moonlet: the user declined to share terminal ${log}\n` });
  });

  it("marks the session as needing the user while it is not in view", async () => {
    await $(sel.sessionRow(OTHER)).click();
    const result = read();
    await expect($(`${sel.sessionRow(SESSION)}//span[normalize-space()="needs input"]`)).toBeDisplayed({ wait: 15_000 });
    await expect(modal()).not.toBeExisting();

    await $(sel.sessionRow(SESSION)).click();
    await expect(modal()).toBeDisplayed();
    await $(sel.confirmButton("Allow")).click();
    expect((await result).code).toBe(0);
    await expect($(`${sel.sessionRow(SESSION)}//span[normalize-space()="needs input"]`)).not.toBeExisting();
  });

  it("stops asking once allowed for the session, until the ⋯ menu asks again", async () => {
    const result = read();
    await expect(modal()).toBeDisplayed({ wait: 15_000 });
    await $(`${sel.confirm(TITLE)}//label[normalize-space()="Allow for the rest of this session"]/input`).click();
    await $(sel.confirmButton("Allow")).click();
    expect((await result).code).toBe(0);

    const again = spawnSync(join(BIN_DIR, "moonlet"), ["term", "read", String(log), "--lines", "1"], {
      env: { ...w.env, MOONLET_TERMINAL_ID: String(session.terminals[0]) },
      timeout: 10_000,
    });
    expect(again.stdout.toString()).toBe("exit code 2\n");

    await $('button[title="More"]').click();
    await $(sel.button("Ask before the agent reads terminals")).click();
    await browser.waitUntil(() => rpc<string[]>(w, "terminal.read_grants", {}).length === 0, { timeout: 10_000 });
    await $('button[title="More"]').click();
    await expect($(sel.button("Ask before the agent reads terminals"))).not.toBeExisting();
    await $('button[title="More"]').click();
  });
});
