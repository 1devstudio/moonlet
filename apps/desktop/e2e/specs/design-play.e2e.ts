// Playing a design full screen (X99): Play and P show the page over the whole
// window, at its size (Fill) or the viewport fitted (Fit); ←/→ go through the
// pages; a page written again loads again; Esc goes back to the canvas on the
// page last played; Download saves the page as one HTML file.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { rpc, world } from "../fixtures";

const w = world();
const workspaceId = () => rpc<{ id: string }[]>(w, "workspace.list", {})[0].id;
const mode = (label: string) => $(`//div[@role="group"][@aria-label="Mode"]/button[starts-with(@aria-label, "${label}")]`);
const SYSTEM = "play-kit";
const dir = () => join(w.home, "design", workspaceId(), "designs", "play-page");
// Its script says it ran, and in which frame: the canvas's asks for the bridge.
const page = (title: string) =>
  `<!doctype html>\n<html><head><meta charset="utf-8"><link rel="stylesheet" href="../../../systems/${SYSTEM}/styles.css"></head>\n<body data-mid="m1"><h1 data-mid="m2">${title}</h1><img data-mid="m3" src="../assets/dot.png" alt=""><script>parent.postMessage("moonlet-e2e-ran:" + location.search, "*")</script></body></html>\n`;
const play = () => $('//div[@role="dialog"][starts-with(@aria-label, "Playing Play page")]');
const played = (name: string) => $(`//iframe[@title="${name}.html played"]`);
/** The played frame's box: its size on screen. */
const box = (name: string) => browser.execute((t: string) => {
  const r = document.querySelector(`iframe[title="${t}.html played"]`)!.parentElement!.getBoundingClientRect();
  return [Math.round(r.width), Math.round(r.height)];
}, name);
/** The area under the play view's bar. */
const area = () => browser.execute(() => {
  const r = document.querySelector('[role="dialog"][aria-label^="Playing"] > div:last-child')!.getBoundingClientRect();
  return [Math.round(r.width), Math.round(r.height)];
});

