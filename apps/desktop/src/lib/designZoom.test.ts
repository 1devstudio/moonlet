import { describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { asksZoom, zoomMessage } from "./designZoom";
import zoom from "../../src-tauri/src/design_zoom.js?raw";

/** A page as the scheme serves it: the zoom script first in its <head>, in
 *  a frame whose parent is the app's window, its viewport `width`×`height`
 *  (the frame's size, which is the zoomed size once zoomed). */
function framed(html: string, [width, height] = [780, 1688]) {
  const posted: unknown[] = [];
  const app = new JSDOM("").window;
  app.postMessage = ((m: unknown) => void posted.push(m)) as typeof app.postMessage;
  const dom = new JSDOM(`<!doctype html><html><head><script>${zoom}</script>${html}</html>`, {
    runScripts: "dangerously",
    beforeParse: (w) => {
      Object.defineProperty(w, "parent", { value: app });
      Object.defineProperty(w, "innerWidth", { configurable: true, get: () => width });
      Object.defineProperty(w, "innerHeight", { configurable: true, get: () => height });
      // WebKit's matchMedia, for min-width in px: against the frame's width.
      w.matchMedia = (q: string) => ({ media: q, matches: Number(/^\(min-width: (\d+(?:\.\d+)?)px\)$/.exec(q)?.[1] ?? Infinity) <= width }) as MediaQueryList;
    },
  });
  const win = dom.window;
  const doc = win.document;
  /** A message from the app, or (`from`) another window. */
  const tell = (data: unknown, from: unknown = app) => win.dispatchEvent(new win.MessageEvent("message", { data, source: from as Window }));
  return { win, doc, tell, posted };
}

describe("the zoom script in a page (X110)", () => {
  it("asks the app for the zoom when it starts", () => {
    const { posted } = framed("<body></body>");
    expect(posted).toEqual(["moonlet:zoom?"]);
  });

  it("takes the zoom only from the app's window, and only a number from 1 to 4", () => {
    // JSDOM has no CSS zoom: the window's size the page reads tells it.
    const { win, tell } = framed("<body></body>");
    tell(zoomMessage(2, [390, 844]), new JSDOM("").window);
    expect(win.innerWidth).toBe(780);
    for (const bad of ["moonlet:zoom=9,390x844", "moonlet:zoom=0.5,390x844", "moonlet:zoom=2px,390x844", "moonlet:zoom=2,0x844", "moonlet:zoom=2,390x-1", "moonlet:zoom=2,390.5x844", "moonlet:zoom=2,390x100000", "moonlet:zoom=2", { zoom: 2 }]) tell(bad);
    expect(win.innerWidth).toBe(780);
    // The viewport the app gives, even before the frame has its new size.
    tell("moonlet:zoom=2,390x844");
    expect([win.innerWidth, win.innerHeight]).toEqual([390, 844]);
    tell(zoomMessage(1, [780, 1688]));
    expect([win.innerWidth, win.innerHeight]).toEqual([780, 1688]);
  });

  it("matches the breakpoints of its stylesheets at the viewport, and puts them back at 100%", () => {
    const { doc, tell } = framed(
      `<style>@media (min-width: 600px) { .wide { color: red; } } @media screen and (min-width: 20em) and (max-width: 1000.5px) { .mid { color: blue; } } @media (orientation: portrait) { .p { color: green; } }</style><style media="(max-width: 400px)">.narrow { color: red; }</style></head><body></body>`,
    );
    const media = () => {
      const [a, b] = [...doc.styleSheets];
      return [...[...a.cssRules].map((r) => (r as CSSMediaRule).media.mediaText), b.media.mediaText];
    };
    const written = ["(min-width: 600px)", "screen and (min-width: 20em) and (max-width: 1000.5px)", "(orientation: portrait)", "(max-width: 400px)"];
    expect(media()).toEqual(written);
    tell(zoomMessage(2, [390, 844]));
    expect(media()).toEqual(["(min-width: 1200px)", "screen and (min-width: 640px) and (max-width: 2001px)", "(orientation: portrait)", "(max-width: 800px)"]);
    tell(zoomMessage(1.5, [390, 844]));
    expect(media()).toEqual(["(min-width: 900px)", "screen and (min-width: 480px) and (max-width: 1500.75px)", "(orientation: portrait)", "(max-width: 600px)"]);
    tell(zoomMessage(1, [390, 844]));
    expect(media()).toEqual(written);
  });

  it("sizes vw, vh, vmin and vmax at the viewport, in its stylesheets and style attributes, and puts them back at 100%", () => {
    const { doc, tell } = framed(
      `<style>.half { width: 50vw; --gap: 3vh; } @media (min-width: 1px) { .tall { height: 100dvh !important; margin: 10vmin 1vmax; } }</style></head><body><div id="a" style="width: 10vw; color: red"></div></body>`,
    );
    const sheet = doc.styleSheets[0];
    const half = (sheet.cssRules[0] as CSSStyleRule).style;
    const tall = ((sheet.cssRules[1] as CSSMediaRule).cssRules[0] as CSSStyleRule).style;
    const a = (doc.getElementById("a") as HTMLElement).style;
    const values = () => [half.getPropertyValue("width"), half.getPropertyValue("--gap").trim(), tall.getPropertyValue("height"), tall.getPropertyPriority("height"), tall.getPropertyValue("margin-top"), tall.getPropertyValue("margin-right"), a.getPropertyValue("width"), a.getPropertyValue("color")];
    expect(values()).toEqual(["50vw", "3vh", "100dvh", "important", "10vmin", "1vmax", "10vw", "red"]);
    // The viewport is 390×844 at 200%.
    tell(zoomMessage(2, [390, 844]));
    expect(values()).toEqual(["195px", "25.32px", "844px", "important", "39px", "8.44px", "39px", "red"]);
    tell(zoomMessage(1, [390, 844]));
    expect(values()).toEqual(["50vw", "3vh", "100dvh", "important", "10vmin", "1vmax", "10vw", "red"]);
  });

  it("sizes a style the page or the bridge sets while zoomed, and a stylesheet it adds, at the viewport, and again when the viewport changes", async () => {
    const { win, doc, tell } = framed(`</head><body><div id="a"></div></body>`);
    const a = doc.getElementById("a") as HTMLElement;
    tell(zoomMessage(2, [390, 844]));
    a.setAttribute("style", "width: 20vw");
    await vi.waitFor(() => expect(a.style.getPropertyValue("width")).toBe("78px"));
    a.style.setProperty("height", "50vh");
    await vi.waitFor(() => expect(a.style.getPropertyValue("height")).toBe("422px"));
    doc.head.append(Object.assign(doc.createElement("style"), { textContent: ".b { width: 10vw; }" }));
    const b = () => (doc.styleSheets[0].cssRules[0] as CSSStyleRule).style.getPropertyValue("width");
    await vi.waitFor(() => expect(b()).toBe("39px"));
    // The Tablet viewport, 834×1112, at 200%.
    tell(zoomMessage(2, [834, 1112]));
    expect([a.style.getPropertyValue("width"), b(), win.innerWidth]).toEqual(["166.8px", "83.4px", 834]);
    tell(zoomMessage(1, [390, 844]));
    expect([a.style.getPropertyValue("width"), a.style.getPropertyValue("height"), b()]).toEqual(["20vw", "50vh", "10vw"]);
  });

  it("matches matchMedia's queries at the viewport while zoomed", () => {
    const { win, tell } = framed("</head><body></body>");
    const matches = () => ["(min-width: 600px)", "(min-width: 300px)"].map((q) => win.matchMedia(q).matches);
    // The frame is 780 px wide: at 100% the page's viewport.
    expect(matches()).toEqual([true, true]);
    tell(zoomMessage(2, [390, 844]));
    expect(matches()).toEqual([false, true]);
    expect(win.matchMedia("(min-width: 600px)").media).toBe("(min-width: 600px)");
  });
});

describe("the zoom script, as the page changes (X110)", () => {
  it("corrects the media of a stylesheet whose rules it cannot read", () => {
    const { doc, win, tell } = framed(`<style media="(min-width: 600px)">.a { color: red; }</style></head><body></body>`);
    // As a linked stylesheet of the host reads to a sandboxed page.
    Object.defineProperty(doc.styleSheets[0], "cssRules", { get: () => { throw new win.DOMException("cross-origin", "SecurityError"); } });
    tell(zoomMessage(2, [390, 844]));
    expect(doc.styleSheets[0].media.mediaText).toBe("(min-width: 1200px)");
    tell(zoomMessage(1, [390, 844]));
    expect(doc.styleSheets[0].media.mediaText).toBe("(min-width: 600px)");
  });

  it("takes a rule or a media query the page changed through the CSSOM as the page wrote it", () => {
    const { doc, tell } = framed(`<style>.a { width: 10vw; } @media (min-width: 600px) { .b { color: red; } }</style></head><body></body>`);
    const [a, b] = [...doc.styleSheets[0].cssRules] as [CSSStyleRule, CSSMediaRule];
    tell(zoomMessage(2, [390, 844]));
    tell(zoomMessage(1, [390, 844]));
    a.style.setProperty("width", "20vw");
    b.media.mediaText = "(min-width: 500px)";
    tell(zoomMessage(2, [390, 844]));
    expect([a.style.getPropertyValue("width"), b.media.mediaText]).toEqual(["78px", "(min-width: 1000px)"]);
    tell(zoomMessage(1, [390, 844]));
    expect([a.style.getPropertyValue("width"), b.media.mediaText]).toEqual(["20vw", "(min-width: 500px)"]);
  });

  it("sizes viewport units on the page's root element too", () => {
    const { doc, tell } = framed(`<script>document.documentElement.style.setProperty("width", "100vw")</script></head><body></body>`);
    tell(zoomMessage(2, [390, 844]));
    expect(doc.documentElement.style.getPropertyValue("width")).toBe("390px");
    tell(zoomMessage(1, [390, 844]));
    expect(doc.documentElement.style.getPropertyValue("width")).toBe("100vw");
  });

  it("answers a matchMedia list made at one zoom as at the viewport after the zoom changes", () => {
    const { win, tell } = framed("</head><body></body>");
    tell(zoomMessage(2, [390, 844]));
    const wide = win.matchMedia("(min-width: 600px)");
    expect(wide.matches).toBe(false);
    // Back at 100%, the 780 px frame is the viewport.
    tell(zoomMessage(1, [780, 1688]));
    expect(wide.matches).toBe(true);
  });

  it("tells the page's resize listeners once the zoom changes the viewport it reads", () => {
    const { win, tell } = framed(`<script>window.seen = []; addEventListener("resize", () => window.seen.push(innerWidth));</script></head><body></body>`);
    tell(zoomMessage(2, [390, 844]));
    tell(zoomMessage(1, [780, 1688]));
    expect((win as unknown as { seen: number[] }).seen).toEqual([390, 780]);
  });
});

describe("the zoom's messages (X110)", () => {
  it("takes the zoom script's ask only from the frame's own window", () => {
    const frame = new JSDOM("").window as unknown as Window;
    expect(asksZoom({ source: frame, data: "moonlet:zoom?" }, frame)).toBe(true);
    expect(asksZoom({ source: new JSDOM("").window as unknown as Window, data: "moonlet:zoom?" }, frame)).toBe(false);
    expect(asksZoom({ source: frame, data: "moonlet:released" }, frame)).toBe(false);
    expect(asksZoom({ source: null, data: "moonlet:zoom?" }, null)).toBe(false);
  });

  it("tells the page its zoom and its viewport", () => {
    expect(zoomMessage(1.5, [1440, 900])).toBe("moonlet:zoom=1.5,1440x900");
    expect(zoomMessage(1, [390, 844])).toBe("moonlet:zoom=1,390x844");
    // A viewport in whole px, as the page takes it.
    expect(zoomMessage(2, [390.4, 844.6])).toBe("moonlet:zoom=2,390x845");
  });
});
