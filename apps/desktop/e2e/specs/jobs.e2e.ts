// The Jobs tab (X62): a routed command is a job of its session, listed with
// its output, opened as a tab, and stopped from the panel.

import { spawn } from "node:child_process";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { BIN_DIR, CONFIG, SESSION, daemonSock, projectId, resetConfig, rpc, sel, socketRpc, world } from "../fixtures";

const w = world();
const panel = '//*[@id="right-tabpanel"]';
const row = (command: string) => `${panel}//div[@role="button"][@data-job=${JSON.stringify(command)}]`;
const HEAVY = `${CONFIG}\n[heavy]\ncommands = ["./job.sh"]\n`;

const JOB = `#!/bin/sh
echo "built 3 files"
echo "warn: slow disk" >&2
if [ "$1" = slow ]; then sleep 60; fi
`;

let session: { id: string; path: string };

/** Runs \`./job.sh\` in the session as Claude Code's hook has it run, and gives its exit status. */
function runJob(...args: string[]): Promise<number | null> {
  const child = spawn(join(BIN_DIR, "moonlet"), ["exec", "--tool-use", "toolu_e2e", "--", "./job.sh", ...args], {
    cwd: session.path,
    env: { ...w.env, MOONLET_SESSION: session.id },
    stdio: "ignore",
  });
  return new Promise((resolve) => child.on("exit", (code) => resolve(code)));
}

const jsClick = (xpath: string) =>
  browser.execute((x) => {
    const el = document.evaluate(x, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement | null;
    el?.click();
    return !!el;
  }, xpath);

describe("jobs", () => {
  before(async () => {
    session = rpc<{ id: string; name: string; path: string }[]>(w, "session.list", {}).find((s) => s.name === SESSION)!;
    writeFileSync(join(session.path, "job.sh"), JOB);
    chmodSync(join(session.path, "job.sh"), 0o755);
    // The worktree's own config decides what is routed; the project's is what gets approved.
    writeFileSync(join(session.path, ".moonlet", "config.toml"), HEAVY);
    resetConfig(w, HEAVY);
    await socketRpc(daemonSock(w), w.env, "heavy.approve", { project: projectId(w), commands: ["./job.sh"], env: [] });
    await $(sel.sessionRow(SESSION)).click();
  });

  after(() => {
    writeFileSync(join(session.path, ".moonlet", "config.toml"), CONFIG);
    rmSync(join(session.path, "job.sh"), { force: true });
    resetConfig(w, CONFIG);
  });

  it("the Jobs tab lists the job and opens its output", async () => {
    expect(await runJob()).toBe(0);
    await browser.waitUntil(() => jsClick('//button[@id="right-tab-jobs"]'), { timeoutMsg: "the Jobs tab never showed" });
    await expect($('//button[@id="right-tab-jobs"]//span[normalize-space()="1"]')).toBeDisplayed();
    await expect($(`${row("./job.sh")}//span[contains(normalize-space(), "exit 0")]`)).toBeDisplayed();
    await jsClick(row("./job.sh"));
    await expect($(`${panel}//*[@data-job-output]//div[normalize-space()="built 3 files"]`)).toBeDisplayed();
    await expect($(`${panel}//*[@data-job-output]//div[normalize-space()="warn: slow disk"]`)).toBeDisplayed();
    // ↗ opens it as a session tab, with stderr apart.
    await jsClick(`${panel}//button[@title="Open as a tab"]`);
    const view = '//*[@data-job-view="./job.sh"]';
    await expect($(`${view}//*[@data-job-output]//span[normalize-space()="built 3 files"]`)).toBeDisplayed();
    await jsClick(`${view}//button[@role="radio"][starts-with(normalize-space(), "stderr")]`);
    await expect($(`${view}//*[@data-job-output]//span[normalize-space()="built 3 files"]`)).not.toBeExisting();
    await expect($(`${view}//*[@data-job-output]//span[normalize-space()="warn: slow disk"]`)).toBeDisplayed();
    await jsClick(`${panel}//button[normalize-space()="Jobs"]`);
  });

  it("Stop ends a running job", async () => {
    const exit = runJob("slow");
    await expect($(`${row("./job.sh slow")}//span[starts-with(normalize-space(), "Running on ")]`)).toBeDisplayed();
    await jsClick(row("./job.sh slow"));
    await expect($(`${panel}//*[normalize-space()="Changes made so far still come back."]`)).toBeDisplayed();
    await jsClick(`${panel}//button[normalize-space()="Stop"]`);
    // The agent's command ends as stopped from the panel.
    expect(await exit).toBe(143);
    await jsClick(`${panel}//button[normalize-space()="Jobs"]`);
    await expect($(`${row("./job.sh slow")}//span[starts-with(normalize-space(), "Stopped")]`)).toBeDisplayed();
  });
});
