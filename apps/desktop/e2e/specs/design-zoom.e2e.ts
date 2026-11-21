// Sharp zoom (X110): above 100% a design's page draws itself at the zoom, in
// a frame of the zoomed size, and still lays out at its viewport: its
// breakpoints, inline and linked, its vw, the window size and matchMedia
// are the viewport's; and a pin sits on its element. Sharpness itself is a
// check by hand: WebKit's own snapshot redraws the page, so a shot cannot
// show the blur.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { rpc, world } from "../fixtures";

const w = world();
const workspaceId = () => rpc<{ id: string }[]>(w, "workspace.list", {})[0].id;
const mode = (label: string) => $(`//div[@role="group"][@aria-label="Mode"]/button[starts-with(@aria-label, "${label}")]`);
const SYSTEM = "zoom-kit";
const dir = () => join(w.home, "design", workspaceId(), "designs", "zoom-page");
// What the page sees, posted to the app's window when it asks.
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="../../../systems/${SYSTEM}/styles.css"><style>
body { margin: 0; }
.box { position: absolute; left: 10px; top: 200px; width: 100px; height: 50px; }
.inline { color: rgb(0, 0, 255); }
@media (min-width: 600px) { .inline { color: rgb(255, 0, 0); } }
.half { width: 50vw; height: 2px; }
</style></head>
<body data-mid="m1"><div class="box inline" data-mid="m2">Box</div><p class="linked" data-mid="m3">Linked</p><div class="half" data-mid="m4"></div><p class="added" data-mid="m5">Added</p>
<script>
addEventListener("message", (e) => {
  if (e.data === "e2e-link") document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: "../../../systems/${SYSTEM}/more.css" }));
  if (e.data !== "e2e-measure") return;
  const box = document.querySelector(".box").getBoundingClientRect();
  parent.postMessage({ e2eZoom: {
    innerWidth, wide: matchMedia("(min-width: 600px)").matches,
    inline: getComputedStyle(document.querySelector(".inline")).color,
    linked: getComputedStyle(document.querySelector(".linked")).color,
    added: getComputedStyle(document.querySelector(".added")).color,
    half: document.querySelector(".half").offsetWidth,
    boxInFrame: [box.left, box.top, box.width, box.height],
  } }, "*");
});
</script></body></html>
`;
const STYLES = ".linked { color: rgb(0, 128, 0); }\n@media (min-width: 600px) { .linked { color: rgb(255, 0, 0); } }\n";
// A stylesheet the page links while zoomed.
const MORE = ".added { color: rgb(128, 0, 128); }\n@media (min-width: 600px) { .added { color: rgb(255, 0, 0); } }\n";

const frame = () => $('//iframe[@title="index.html"]');
/** What the page reports it sees, asked again on every call: WebKit may
 *  hold a frame's web process a while when the window is hidden. */
async function measure(): Promise<string> {
  const last = await browser.execute(() => {
    const win = window as unknown as { e2eZoom: unknown };
    const seen = win.e2eZoom;
    win.e2eZoom = null;
    document.querySelector<HTMLIFrameElement>('iframe[title="index.html"]')!.contentWindow!.postMessage("e2e-measure", "*");
    return JSON.stringify(seen, seen ? Object.keys(seen as object).sort() : undefined) + (document.visibilityState === "hidden" ? " (window hidden)" : "");
  });
  return last;
}
/** Waits until the page reports `want`. */
async function sees(want: object, what: string) {
  let last = "";
  await browser.waitUntil(async () => (last = await measure()) === JSON.stringify(want, Object.keys(want).sort()), { timeout: 15_000, interval: 300, timeoutMsg: `${what} the page saw ${last}` }).catch(() => {
    throw new Error(`${what} the page saw ${last}`);
  });
}
const frameBox = () => browser.execute(() => {
  const r = document.querySelector('iframe[title="index.html"]')!.getBoundingClientRect();
  return [Math.round(r.width), Math.round(r.height)];
});
async function zoomTo(label: string) {
  const fit = $('//button[@title="Fit (⌘0)"]');
  const pct = async () => parseInt(await fit.getText(), 10);
  for (let i = 0; i < 10 && (await fit.getText()) !== label; i++) await $(`//button[@title="Zoom ${(await pct()) < parseInt(label, 10) ? "in (⌘=)" : "out (⌘-)"}"]`).click();
  await expect(fit).toHaveText(label);
}

