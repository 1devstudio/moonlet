import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FRAME_ATTR, holdFramesOnRemove } from "./frameRelease";

/** A design frame in a box, in a parent React removes the box from, and
 *  the messages the frame's page is sent. The page stands in for the frame's
 *  window: in WebKit it is in a web process of its own. */
function framed() {
  const parent = document.createElement("div");
  const box = document.createElement("div");
  const frame = document.createElement("iframe");
  frame.setAttribute(FRAME_ATTR, "");
  const got: unknown[] = [];
  const page = { postMessage: (data: unknown) => got.push(data) };
  Object.defineProperty(frame, "contentWindow", { get: () => page });
  box.append(frame);
  parent.append(box);
  document.body.append(parent);
  return { parent, box, frame, got, page };
}

/** `page` saying it was drawn cleared. */
const released = (page: object) => {
  const e = new MessageEvent("message", { data: "moonlet:released" });
  Object.defineProperty(e, "source", { value: page });
  window.dispatchEvent(e);
};

/** The window shown or hidden, as the browser tells the page. */
function shown(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("removing a design frame (ADR 0013)", () => {
  beforeAll(() => holdFramesOnRemove(window));
  afterEach(() => {
    vi.useRealTimers();
    shown("visible");
    document.body.replaceChildren();
  });

  it("keeps the box where it is, unseen, asks the frame's page to clear itself, and removes the box once the page says it did", () => {
    const { parent, box, got, page } = framed();
    expect(parent.removeChild(box)).toBe(box);
    expect(box.parentNode).toBe(parent);
    // Unseen, out of the way of the pointer, the keyboard and the layout.
    expect(box.style.opacity).toBe("0");
    expect(box.hasAttribute("inert")).toBe(true);
    expect(box.getAttribute("aria-hidden")).toBe("true");
    expect(box.style.position).toBe("absolute");
    expect(got).toEqual(["moonlet:release"]);
    released(page);
    expect(box.isConnected).toBe(false);
  });

  it("removes a box only once every frame in it said its page cleared", () => {
    const { parent, box, page } = framed();
    const other = framed();
    box.append(other.frame);
    parent.removeChild(box);
    released(page);
    expect(box.isConnected).toBe(true);
    released(other.page);
    expect(box.isConnected).toBe(false);
  });

  it("removes a box whose page never answers a second after the window shows, and never while it is hidden", () => {
    vi.useFakeTimers();
    shown("hidden");
    const { parent, box } = framed();
    parent.removeChild(box);
    vi.advanceTimersByTime(5_000);
    expect(box.isConnected).toBe(true);
    shown("visible");
    vi.advanceTimersByTime(900);
    expect(box.isConnected).toBe(true);
    vi.advanceTimersByTime(100);
    expect(box.isConnected).toBe(false);
  });

  it("asks a page that loads while its box is held to clear itself too", () => {
    const { parent, box, frame, got, page } = framed();
    parent.removeChild(box);
    frame.dispatchEvent(new Event("load"));
    expect(got).toEqual(["moonlet:release", "moonlet:release"]);
    released(page);
    expect(box.isConnected).toBe(false);
  });

  it("removes anything without a design frame at once", () => {
    const parent = document.createElement("div");
    const plain = document.createElement("iframe");
    parent.append(plain);
    document.body.append(parent);
    expect(parent.removeChild(plain)).toBe(plain);
    expect(plain.isConnected).toBe(false);
  });
});
