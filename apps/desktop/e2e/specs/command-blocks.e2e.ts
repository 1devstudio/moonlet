// Warp-mode block headers (T8): each command gets a grey header line above
// it with its directory and duration, plus `exit N` when it fails.

import { $, $$, browser, expect } from "@wdio/globals";
import { PROJECT, fill, rpc, sel, world } from "../fixtures";

const w = world();
const SESSION = "Check block headers";
const input = '//textarea[@placeholder="Type a command…"]';

/** Types `command` into the input editor and presses Enter there. Right
 *  after a terminal opens, typed text does not always reach React, so it is
 *  typed again until the editor's mirror layer (just before the textarea)
 *  shows it. Enter goes to the editor itself, since a new terminal can take
 *  focus back from it. */
async function run(command: string) {
  const shown = () =>
    browser.execute(
      (xp: string, c: string) => {
        const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as Element | null;
        return el?.previousElementSibling?.textContent?.startsWith(c) ?? false;
      },
      input,
      command,
    );
  await browser.waitUntil(
    async () => {
      await fill(input, command);
      await browser.pause(300);
      return shown();
    },
    { timeout: 15_000, timeoutMsg: `the editor never showed ${command}` },
  );
  await browser.execute((xp: string) => {
    const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    el?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }, input);
}

describe("command blocks", () => {
  let sessionId = "";

  // A session of its own: its first tab is a shell in the world's zsh.
  before(async () => {
    const project = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!;
    sessionId = rpc<{ id: string }>(w, "session.create", { project_id: project.id, name: SESSION, agent: "none" }).id;
    // Open it only once its shell sits at a prompt, so the shell's directory
    // report comes before the app attaches.
    await browser.waitUntil(() =>
      rpc<{ session_id?: string; kind: string; prompt?: boolean }[]>(w, "terminal.list", {}).some((t) => t.session_id === sessionId && t.kind === "shell" && t.prompt),
    );
    await $(sel.sessionRow(SESSION)).click();
  });

  after(async () => {
    rpc(w, "session.archive", { id: sessionId });
    await expect($(sel.sessionRow(SESSION))).not.toBeExisting();
  });

  it("shows a header with the exit code above a failing command", async () => {

    await run("false");
    await expect($(".jaunt-block-head .exit")).toHaveText("· exit 1", { wait: 15_000 });
    // The shell reported its directory before the app attached; the header
    // still names the session's worktree.
    await expect($(".jaunt-block-head .place")).toHaveText(/\/worktrees\/e2e-repo\/check-block-headers/);

    await run("echo e2e-ok");
    // The newest header: no exit code, a duration in seconds.
    await browser.waitUntil(async () => (await $$(".jaunt-block-head").length) === 2, { timeout: 15_000 });
    const heads = await $$(".jaunt-block-head");
    await expect(heads[1].$(".exit")).not.toExist();
    await expect(heads[1].$(".duration")).toHaveText(/^\(\d+\.\d{3}s\)$/);
  });
});