describe("Playing a design full screen", () => {
  before(async () => {
    const ws = workspaceId();
    rpc(w, "design.system.create", { workspace: ws, name: "Play kit", sources: [], agent: false });
    writeFileSync(join(w.home, "design", "library", "systems", SYSTEM, "styles.css"), "h1 { color: #d97757; }\n");
    rpc(w, "design.create", { workspace: ws, name: "Play page", system: SYSTEM, brief: "Two pages" });
    mkdirSync(join(dir(), "assets"), { recursive: true });
    writeFileSync(join(dir(), "assets", "dot.png"), Buffer.from([137, 80, 78, 71]));
    writeFileSync(join(dir(), "pages", "index.html"), page("Home"));
    writeFileSync(join(dir(), "pages", "settings.html"), page("Settings"));
    if (await mode("Sessions").isExisting()) await mode("Sessions").click();
    await mode("Design").click();
    await $('//nav[@aria-label="Designs"]//button[.//span[normalize-space()="Play page"]]').click();
    await expect($('//nav[@aria-label="Pages"]//button[normalize-space()="settings"]')).toBeExisting();
    // Fit's worked example: the Phone viewport, 390×844, fits the window's area whole, at 100%.
    await $('//button[@aria-label="Viewport"]').click();
    await $('//button[starts-with(normalize-space(), "Phone")]').click();
    await browser.execute(() => {
      const w = window as unknown as { ran: string[] };
      w.ran = [];
      addEventListener("message", (e) => typeof e.data === "string" && e.data.startsWith("moonlet-e2e-ran:") && w.ran.push(e.data));
    });
  });

  after(async () => {
    if (await play().isExisting()) await browser.keys("Escape");
    for (const d of rpc<{ slug: string }[]>(w, "design.list", { workspace: workspaceId() })) rpc(w, "design.remove", { workspace: workspaceId(), slug: d.slug });
    rpc(w, "design.system.remove", { workspace: workspaceId(), slug: SYSTEM });
    if (await mode("Sessions").isExisting()) await mode("Sessions").click();
  });

  it("plays the page over the whole window with Play, at the window's size", async () => {
    await $('//button[@title="Play full screen (P)"]').click();
    await expect(play()).toBeDisplayed();
    await expect(play()).toHaveText(expect.stringContaining("Play page · index"));
    await expect(play()).toHaveText(expect.stringContaining("1 / 2"));
    await expect(played("index")).toBeExisting();
    const [ww, wh] = await browser.execute(() => [window.innerWidth, window.innerHeight]);
    const r = await browser.execute(() => document.querySelector('[role="dialog"][aria-label^="Playing"]')!.getBoundingClientRect().toJSON());
    expect([Math.round(r.width), Math.round(r.height)]).toEqual([ww, wh]);
    await browser.waitUntil(async () => JSON.stringify(await box("index")) === JSON.stringify(await area()), { timeout: 3000, timeoutMsg: "Fill did not size the page to the area" });
    // The keyboard is on the play bar, and the page's own script ran in the played frame.
    expect(await browser.execute(() => document.activeElement?.getAttribute("title"))).toBe("Back (Esc)");
    await browser.waitUntil(() => browser.execute(() => (window as unknown as { ran: string[] }).ran.some((r) => !r.includes("moonlet-bridge"))), { timeout: 5000, timeoutMsg: "the played page's script did not run" });
  });

  it("fits the canvas's viewport into the window with Fit", async () => {
    await play().$('.//button[normalize-space()="Fit"]').click();
    await browser.waitUntil(async () => JSON.stringify(await box("index")) === JSON.stringify([390, 844]), { timeout: 3000, timeoutMsg: "Fit did not show the Phone viewport at 100%" });
    await play().$('.//button[normalize-space()="Fill"]').click();
  });

  it("goes through the pages with → and ←", async () => {
    await browser.keys("ArrowRight");
    await expect(played("settings")).toBeExisting();
    await expect(play()).toHaveText(expect.stringContaining("2 / 2"));
    await browser.keys("ArrowRight");
    await expect(played("settings")).toBeExisting();
    await browser.keys("ArrowLeft");
    await expect(played("index")).toBeExisting();
    await browser.keys("ArrowRight");
    await expect(played("settings")).toBeExisting();
  });

  it("loads a page written again", async () => {
    const before = await played("settings").getAttribute("src");
    writeFileSync(join(dir(), "pages", "settings.html"), page("Settings, again"));
    await browser.waitUntil(async () => (await played("settings").getAttribute("src")) !== before, { timeout: 10_000, timeoutMsg: "the page did not load again" });
  });

  it("downloads the page as one HTML file with its styles and images inlined", async () => {
    const saved = join(w.root, "downloads", "settings.html");
    rmSync(saved, { force: true });
    await play().$('.//button[@title="Download as HTML"]').click();
    await browser.waitUntil(() => existsSync(saved), { timeout: 10_000, timeoutMsg: "nothing was saved" });
    const html = readFileSync(saved, "utf8");
    expect(html).toContain("<style>h1 { color: #d97757; }\n</style>");
    expect(html).toContain('src="data:image/png;base64,iVBORw=="');
    expect(html).not.toContain("moonlet:release");
    await expect($('//*[normalize-space()="Saved settings.html"]')).toBeExisting();
  });

  it("goes back to the canvas on Esc, showing the page last played", async () => {
    await browser.keys("Escape");
    await expect(play()).not.toBeExisting();
    await expect($('//nav[@aria-label="Pages"]//button[normalize-space()="settings"]')).toHaveAttribute("aria-current", "page");
    // The keyboard is back where it was: on Play.
    expect(await browser.execute(() => document.activeElement?.getAttribute("title"))).toBe("Play full screen (P)");
  });

  it("plays with P", async () => {
    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
    await browser.keys("p");
    await expect(play()).toBeDisplayed();
    await expect(played("settings")).toBeExisting();
    await play().$('.//button[@title="Back (Esc)"]').click();
    await expect(play()).not.toBeExisting();
  });
});
