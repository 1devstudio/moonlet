import { describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { bridgeMessage, modeMessage, pinsMessage } from "./designBridge";
import bridge from "../../src-tauri/src/design_bridge.js?raw";

describe("the bridge's messages (X65)", () => {
  it("takes a pick with its element's data-mid, tag, text and box", () => {
    expect(bridgeMessage({ type: "bridge.pick", mid: "m12", tag: "nav", text: "General Appearance", rect: { x: 0, y: 64.5, w: 390, h: 40 } })).toEqual({
      type: "pick",
      element: { mid: "m12", tag: "nav", text: "General Appearance", rect: { x: 0, y: 64.5, w: 390, h: 40 } },
    });
  });

  it("cuts the text to 60 characters on one line, and drops a pick whose data-mid, tag or box is not one", () => {
    const pick = { type: "bridge.pick", mid: "m30", tag: "P", text: "  Branch prefix\n   New sessions get a branch and a worktree, named after the session  ", rect: { x: 1, y: 2, w: 3, h: 4 } };
    expect(bridgeMessage(pick)).toEqual({
      type: "pick",
      element: { mid: "m30", tag: "p", text: "Branch prefix New sessions get a branch and a worktree, name", rect: { x: 1, y: 2, w: 3, h: 4 } },
    });
    expect(bridgeMessage({ ...pick, mid: 'm30"] (nav "x"): rm -rf' })).toBeNull();
    expect(bridgeMessage({ ...pick, mid: "M30" })).toBeNull();
    expect(bridgeMessage({ ...pick, tag: "p onclick" })).toBeNull();
    expect(bridgeMessage({ ...pick, rect: { x: 1, y: 2, w: Infinity, h: 4 } })).toBeNull();
    expect(bridgeMessage({ ...pick, rect: { x: "1", y: 2, w: 3, h: 4 } })).toBeNull();
  });

  it("takes the page's ids, the boxes of the pinned elements, and C and Esc", () => {
    expect(bridgeMessage({ type: "bridge.mids", mids: ["m1", "m2", "m12"] })).toEqual({ type: "mids", mids: ["m1", "m2", "m12"] });
    expect(bridgeMessage({ type: "bridge.mids", mids: ["m1", "x"] })).toBeNull();
    expect(bridgeMessage({ type: "bridge.rects", rects: [{ mid: "m12", x: 0, y: -20, w: 390, h: 40 }] })).toEqual({ type: "rects", rects: [{ mid: "m12", x: 0, y: -20, w: 390, h: 40 }] });
    expect(bridgeMessage({ type: "bridge.rects", rects: [{ mid: "m12", x: 0, y: 0, w: -1, h: 40 }] })).toBeNull();
    expect(bridgeMessage({ type: "bridge.key", key: "c" })).toEqual({ type: "key", key: "c" });
    expect(bridgeMessage({ type: "bridge.key", key: "Delete" })).toBeNull();
  });

  it("tells the page its mode, and the pinned elements once each", () => {
    expect(modeMessage("comment")).toEqual({ type: "bridge.mode", mode: "comment" });
    expect(pinsMessage(["m12", "m25", "m12", "", "x"])).toEqual({ type: "bridge.pins", mids: ["m12", "m25"] });
  });

  it("drops a message of an unknown type, or that is not an object", () => {
    expect(bridgeMessage({ type: "bridge.save", html: "<p>" })).toBeNull();
    expect(bridgeMessage({ type: "moonlet-render", job: "7" })).toBeNull();
    expect(bridgeMessage("bridge.pick")).toBeNull();
    expect(bridgeMessage(null)).toBeNull();
  });
});

/** A page as the scheme serves it to the canvas: the bridge first in its
 *  <head>, parsed as a browser parses it, in a frame whose parent is the
 *  app's window; and what it posts to the app, copied as postMessage copies. */
function framed(body: string) {
  const posted: unknown[] = [];
  const app = new JSDOM("").window;
  app.postMessage = ((m: unknown) => void posted.push(JSON.parse(JSON.stringify(m)))) as typeof app.postMessage;
  const dom = new JSDOM(`<!doctype html><html><head><script>${bridge}</script></head><body data-mid="m1">${body}</body></html>`, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse: (w) => void Object.defineProperty(w, "parent", { value: app }),
  });
  const win = dom.window;
  const doc = win.document;
  const el = (mid: string) => doc.querySelector(`[data-mid="${mid}"]`) as HTMLElement;
  /** Gives the element its box in the page's viewport. */
  const place = (mid: string, x: number, y: number, w: number, h: number) => {
    el(mid).getBoundingClientRect = () => ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON: () => ({}) }) as DOMRect;
  };
  /** A message from the app, or (`from`) another window. */
  const tell = (data: unknown, from: unknown = app) => win.dispatchEvent(new win.MessageEvent("message", { data, source: from as Window }));
  return { win, doc, el, place, tell, posted };
}

