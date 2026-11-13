// A design card that never stops running (X64): each card renders in its own
// web process, through WebKit site isolation and a per-card host, so the
// app's window keeps answering and its other cards keep running.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { projectId, rpc, world } from "../fixtures";

const w = world();
const workspaceId = () => rpc<{ id: string }[]>(w, "workspace.list", {})[0].id;
const mode = (label: string) => $(`//div[@role="group"][@aria-label="Mode"]/button[starts-with(@aria-label, "${label}")]`);
const SLUG = "looping-kit";
const [LOOPING, PING, PONG] = ["moonlet-e2e-looping", "moonlet-e2e-ping", "moonlet-e2e-pong"];
const head = '<!doctype html>\n<html><head><meta charset="utf-8"><link rel="stylesheet" href="../../../styles.css"></head>\n';
const FILES: [string, string][] = [
  ["styles.css", ".calm { color: #e6e6e6; }\n"],
  // It answers the window's ping, while it runs.
  [
    "components/custom/calm/calm.html",
    `<!-- @dsCard group="Custom" name="Calm" -->\n${head}<body><section data-snippet="custom/calm/default"><p class="calm">Calm</p></section><script>addEventListener("message", (e) => { if (e.data === "${PING}") parent.postMessage("${PONG}", "*"); });</script></body></html>\n`,
  ],
  // It tells the window it started, then never stops.
  [
    "components/custom/loop/loop.html",
    `<!-- @dsCard group="Custom" name="Loop" -->\n${head}<body><section data-snippet="custom/loop/default"><p>Loop</p></section><script>parent.postMessage("${LOOPING}", "*"); for (;;) {}</script></body></html>\n`,
  ],
];

type Heard = { heard?: string[] };

/** `p`'s value, or "timed out" when it takes longer than `ms`. */
const within = <T>(ms: number, p: Promise<T>) => Promise.race([p, new Promise<"timed out">((r) => setTimeout(() => r("timed out"), ms))]);

describe("A design card that never stops running", () => {
  before(async () => {
    // The app keeps its mode and system across runs: start where no card shows.
    if (await mode("Sessions").isExisting()) await mode("Sessions").click();
    const ws = workspaceId();
    rpc(w, "design.system.create", { workspace: ws, name: "Looping kit", sources: [{ project: projectId(w) }], agent: false });
    const dir = join(w.home, "design", "library", "systems", SLUG);
    for (const [path, text] of FILES) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  });

  after(async () => {
    rpc(w, "design.system.remove", { workspace: workspaceId(), slug: SLUG });
    // A window that froze never answers; leave it rather than hang here.
    await within(5_000, (async () => {
      if (await mode("Sessions").isExisting()) await mode("Sessions").click();
    })());
  });

  it("leaves the app's window answering", async () => {
    // What the cards post to the window.
    await browser.execute(() => {
      const win = window as unknown as Heard;
      win.heard = [];
      window.addEventListener("message", (e) => {
        if (typeof e.data === "string" && e.data.startsWith("moonlet-e2e-")) win.heard?.push(e.data);
      });
    });
    // The window may open the system by itself, so its cards can start before
    // the click: each step has its own time.
    await mode("Design").click();
    const opened = await within(10_000, $('//nav[@aria-label="Design systems"]//button[.//span[normalize-space()="Looping kit"]]').click());
    expect(opened).not.toBe("timed out");
    // Until the looping card has started, the window answers each look within 2 s.
    let heard: string[] | "timed out" = [];
    for (const until = Date.now() + 10_000; Date.now() < until; await browser.pause(100)) {
      heard = await within(2_000, browser.execute(() => (window as unknown as Heard).heard ?? []));
      if (heard === "timed out" || heard.includes(LOOPING)) break;
    }
    // The window answered, and the card did start its loop.
    expect(heard).toContain(LOOPING);
  });

  it("leaves the other cards running", async () => {
    await expect($('//iframe[@title="Loop"]')).toBeExisting();
    // Asked right after the loop started, and again every 200 ms: the window
    // may be hidden (a locked screen, other windows over it), and WebKit then
    // suspends a frame's web process about 2 s after it loads, looping card or
    // not. A calm card in the looping card's process never answers at all.
    await browser.waitUntil(
      () =>
        browser.execute(
          (ping: string, pong: string) => {
            (document.querySelector('iframe[title="Calm"]') as HTMLIFrameElement | null)?.contentWindow?.postMessage(ping, "*");
            return ((window as unknown as Heard).heard ?? []).includes(pong);
          },
          PING,
          PONG,
        ),
      { timeout: 3_000, interval: 200, timeoutMsg: "the calm card did not answer while the other one loops" },
    );
  });

  it("leaves the app's controls working", async () => {
    const clicked = await within(5_000, mode("Sessions").click());
    expect(clicked).not.toBe("timed out");
    await expect(mode("Sessions")).toHaveAttribute("aria-pressed", "true");
  });
});

