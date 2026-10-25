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
    const dir = join(w.home, "design", ws, "systems", SLUG);
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
    // Give the looping card time to load and start.
    await browser.pause(2_000);

    const heard = await within(2_000, browser.execute(() => (window as unknown as Heard).heard ?? []));
    // The window answered, and the card did start its loop.
    expect(heard).toContain(LOOPING);
  });

  it("leaves the other cards running", async () => {
    await expect($('//iframe[@title="Loop"]')).toBeExisting();
    await browser.execute((ping: string) => {
      (document.querySelector('iframe[title="Calm"]') as HTMLIFrameElement | null)?.contentWindow?.postMessage(ping, "*");
    }, PING);
    await browser.waitUntil(async () => (await browser.execute(() => (window as unknown as Heard).heard ?? [])).includes(PONG), {
      timeout: 3_000,
      timeoutMsg: "the calm card did not answer while the other one loops",
    });
  });

  it("leaves the app's controls working", async () => {
    const clicked = await within(5_000, mode("Sessions").click());
    expect(clicked).not.toBe("timed out");
    await expect(mode("Sessions")).toHaveAttribute("aria-pressed", "true");
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
    const dir = join(w.home, "design", ws, "systems", MANY);
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