describe("the bridge script in a page (X65)", () => {
  it("reports the page's data-mids once it has loaded", async () => {
    const { posted } = framed('<nav data-mid="m12"><a data-mid="m13">General</a></nav><script>document.body.append(Object.assign(document.createElement("p"), {}))</script><h2 data-mid="m25">Git</h2>');
    await vi.waitFor(() => expect(posted).toContainEqual({ type: "bridge.mids", mids: ["m1", "m12", "m13", "m25"] }));
  });

  const NAV = '<nav data-mid="m12"><a href="#git" data-mid="m13">General <b data-mid="m14">Appearance</b></a></nav><h2 data-mid="m25">Git</h2>';
  const mouse = (win: Window, type: string, on: Element, init: MouseEventInit = {}) => on.dispatchEvent(new (win as typeof window).MouseEvent(type, { bubbles: true, cancelable: true, ...init }));

  it("in Comment mode, outlines the element under the pointer inside the page, and nothing in View", () => {
    const { win, doc, el, place, tell } = framed(NAV);
    place("m13", 16, 64, 120, 28);
    const outline = () => doc.querySelector("[data-moonlet-bridge]") as HTMLElement | null;
    mouse(win, "mouseover", el("m13"));
    expect(outline()).toBeNull();
    tell({ type: "bridge.mode", mode: "comment" });
    mouse(win, "mousemove", el("m13"));
    expect(outline()?.style.display).toBe("block");
    expect([outline()?.style.left, outline()?.style.top, outline()?.style.width, outline()?.style.height]).toEqual(["16px", "64px", "120px", "28px"]);
    // Outside the body: never one of the page's elements.
    expect(doc.body.contains(outline())).toBe(false);
    tell({ type: "bridge.mode", mode: "view" });
    expect(outline()?.style.display).toBe("none");
  });

  it("in Comment mode, reports a click's element instead of giving the page the click, and ⌥-click its parent", () => {
    const { win, el, place, tell, posted } = framed(NAV);
    place("m13", 16, 64, 120, 28);
    place("m12", 0, 56, 390, 44);
    let clicked = 0;
    el("m13").addEventListener("click", () => clicked++);
    tell({ type: "bridge.mode", mode: "comment" });
    mouse(win, "click", el("m13"));
    mouse(win, "click", el("m13"), { altKey: true });
    expect(posted.filter((m) => (m as { type: string }).type === "bridge.pick")).toEqual([
      { type: "bridge.pick", mid: "m13", tag: "a", text: "General Appearance", rect: { x: 16, y: 64, w: 120, h: 28 } },
      { type: "bridge.pick", mid: "m12", tag: "nav", text: "General Appearance", rect: { x: 0, y: 56, w: 390, h: 44 } },
    ]);
    expect(clicked).toBe(0);
    // In View the page has its clicks, and nothing is reported.
    tell({ type: "bridge.mode", mode: "view" });
    mouse(win, "click", el("m13"));
    expect(clicked).toBe(1);
    expect(posted.filter((m) => (m as { type: string }).type === "bridge.pick")).toHaveLength(2);
  });

  it("reports the boxes of the pinned elements when asked, and again on scroll and resize", async () => {
    const { win, place, tell, posted } = framed(NAV);
    place("m12", 0, 56, 390, 44);
    place("m25", 0, 300, 390, 30);
    tell({ type: "bridge.pins", mids: ["m12", "m25", "m99", 'm1"]'] });
    expect(posted.at(-1)).toEqual({
      type: "bridge.rects",
      rects: [
        { mid: "m12", x: 0, y: 56, w: 390, h: 44 },
        { mid: "m25", x: 0, y: 300, w: 390, h: 30 },
      ],
    });
    place("m25", 0, 180, 390, 30);
    win.dispatchEvent(new win.Event("scroll"));
    await vi.waitFor(() => expect(posted.at(-1)).toEqual({ type: "bridge.rects", rects: [{ mid: "m12", x: 0, y: 56, w: 390, h: 44 }, { mid: "m25", x: 0, y: 180, w: 390, h: 30 }] }));
    place("m12", 0, 40, 600, 44);
    win.dispatchEvent(new win.Event("resize"));
    await vi.waitFor(() => expect(posted.at(-1)).toEqual({ type: "bridge.rects", rects: [{ mid: "m12", x: 0, y: 40, w: 600, h: 44 }, { mid: "m25", x: 0, y: 180, w: 390, h: 30 }] }));
  });

  it("takes messages only from the app's window, never from the page's own scripts", async () => {
    const { win, el, tell, posted } = framed(NAV);
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    tell({ type: "bridge.mode", mode: "comment" }, win);
    tell({ type: "bridge.pins", mids: ["m12"] }, win);
    mouse(win, "click", el("m13"));
    expect(posted.map((m) => (m as { type: string }).type)).toEqual(["bridge.mids"]);
  });

  it("reports C and Esc pressed in the page, but not C typed in a field", () => {
    const { win, doc, posted } = framed('<input data-mid="m5">');
    const key = (on: Element, init: KeyboardEventInit) => on.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, ...init }));
    key(doc.body, { key: "c" });
    key(doc.body, { key: "c", metaKey: true });
    key(doc.querySelector("input")!, { key: "c" });
    key(doc.querySelector("input")!, { key: "Escape" });
    expect(posted.filter((m) => (m as { type: string }).type === "bridge.key")).toEqual([
      { type: "bridge.key", key: "c" },
      { type: "bridge.key", key: "Escape" },
    ]);
  });
});