// A card whose page scrolls inside itself (a chat log, a long list) gives
// WebKit's scrolling tree nodes from the card's own process: layers clipped
// by the scroller, and layers that stay put while it scrolls. On macOS
// 27.0.1, a card's frame let go with such nodes in it crashed the whole app
// (WebKit bugs 321051 and 325098, ADR 0013).
describe("A design card that scrolls inside itself", () => {
  const SCROLLS = "scrolling-kit";
  const SCROLLED = "moonlet-e2e-scrolled";
  // Modelled on WebKit's own test of that crash: html and body scroll, and a
  // composited layer is clipped inside them; another scroller holds a
  // composited layer whose containing block is outside it.
  const card = `<!-- @dsCard group="Custom" name="Scroller" -->
${head}<body><style>
html, body { margin: 0; height: 100%; overflow: hidden auto; }
body { position: relative; }
.clipper { position: relative; overflow: hidden; width: 200px; height: 100px; border-radius: 8px; }
.banner { position: absolute; top: 10px; width: 150px; height: 50px; background: green; will-change: transform; }
.outer { position: relative; }
.inner { overflow: auto; height: 80px; }
.pinned { position: absolute; top: 0; width: 40px; height: 20px; background: red; will-change: transform; }
</style><section data-snippet="custom/scroller/default">
<div class="clipper"><div class="banner"></div></div><div class="clipper"><div class="banner"></div></div>
<div class="outer"><div class="inner"><div class="pinned"></div><div style="height: 400px"></div></div></div>
<div style="height: 3000px"></div></section>
<script>addEventListener("load", () => { document.body.scrollTop = 400; requestAnimationFrame(() => requestAnimationFrame(() => parent.postMessage("${SCROLLED}", "*"))); });</script></body></html>
`;

  before(async () => {
    if (await mode("Sessions").isExisting()) await mode("Sessions").click();
    rpc(w, "design.system.create", { workspace: workspaceId(), name: "Scrolling kit", sources: [{ project: projectId(w) }], agent: false });
    const dir = join(w.home, "design", "library", "systems", SCROLLS);
    mkdirSync(join(dir, "components", "custom", "scroller"), { recursive: true });
    writeFileSync(join(dir, "styles.css"), "");
    writeFileSync(join(dir, "components", "custom", "scroller", "scroller.html"), card);
  });

  after(async () => {
    rpc(w, "design.system.remove", { workspace: workspaceId(), slug: SCROLLS });
    await within(5_000, (async () => {
      if (await mode("Sessions").isExisting()) await mode("Sessions").click();
    })());
  });

  it("leaves the app running once its frame is let go, again and again, when the window shows", async function () {
    // A hidden window draws nothing: the card never scrolls on screen, and
    // WebKit has no layers of it to get wrong.
    if ((await browser.execute(() => document.visibilityState)) !== "visible") return this.skip();
    await browser.execute(() => {
      const win = window as unknown as Heard;
      win.heard = [];
      window.addEventListener("message", (e) => {
        if (typeof e.data === "string" && e.data.startsWith("moonlet-e2e-")) win.heard?.push(e.data);
      });
    });
    for (let round = 1; round <= 5; round++) {
      await browser.execute(() => {
        (window as unknown as Heard).heard = [];
      });
      await mode("Design").click();
      await $('//nav[@aria-label="Design systems"]//button[.//span[normalize-space()="Scrolling kit"]]').click();
      await browser.waitUntil(() => browser.execute((m: string) => ((window as unknown as Heard).heard ?? []).includes(m), SCROLLED), {
        timeout: 10_000,
        timeoutMsg: `round ${round}: the card did not scroll`,
      });
      // Its file written again: the card loads in a frame of its own, and the
      // old frame is let go.
      await browser.execute(() => {
        (window as unknown as Heard).heard = [];
      });
      writeFileSync(join(w.home, "design", "library", "systems", SCROLLS, "components", "custom", "scroller", "scroller.html"), card + `<!-- round ${round} -->\n`);
      await browser.waitUntil(() => browser.execute((m: string) => ((window as unknown as Heard).heard ?? []).includes(m), SCROLLED), {
        timeout: 10_000,
        timeoutMsg: `round ${round}: the card written again did not scroll`,
      });
      // Let the scrolled card's layers reach the window, then let its frame go.
      await browser.pause(300);
      await mode("Sessions").click();
      await browser.pause(500);
      // A crashed app answers nothing at all.
      expect(await within(5_000, browser.execute(() => document.title.length >= 0))).toBe(true);
    }
  });
});