describe("Sharp zoom", () => {
  before(async () => {
    const ws = workspaceId();
    rpc(w, "design.system.create", { workspace: ws, name: "Zoom kit", sources: [], agent: false });
    writeFileSync(join(w.home, "design", "library", "systems", SYSTEM, "styles.css"), STYLES);
    writeFileSync(join(w.home, "design", "library", "systems", SYSTEM, "more.css"), MORE);
    rpc(w, "design.create", { workspace: ws, name: "Zoom page", system: SYSTEM, brief: "One page" });
    mkdirSync(join(dir(), "pages"), { recursive: true });
    writeFileSync(join(dir(), "pages", "index.html"), PAGE);
    if (await mode("Sessions").isExisting()) await mode("Sessions").click();
    await mode("Design").click();
    await $('//nav[@aria-label="Designs"]//button[.//span[normalize-space()="Zoom page"]]').click();
    await $('//button[@aria-label="Viewport"]').click();
    await $('//button[starts-with(normalize-space(), "Phone")]').click();
    await expect(frame()).toBeExisting();
    await browser.execute(() => {
      const win = window as unknown as { e2eZoom: unknown };
      win.e2eZoom = null;
      addEventListener("message", (e) => e.data && e.data.e2eZoom && (win.e2eZoom = e.data.e2eZoom));
    });
  });

  after(async () => {
    for (const d of rpc<{ slug: string }[]>(w, "design.list", { workspace: workspaceId() })) rpc(w, "design.remove", { workspace: workspaceId(), slug: d.slug });
    rpc(w, "design.system.remove", { workspace: workspaceId(), slug: SYSTEM });
    if (await mode("Sessions").isExisting()) await mode("Sessions").click();
  });

  it("keeps a Phone page's layout at 200%, in a frame of the zoomed size where the page draws itself at 200%", async () => {
    await zoomTo("100%");
    expect(await frameBox()).toEqual([390, 844]);
    const at100 = { innerWidth: 390, wide: false, inline: "rgb(0, 0, 255)", linked: "rgb(0, 128, 0)", added: "rgb(0, 0, 0)", half: 195, boxInFrame: [10, 200, 100, 50] };
    await sees(at100, "at 100%");
    await zoomTo("200%");
    expect(await frameBox()).toEqual([780, 1688]);
    // The page's layout is the viewport's, and it is drawn twice as big in the frame.
    const at200 = { ...at100, boxInFrame: [20, 400, 200, 100] };
    await sees(at200, "at 200%");
    // A stylesheet linked while zoomed is corrected too, once it loads.
    await browser.execute(() => document.querySelector<HTMLIFrameElement>('iframe[title="index.html"]')!.contentWindow!.postMessage("e2e-link", "*"));
    const purple = { added: "rgb(128, 0, 128)" };
    await sees({ ...at200, ...purple }, "with a stylesheet linked at 200%");
    // Back at 100%, the page as it was written.
    await zoomTo("100%");
    expect(await frameBox()).toEqual([390, 844]);
    await sees({ ...at100, ...purple }, "back at 100%");
    // The page's file is as it was written.
    expect(readFileSync(join(dir(), "pages", "index.html"), "utf8")).toBe(PAGE);
  });

  it("puts a pin on its element at 200%", async () => {
    await zoomTo("200%");
    rpc(w, "design.comment.put", { workspace: workspaceId(), slug: "zoom-page", new: { page: "index", mid: "m2", tag: "div", text: "Box", comment: "Bigger" } });
    const pin = $('//button[@aria-label="Comment 1"]');
    await expect(pin).toBeDisplayed();
    // At the box's top right corner, the page's (110, 200), twice that in
    // the frame: pinPlace puts the pin's corner 10 px up and left of it.
    const corner = () => browser.execute(() => {
      const f = document.querySelector('iframe[title="index.html"]')!.getBoundingClientRect();
      const p = document.querySelector('button[aria-label="Comment 1"]')!.getBoundingClientRect();
      return [Math.round(p.left - f.left), Math.round(p.top - f.top)];
    });
    await browser.waitUntil(async () => JSON.stringify(await corner()) === "[210,390]", { timeout: 15_000, timeoutMsg: `the pin is at ${JSON.stringify(await corner())}` });
  });
});
