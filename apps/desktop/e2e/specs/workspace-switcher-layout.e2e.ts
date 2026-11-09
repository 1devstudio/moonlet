// The workspace switcher and the mode switch share the sidebar's title bar
// (X32, X45, X65). In a narrow sidebar the switcher's name truncates; it
// never runs under the mode switch's buttons.

import { $, browser, expect } from "@wdio/globals";
import { rpc, world } from "../fixtures";

const w = world();

interface Workspace {
  id: string;
  name: string;
}

const LONG = "My Workspace With A Long Name";
const switcher = `//button[@aria-label="Switch workspace, current: ${LONG}"]`;

/**
 * Opens the app again with the sidebar `px` wide, as the app's settings keep
 * it (the splitter takes no pointer capture from the driver's events).
 */
async function sidebarWidth(px: number) {
  await browser.execute((w: number) => {
    const ui = JSON.parse(localStorage.getItem("moonlet.ui") ?? "{}");
    localStorage.setItem("moonlet.ui", JSON.stringify({ ...ui, sidebarWidth: w }));
  }, px);
  await browser.refresh();
}

const box = (xp: string) =>
  browser.execute((x: string) => {
    const r = (document.evaluate(x, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as Element).getBoundingClientRect();
    return { left: r.left, right: r.right, width: r.width };
  }, xp);

describe("workspace switcher layout", () => {
  let ws: Workspace;
  let width = 0;

  before(async () => {
    await expect($('button[aria-label^="Switch workspace, current:"]')).toBeDisplayed({ wait: 30_000 });
    ws = rpc<Workspace[]>(w, "workspace.list", {})[0];
    width = (await box("//aside")).width;
    rpc(w, "workspace.update", { id: ws.id, name: LONG });
    await expect($(switcher)).toBeDisplayed({ wait: 10_000 });
  });

  after(async () => {
    rpc(w, "workspace.update", { id: ws.id, name: ws.name });
    // The sidebar's width outlives the run: put it back.
    await sidebarWidth(width);
  });

  it("truncates the workspace name beside the mode switch in the narrowest sidebar, keeping its square and chevron whole", async () => {
    // A width saved before the minimum went up opens at the minimum.
    await sidebarWidth(200);
    await expect($(switcher)).toBeDisplayed({ wait: 30_000 });
    expect((await box("//aside")).width).toBe(260);

    const button = await box(switcher);
    expect(button.right).toBeLessThanOrEqual((await box('//div[@role="group"][@aria-label="Mode"]')).left);
    // The square and the chevron are inside the button, not clipped by it.
    expect((await box(`${switcher}/span[1]`)).left).toBeGreaterThanOrEqual(button.left);
    expect((await box(`${switcher}/*[name()="svg"][last()]`)).right).toBeLessThanOrEqual(button.right);
  });
});
