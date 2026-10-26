// A design system's cards load one at a time (X64): with WebKit's site
// isolation, card frames that start loading together were sent one card's
// request, so most never loaded. Each shows a spinner until it loaded, and
// a card loads again only when what it shows changed, never for the sync's
// notes.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { $, $$, browser, expect } from "@wdio/globals";
import { projectId, rpc, world } from "../fixtures";

const w = world();
const workspaceId = () => rpc<{ id: string }[]>(w, "workspace.list", {})[0].id;
const mode = (label: string) => $(`//div[@role="group"][@aria-label="Mode"]/button[starts-with(@aria-label, "${label}")]`);
const SLUG = "loading-kit";
const N = 8;
const name = (i: number) => `Card ${i}`;
const names = Array.from({ length: N }, (_, i) => name(i + 1));
const LOADED = "moonlet-e2e-loaded ";
const head = '<!doctype html>\n<html><head><meta charset="utf-8"><link rel="stylesheet" href="../../../styles.css"></head>\n';
const dir = () => join(w.home, "design", workspaceId(), "systems", SLUG);
const cardFile = (i: number) => join(dir(), "components", "custom", `card-${i}`, `card-${i}.html`);
// It tells the window which card it is once it loaded.
const card = (i: number) =>
  `<!-- @dsCard group="Custom" name="${name(i)}" viewport="400x300" -->\n${head}<body><section data-snippet="custom/card-${i}/default"><p class="c">${name(i)}</p></section><script>addEventListener("load", () => parent.postMessage("${LOADED}${name(i)}", "*"));</script></body></html>\n`;

type Heard = { loaded?: string[] };
const heard = () => browser.execute(() => (window as unknown as Heard).loaded ?? []);
const forget = () => browser.execute(() => ((window as unknown as Heard).loaded = []));
const spinners = () => $$('//section[@aria-label="Custom"]//*[@role="status"][starts-with(@aria-label, "Loading ")]');

describe("A design system's cards loading", () => {
  before(async () => {
    if (await mode("Sessions").isExisting()) await mode("Sessions").click();
    rpc(w, "design.system.create", { workspace: workspaceId(), name: "Loading kit", sources: [{ project: projectId(w) }], agent: false });
    writeFileSync(join(dir(), "styles.css"), ".c { color: #e6e6e6; }\n");
    for (let i = 1; i <= N; i++) {
      mkdirSync(dirname(cardFile(i)), { recursive: true });
      writeFileSync(cardFile(i), card(i));
    }
    await browser.execute((prefix: string) => {
      const win = window as unknown as Heard;
      win.loaded = [];
      window.addEventListener("message", (e) => {
        if (typeof e.data === "string" && e.data.startsWith(prefix)) win.loaded?.push(e.data.slice(prefix.length));
      });
    }, LOADED);
    // The writes' design.changed comes 150 ms after the last: let it pass before the cards show.
    await browser.pause(1_000);
  });

  after(async () => {
    rpc(w, "design.system.remove", { workspace: workspaceId(), slug: SLUG });
    if (await mode("Sessions").isExisting()) await mode("Sessions").click();
  });

  it("loads every card on screen, each its own page, and leaves no spinner", async () => {
    await mode("Design").click();
    await $('//nav[@aria-label="Design systems"]//button[.//span[normalize-space()="Loading kit"]]').click();
    await browser.waitUntil(async () => (await heard()).length >= N, { timeout: 15_000, interval: 200, timeoutMsg: "not every card loaded" });
    // Each card loaded once, and none showed another card's page.
    expect([...(await heard())].sort()).toEqual(names);
    await browser.waitUntil(async () => (await spinners().length) === 0, { timeout: 3_000, timeoutMsg: "a spinner is left" });
  });

  it("loads no card again for the sync's notes, grades and render check", async () => {
    await forget();
    writeFileSync(join(dir(), "NOTES.md"), "# Notes\n");
    mkdirSync(join(dir(), ".cache", "grades"), { recursive: true });
    writeFileSync(join(dir(), ".cache", "grades", "Card 1.json"), "{}\n");
    writeFileSync(join(dir(), ".cache", "render-check.json"), '{"total":8,"bad":0,"thin":0,"variants_identical":0,"cards":[]}\n');
    // design.changed comes 150 ms after the last write; give the frames time to load if they did.
    await browser.pause(2_500);
    expect(await heard()).toEqual([]);
  });

  it("loads again only the card whose page changed", async () => {
    await forget();
    writeFileSync(cardFile(3), card(3));
    await browser.waitUntil(async () => (await heard()).includes(name(3)), { timeout: 10_000, interval: 200, timeoutMsg: "the changed card did not load again" });
    await browser.pause(1_500);
    expect(await heard()).toEqual([name(3)]);
  });

  it("loads every card again when the styles they load change", async () => {
    await forget();
    writeFileSync(join(dir(), "styles.css"), ".c { color: #f0f0f0; }\n");
    await browser.waitUntil(async () => (await heard()).length >= N, { timeout: 15_000, interval: 200, timeoutMsg: "not every card loaded again" });
    expect([...(await heard())].sort()).toEqual(names);
  });
});
