// The comment bridge (X65): messages between the design screen and the
// script the moonlet-design:// scheme puts in a page the canvas asks for
// (src-tauri/src/design_bridge.js). The page is on another origin, so they
// talk only through postMessage, and the app takes a message only from its
// own frame's window and only in a shape it knows.

/** A box in the page's viewport, in its CSS px. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The element a click in Comment mode picked. */
export interface PickedElement {
  mid: string;
  tag: string;
  /** Up to 60 characters of its text, on one line. */
  text: string;
  rect: Rect;
}

/** What the page tells the app. */
export type BridgeMessage =
  | { type: "mids"; mids: string[] }
  | { type: "pick"; element: PickedElement }
  | { type: "rects"; rects: ({ mid: string } & Rect)[] }
  | { type: "key"; key: "c" | "Escape" };

/** How much of an element's text a pin keeps, in characters. */
export const TEXT_MAX = 60;

/** A page's element id: `m` and digits. */
export function isMid(mid: unknown): mid is string {
  return typeof mid === "string" && /^m\d+$/.test(mid);
}

/** The most ids a page reports, so a page cannot flood the app. */
const MIDS_MAX = 20_000;

const num = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

function rectOf(r: unknown): Rect | null {
  if (typeof r !== "object" || r === null) return null;
  const { x, y, w, h } = r as Record<string, unknown>;
  return num(x) && num(y) && num(w) && num(h) && w >= 0 && h >= 0 ? { x, y, w, h } : null;
}

/** The element's text on one line, cut to {@link TEXT_MAX} characters. */
function textOf(t: unknown): string {
  return typeof t === "string" ? [...t.replace(/\s+/g, " ").trim()].slice(0, TEXT_MAX).join("") : "";
}

/** The message `data` from the page, checked; null when it is not one: an
 *  unknown type, a `data-mid` that is not `m` and digits, a tag that is not
 *  a tag's name, or a box that is not four numbers. Text is cut to 60
 *  characters. */
export function bridgeMessage(data: unknown): BridgeMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  switch (d.type) {
    case "bridge.mids":
      return Array.isArray(d.mids) && d.mids.length <= MIDS_MAX && d.mids.every(isMid) ? { type: "mids", mids: d.mids } : null;
    case "bridge.pick": {
      const rect = rectOf(d.rect);
      const tag = typeof d.tag === "string" ? d.tag.toLowerCase() : "";
      if (!isMid(d.mid) || !/^[a-z][a-z0-9-]{0,31}$/.test(tag) || !rect) return null;
      return { type: "pick", element: { mid: d.mid, tag, text: textOf(d.text), rect } };
    }
    case "bridge.rects": {
      if (!Array.isArray(d.rects) || d.rects.length > MIDS_MAX) return null;
      const rects: ({ mid: string } & Rect)[] = [];
      for (const r of d.rects) {
        const rect = rectOf(r);
        const mid = (r as { mid?: unknown } | null)?.mid;
        if (!rect || !isMid(mid)) return null;
        rects.push({ mid, ...rect });
      }
      return { type: "rects", rects };
    }
    case "bridge.key":
      return d.key === "c" || d.key === "Escape" ? { type: "key", key: d.key } : null;
    default:
      return null;
  }
}

/** Tells the page the canvas's mode: Comment outlines and picks elements. */
export function modeMessage(mode: "view" | "comment"): { type: "bridge.mode"; mode: "view" | "comment" } {
  return { type: "bridge.mode", mode };
}

/** Asks the page for the boxes of the pinned elements, now and as they move. */
export function pinsMessage(mids: string[]): { type: "bridge.pins"; mids: string[] } {
  return { type: "bridge.pins", mids: [...new Set(mids.filter(isMid))] };
}
