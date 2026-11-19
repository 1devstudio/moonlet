// T2: an exited pane shows its exit code with Restart and Close. The bar
// lies over the terminal's last rows, and its buttons take every click on
// them, not xterm's layers under the bar (the WebGL link layer, the scrollbar).

import { $, browser, expect } from "@wdio/globals";
import { PROJECT, rpc, sel, world } from "../fixtures";

const w = world();
const SESSION = "Exited process";
const TITLE = "e2e-exited";
/** Set on the exited pane in view, so every check looks at that one. The
 *  session's setup tab also has an exit bar, in a hidden tab. */
const MARK = "data-e2e-exited";

/** Marks the pane in view once it shows an exit bar; true when it does. */
const markExitedPane = () =>
  browser.execute((mark: string) => {
    const pane = [...document.querySelectorAll("[data-terminal-pane]")].find((p) => p.checkVisibility({ visibilityProperty: true }) && p.textContent?.includes("Process exited with code 0."));
    pane?.setAttribute(mark, "");
    return !!pane;
  }, MARK);

/** The buttons whose spots, at their centre and just inside each corner,
 *  hit something other than the button itself. */
function missedSpots(labels: string[]) {
  return browser.execute(
    (mark: string, names: string[]) => {
      const missed: string[] = [];
      const pane = document.querySelector(`[${mark}]`);
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
    },
    MARK,
    labels,
  );
}

describe("a terminal whose process exited", () => {
  let sessionId = "";

  before(async () => {
    const project = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!;
    const session = rpc<{ id: string; path: string }>(w, "session.create", { project_id: project.id, name: SESSION, agent: "none" });
    sessionId = session.id;
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
    await browser.waitUntil(markExitedPane, { timeout: 15_000, timeoutMsg: "no exit bar in view" });
  });

  after(async () => {
    rpc(w, "session.archive", { id: sessionId });
    await expect($(sel.sessionRow(SESSION))).not.toBeExisting();
  });

  it("takes clicks anywhere on Restart and Close", async () => {
    expect(await missedSpots(["Restart", "Close"])).toEqual([]);
  });

  it("takes them while the terminal's scrollbar shows", async () => {
    // The pointer over the terminal shows its scrollbar, which then stays
    // while the pointer moves down onto the bar.
    // xterm shows it from a timer, so wait for its `visible` class.
    await browser.waitUntil(
      () =>
        browser.execute((mark: string) => {
          const scrollable = document.querySelector(`[${mark}] .xterm-scrollable-element`);
          scrollable?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          return scrollable?.querySelector(":scope > .scrollbar.vertical")?.classList.contains("visible") ?? false;
        }, MARK),
      { timeout: 5_000, timeoutMsg: "the scrollbar never showed" },
    );
    expect(await missedSpots(["Restart", "Close"])).toEqual([]);
  });
});
