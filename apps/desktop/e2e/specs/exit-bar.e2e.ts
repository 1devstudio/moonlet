// The bar under a terminal whose process exited lies over the terminal's
// last rows. Its Restart and Close buttons take every click on them, not
// xterm's layers under the bar (the WebGL link layer, the scrollbar).

import { $, browser, expect } from "@wdio/globals";
import { PROJECT, rpc, sel, world } from "../fixtures";

const w = world();
const SESSION = "Exited process";
const TITLE = "e2e-exited";

/** Whether the terminal in view shows the bar of a process that ended with
 *  code 0. The session's setup tab has one too, in a hidden tab. */
const shownExitBar = () =>
  browser.execute(() =>
    [...document.querySelectorAll("[data-terminal-pane]")].some((p) => p.checkVisibility({ visibilityProperty: true }) && p.textContent?.includes("Process exited with code 0.")),
  );

/** The buttons whose spots, at their centre and just inside each corner,
 *  hit something other than the button itself. */
function missedSpots(labels: string[]) {
  return browser.execute((names: string[]) => {
    const missed: string[] = [];
    const pane = [...document.querySelectorAll("[data-terminal-pane]")].find((p) => p.checkVisibility({ visibilityProperty: true }) && p.textContent?.includes("Process exited"));
    for (const name of names) {
      const button = [...(pane?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.trim() === name);
      if (!button) {
        missed.push(`${name}: no button`);
        continue;
      }
      const r = button.getBoundingClientRect();
      const spots: [string, number, number][] = [
        ["centre", r.left + r.width / 2, r.top + r.height / 2],
        ["top left", r.left + 2, r.top + 2],
        ["top right", r.right - 2, r.top + 2],
        ["bottom left", r.left + 2, r.bottom - 2],
        ["bottom right", r.right - 2, r.bottom - 2],
      ];
      for (const [where, x, y] of spots) {
        const hit = document.elementFromPoint(x, y);
        if (!hit || !button.contains(hit)) missed.push(`${name} ${where}: ${hit?.className || hit?.tagName}`);
      }
    }
    return missed;
  }, labels);
}

describe("a terminal whose process exited", () => {
  before(async () => {
    const project = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!;
    const session = rpc<{ id: string; path: string }>(w, "session.create", { project_id: project.id, name: SESSION, agent: "none" });
    // Enough output to scroll, so the terminal has a scrollbar.
    rpc(w, "terminal.create", { cwd: session.path, session_id: session.id, command: ["/bin/sh", "-c", "seq 1 300"], title: TITLE });
    await $(sel.sessionRow(SESSION)).waitForDisplayed({ timeout: 15_000 });
    await $(sel.sessionRow(SESSION)).click();
    // Tabs switch on mousedown.
    await browser.waitUntil(
      () =>
        browser.execute((title: string) => {
          const tab = document.evaluate(`//span[normalize-space()="${title}"]`, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
          tab?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          return !!tab;
        }, TITLE),
      { timeout: 15_000, timeoutMsg: `no ${TITLE} tab` },
    );
    await browser.waitUntil(() => shownExitBar(), { timeout: 15_000, timeoutMsg: "no exit bar in view" });
  });

  it("takes clicks anywhere on Restart and Close", async () => {
    expect(await missedSpots(["Restart", "Close"])).toEqual([]);
  });

  it("takes them while the terminal's scrollbar shows", async () => {
    // The pointer over the terminal shows its scrollbar, which then stays
    // while the pointer moves down onto the bar.
    const shown = await browser.execute(() => {
      const pane = [...document.querySelectorAll("[data-terminal-pane]")].find((p) => p.checkVisibility({ visibilityProperty: true }) && p.textContent?.includes("Process exited"));
      pane?.querySelector(".xterm-scrollable-element")?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      return pane?.querySelector(".xterm-scrollable-element > .scrollbar.vertical")?.classList.contains("visible") ?? false;
    });
    expect(shown).toBe(true);
    expect(await missedSpots(["Restart", "Close"])).toEqual([]);
  });

});