// Each card's own process costs memory, so only the cards on screen or near
// it have a frame: a system of many cards starts a few processes, not one each.
describe("A design system with more cards than a screen shows", () => {
  const MANY = "many-kit";
  const N = 40;
  const name = (i: number) => `Card ${String(i).padStart(2, "0")}`;
  const frame = (i: number) => $(`//iframe[@title="${name(i)}"]`);
  const frames = () => browser.execute(() => document.querySelectorAll('section[aria-label="Custom"] iframe').length);

  before(async () => {
    if (await mode("Sessions").isExisting()) await mode("Sessions").click();
    const ws = workspaceId();
    rpc(w, "design.system.create", { workspace: ws, name: "Many kit", sources: [{ project: projectId(w) }], agent: false });
    const dir = join(w.home, "design", "library", "systems", MANY);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "styles.css"), ".c { color: #e6e6e6; }\n");
    for (let i = 1; i <= N; i++) {
      const slug = `card-${i}`;
      const path = join(dir, "components", "custom", slug, `${slug}.html`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `<!-- @dsCard group="Custom" name="${name(i)}" viewport="400x300" -->\n${head}<body><section data-snippet="custom/${slug}/default"><p class="c">${name(i)}</p></section></body></html>\n`);
    }
  });

  after(async () => {
    rpc(w, "design.system.remove", { workspace: workspaceId(), slug: MANY });
    if (await mode("Sessions").isExisting()) await mode("Sessions").click();
  });

  it("frames only the cards on screen or near it", async () => {
    await mode("Design").click();
    await $('//nav[@aria-label="Design systems"]//button[.//span[normalize-space()="Many kit"]]').click();
    await expect($(`//button[@aria-label="${name(N)}"]`)).toBeExisting();
    await expect(frame(1)).toBeExisting();
    expect(await frames()).toBeGreaterThan(0);
    expect(await frames()).toBeLessThan(N);
  });

  it("frames a card once it is scrolled to, and lets go of one scrolled far away", async () => {
    await browser.execute((last: string) => document.querySelector(`button[aria-label="${last}"]`)?.scrollIntoView({ block: "end" }), name(N));
    await expect(frame(N)).toBeExisting();
    await expect(frame(1)).not.toBeExisting();
    expect(await frames()).toBeLessThan(N);
  });
});
