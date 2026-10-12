// Block headers in Blocks mode (T8): each command gets a grey header line above
// it with its directory and duration, plus `exit N` when it fails.

import { execFileSync } from "node:child_process";
import { $, $$, browser, expect } from "@wdio/globals";
import { PROJECT, commandInput as input, fill, rpc, run, sel, world } from "../fixtures";

const w = world();
const SESSION = "Check block headers";


/** Sends a key to whatever has focus, as the app's shortcuts see it. */
async function press(key: string, mods: { metaKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}) {
  await browser.execute(
    (k: string, m: object) => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...m })),
    key,
    mods,
  );
}

describe("command blocks", () => {
  let sessionId = "";
  let agentId = 0;

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
    await expect($(".moonlet-block-head .exit")).toHaveText("· exit 1", { wait: 15_000 });
    // The shell reported its directory before the app attached; the header
    // still names the session's worktree.
    await expect($(".moonlet-block-head .place")).toHaveText(/\/worktrees\/e2e-repo\/check-block-headers/);

    await run("echo e2e-ok");
    // The newest header: no exit code, a duration in seconds.
    await browser.waitUntil(async () => (await $$(".moonlet-block-head").length) === 2, { timeout: 15_000 });
    const heads = await $$(".moonlet-block-head");
    await expect(heads[1].$(".exit")).not.toExist();
    await expect(heads[1].$(".duration")).toHaveText(/^\(\d+\.\d{3}s\)$/);
  });

  it("selects the newest block with ⌘↑ and copies its command and output with ⌘C", async () => {
    await run("echo e2e-copied");
    await browser.waitUntil(async () => (await $$(".moonlet-block-head").length) === 3, { timeout: 15_000 });
    await expect($(".moonlet-block-bg.selected")).not.toExist();

    // From the input editor: ⌘↑ selects the newest block and focuses the terminal.
    await press("ArrowUp", { metaKey: true });
    await expect($(".moonlet-block-bg.selected")).toExist();
    await press("c", { metaKey: true });
    await expect($(sel.text("Copied command and output"))).toBeDisplayed();
    expect(execFileSync("pbpaste", { encoding: "utf8" })).toBe("$ echo e2e-copied\ne2e-copied");

    // Esc clears the selection.
    await press("Escape");
    await expect($(".moonlet-block-bg.selected")).not.toExist();

    // So does editing a command: ⌘↵ is then about the typed command.
    await press("ArrowUp", { metaKey: true });
    await expect($(".moonlet-block-bg.selected")).toExist();
    await fill(input, "echo typed");
    await expect($(".moonlet-block-bg.selected")).not.toExist();
    await fill(input, "");
  });

  it("sends the selected block to the session's agent with ⌘↵", async () => {
    // The repo's `fake` agent: a TUI that echoes what it is sent.
    const session = rpc<{ id: string; path: string }[]>(w, "session.list", {}).find((x) => x.id === sessionId)!;
    const agent = rpc<{ id: number }>(w, "terminal.create", { cwd: session.path, session_id: sessionId, kind: "agent", agent: "fake", cols: 100, rows: 30 });
    agentId = agent.id;
    await run("echo e2e-sent");
    await browser.waitUntil(async () => (await $$(".moonlet-block-head").length) === 4, { timeout: 15_000 });

    await press("ArrowUp", { metaKey: true });
    await expect($(sel.text("⌘↵ send `echo e2e-sent` to the agent · ⇧⌘↵ new agent tab"))).toBeDisplayed();
    await press("Enter", { metaKey: true });

    await expect($('//*[@aria-current="true"][.//span[normalize-space()="fake"]]')).toBeDisplayed();
    await browser.waitUntil(() => rpc<unknown[]>(w, "terminal.search", { id: agent.id, query: "$ echo e2e-sent" }).length > 0, {
      timeoutMsg: "the block never reached the agent",
    });
  });

  it("copies a block to the agent from its header's Copy to agent button", async () => {
    // Back to the shell's tab (tabs switch on mousedown).
    await browser.execute(() => {
      const tab = document.evaluate('//span[normalize-space()="zsh"]', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      tab?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await run("echo e2e-hover");
    await browser.waitUntil(async () => (await $$(".moonlet-block-head").length) === 5, { timeout: 15_000 });

    // The mouse over the newest block shows its actions.
    await browser.execute(() => {
      const heads = document.querySelectorAll(".moonlet-block-head");
      const r = heads[heads.length - 1].getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      document.elementFromPoint(x, y)?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));
    });
    const button = $(".moonlet-block-head.hover .action.agent");
    await expect(button).toBeDisplayed();
    await expect(button).toHaveText("Copy to agent");
    await button.click();

    await expect($('//*[@aria-current="true"][.//span[normalize-space()="fake"]]')).toBeDisplayed();
    await browser.waitUntil(() => rpc<unknown[]>(w, "terminal.search", { id: agentId, query: "$ echo e2e-hover" }).length > 0, {
      timeoutMsg: "the block never reached the agent",
    });
    // The whole draft: the command line, its output and the fences around them.
    const lines = (query: string) => rpc<{ text: string }[]>(w, "terminal.search", { id: agentId, query }).map((m) => m.text.trim());
    expect(lines("e2e-hover").filter((t) => t.endsWith("e2e-hover") && !t.includes("$ echo")).length).toBeGreaterThan(0);
    expect(lines("```").filter((t) => t.endsWith("```")).length).toBeGreaterThanOrEqual(2);
  });

  it("pins the header of a block whose output fills the screen, with Copy to agent in reach", async () => {
    // Back to the shell's tab (tabs switch on mousedown).
    await browser.execute(() => {
      const tab = document.evaluate('//span[normalize-space()="zsh"]', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      tab?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await run("seq 1 300");
    // The output pushed the block's own header above the viewport.
    const sticky = $(".moonlet-block-head.sticky");
    await expect(sticky).toBeDisplayed({ wait: 15_000 });
    await expect(sticky.$(".place")).toHaveText(/\/worktrees\/e2e-repo\/check-block-headers/);
    await expect(sticky.$(".duration")).toHaveText(/^\(\d+\.\d{3}s\)$/);

    // The mouse over the pinned header shows the block's actions there.
    await browser.execute(() => {
      const r = document.querySelector(".moonlet-block-head.sticky")!.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      document.elementFromPoint(x, y)?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));
    });
    const button = $(".moonlet-block-head.sticky.hover .action.agent");
    await expect(button).toBeDisplayed();
    await button.click();

    await expect($('//*[@aria-current="true"][.//span[normalize-space()="fake"]]')).toBeDisplayed();
    await browser.waitUntil(() => rpc<unknown[]>(w, "terminal.search", { id: agentId, query: "$ seq 1 300" }).length > 0, {
      timeoutMsg: "the pinned block never reached the agent",
    });
  });

  it("keeps the blocks, with exit codes and durations, when the app attaches again", async () => {
    // A reload attaches to the shell as a new window does: from the
    // daemon's snapshot, without the marks the app saw live.
    await browser.refresh();
    await $(sel.sessionRow(SESSION)).click();
    await browser.execute(() => {
      const tab = document.evaluate('//span[normalize-space()="zsh"]', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      tab?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    // `seq 1 300` fills the screen; its header is pinned, with its duration.
    const sticky = $(".moonlet-block-head.sticky");
    await expect(sticky).toBeDisplayed({ wait: 15_000 });
    await expect(sticky.$(".place")).toHaveText(/\/worktrees\/e2e-repo\/check-block-headers/);
    await expect(sticky.$(".duration")).toHaveText(/^\(\d+\.\d{3}s\)$/);

    // ⌘↑ selects it, and steps back through the earlier blocks to `false`.
    await browser.waitUntil(async () => (await $(input).isExisting()) && (await $(input).isEnabled()), { timeout: 15_000 });
    await browser.execute((xp: string) => {
      const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement | null;
      el?.focus();
    }, input);
    await press("ArrowUp", { metaKey: true });
    await expect($(sel.text("⌘↵ send `seq 1 300` to the agent · ⇧⌘↵ new agent tab"))).toBeDisplayed();
    // echo e2e-hover, e2e-sent, e2e-copied, e2e-ok, then false.
    for (let i = 0; i < 5; i++) await press("ArrowUp", { metaKey: true });
    await expect($(sel.text("⌘↵ send `false` to the agent · ⇧⌘↵ new agent tab"))).toBeDisplayed();
    await expect($(".moonlet-block-head.selected .exit")).toHaveText("· exit 1");
    await press("Escape");
  });
});

