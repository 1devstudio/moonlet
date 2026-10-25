// The comment bridge (X65): messages between the design screen and the
// script the moonlet-design:// scheme puts in a page the canvas asks for
// (src-tauri/src/design_bridge.js). The page is on another origin, so they
// talk only through postMessage, and the app takes a message only from its
// own frame's window and only in a shape it knows.

import { STYLE_VALUE_MAX } from "./designStyle";

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

/** One element of the page's tree, as the Layers tab lists it: its depth
 *  among the elements with an id, from the body's 0. */
export interface Layer {
  mid: string;
  tag: string;
  depth: number;
  /** Up to 60 characters of its text, on one line. */
  text: string;
}

/** Where a dragged element or snippet would go: above or below element
 *  `ref`, or into it, last. */
export interface DropPlace {
  where: "above" | "below" | "into";
  ref: string;
}

/** The properties of the selection's computed style the bridge reports,
 *  for the Inspector. */
export const COMPUTED_PROPS = [
  "display",
  "flex-direction",
  "gap",
  "align-items",
  "justify-content",
  "grid-template-columns",
  "padding",
  "margin",
  "width",
  "height",
  "background-color",
  "border",
  "border-radius",
  "box-shadow",
  "opacity",
  "position",
] as const;

/** What a drag in the page ends with: an element dropped at a place, a
 *  size or place in px a handle or a drag gave, or a Palette snippet's
 *  drop at a place, or nowhere. */
export type DragResult = { kind: "move"; mid: string; place: DropPlace } | { kind: "style"; mid: string; set: Record<string, string> } | { kind: "drop"; place: DropPlace | null };

/** What the page tells the app. */
export type BridgeMessage =
  | { type: "mids"; mids: string[] }
  | { type: "tree"; layers: Layer[] }
  /** The element selected in Edit mode and its box; none when the one asked
   *  for is not on the page. */
  | { type: "selected"; mid: string | null; rect: Rect | null }
  /** Where the page is scrolled, in its CSS px. */
  | { type: "scroll"; x: number; y: number }
  /** An element's text, edited in place and committed. */
  | { type: "text"; mid: string; text: string }
  | { type: "pick"; element: PickedElement }
  | { type: "rects"; rects: ({ mid: string } & Rect)[] }
  | { type: "key"; key: PageKey; shift: boolean; alt: boolean; meta: boolean }
  /** The selection's computed style, the Inspector's properties of it. */
  | { type: "computed"; mid: string; style: Record<string, string> }
  /** Where the element dragged (`mid`), or (null) a snippet dragged from
   *  the Palette, would drop now; null: nowhere. */
  | { type: "drag"; mid: string | null; place: DropPlace | null }
  /** A dragged element dropped at `place`. */
  | { type: "move"; mid: string; place: DropPlace }
  /** A size a handle gave, or the place an absolutely positioned element
   *  was dragged to, in px. */
  | { type: "style"; mid: string; set: Record<string, string> }
  /** A snippet dragged from the Palette dropped at `place`, or nowhere. */
  | { type: "drop"; place: DropPlace | null };

/** The keys the bridge sends the app from the page: C, V and Esc for the
 *  mode, and in Edit mode the editor's (Tab, Delete, ⌘D, ⌥⌘G, ⌘C, ⌘V, ⌘Z…). */
export const PAGE_KEYS = ["c", "v", "Escape", "Tab", "Delete", "Backspace", "d", "g", "z"] as const;
export type PageKey = (typeof PAGE_KEYS)[number];

/** How much of an element's text a pin keeps, in characters. */
export const TEXT_MAX = 60;

/** A page's element id: `m` and digits. The app's one check of a
 *  `data-mid`; the bridge script and the daemon keep their own. */
export function isMid(mid: unknown): mid is string {
  return typeof mid === "string" && /^m\d+$/.test(mid);
}

/** A tag's name as a pin keeps it: lowercase, a letter then letters, digits
 *  or `-`, at most 32 characters, as the daemon takes it. */
export function isTag(tag: unknown): tag is string {
  return typeof tag === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(tag);
}

/** The most ids a page reports, so a page cannot flood the app. */
const MIDS_MAX = 20_000;

/** The longest text an element is given in place, in UTF-16 units; the
 *  bridge script keeps its own, and puts a longer text back. */
const TEXT_EDIT_MAX = 10_000;

/** The deepest an element of the tree is taken. */
const DEPTH_MAX = 1_000;

const num = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

function placeOf(p: unknown): DropPlace | null {
  if (typeof p !== "object" || p === null) return null;
  const { where, ref } = p as Record<string, unknown>;
  return (where === "above" || where === "below" || where === "into") && isMid(ref) ? { where, ref } : null;
}

/** What a drag or a handle writes: `left` and `top`, or `width` and
 *  `height`, each a number of px. */
const PX_PROPS = ["left", "top", "width", "height"];

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
    case "bridge.tree": {
      if (!Array.isArray(d.nodes) || d.nodes.length > MIDS_MAX) return null;
      const layers: Layer[] = [];
      for (const n of d.nodes as unknown[]) {
        const { mid, tag, depth, text } = (typeof n === "object" && n !== null ? n : {}) as Record<string, unknown>;
        const lower = typeof tag === "string" ? tag.toLowerCase() : "";
        if (!isMid(mid) || !isTag(lower) || !Number.isInteger(depth) || (depth as number) < 0 || (depth as number) > DEPTH_MAX) return null;
        layers.push({ mid, tag: lower, depth: depth as number, text: textOf(text) });
      }
      return { type: "tree", layers };
    }
    case "bridge.scroll":
      return num(d.x) && num(d.y) ? { type: "scroll", x: d.x, y: d.y } : null;
    case "bridge.text":
      return isMid(d.mid) && typeof d.text === "string" && d.text.length <= TEXT_EDIT_MAX ? { type: "text", mid: d.mid, text: d.text } : null;
    case "bridge.selected": {
      if (d.mid === null) return { type: "selected", mid: null, rect: null };
      const rect = rectOf(d.rect);
      return isMid(d.mid) && rect ? { type: "selected", mid: d.mid, rect } : null;
    }
    case "bridge.pick": {
      const rect = rectOf(d.rect);
      const tag = typeof d.tag === "string" ? d.tag.toLowerCase() : "";
      if (!isMid(d.mid) || !isTag(tag) || !rect) return null;
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
    case "bridge.computed": {
      if (!isMid(d.mid) || typeof d.style !== "object" || d.style === null) return null;
      const got = d.style as Record<string, unknown>;
      const style: Record<string, string> = {};
      for (const p of COMPUTED_PROPS) {
        const v = got[p];
        if (typeof v === "string" && v.length <= STYLE_VALUE_MAX) style[p] = v;
      }
      return { type: "computed", mid: d.mid, style };
    }
    case "bridge.drag": {
      const place = d.place === null ? null : placeOf(d.place);
      if ((d.mid !== null && !isMid(d.mid)) || (d.place !== null && !place)) return null;
      return { type: "drag", mid: d.mid, place };
    }
    case "bridge.move": {
      const place = placeOf(d.place);
      return isMid(d.mid) && place ? { type: "move", mid: d.mid, place } : null;
    }
    case "bridge.style": {
      if (!isMid(d.mid) || typeof d.set !== "object" || d.set === null) return null;
      const entries = Object.entries(d.set as Record<string, unknown>);
      if (!entries.length || !entries.every(([k, v]) => PX_PROPS.includes(k) && typeof v === "string" && /^-?\d{1,6}(\.\d{1,3})?px$/.test(v))) return null;
      return { type: "style", mid: d.mid, set: Object.fromEntries(entries) as Record<string, string> };
    }
    case "bridge.drop": {
      const place = d.place === null ? null : placeOf(d.place);
      return d.place !== null && !place ? null : { type: "drop", place };
    }
    case "bridge.key":
      return (PAGE_KEYS as readonly unknown[]).includes(d.key) ? { type: "key", key: d.key as PageKey, shift: d.shift === true, alt: d.alt === true, meta: d.meta === true } : null;
    default:
      return null;
  }
}

/** Tells the page the canvas's mode: Comment outlines and picks elements,
 *  Edit selects them. */
export function modeMessage(mode: "view" | "comment" | "edit"): { type: "bridge.mode"; mode: "view" | "comment" | "edit" } {
  return { type: "bridge.mode", mode };
}

/** Tells a page loaded again where it was scrolled before. */
export function scrollMessage(x: number, y: number): { type: "bridge.scrollTo"; x: number; y: number } {
  return { type: "bridge.scrollTo", x, y };
}

/** Tells the page which element is selected in Edit mode, or none, and
 *  whether it is off-system, which its outline's label says. */
export function selectMessage(mid: string | null, off = false): { type: "bridge.select"; mid: string | null; off?: true } {
  return { type: "bridge.select", mid: isMid(mid) ? mid : null, ...(off ? { off: true as const } : {}) };
}

/** Tells the page a snippet is being dragged from the Palette, so it shows
 *  where it would drop and reports the drop; and when that drag ends. */
export function paletteMessage(dragging: boolean): { type: "bridge.palette"; dragging: boolean } {
  return { type: "bridge.palette", dragging };
}

/** Asks the page for the boxes of the pinned elements, now and as they move. */
export function pinsMessage(mids: string[]): { type: "bridge.pins"; mids: string[] } {
  return { type: "bridge.pins", mids: [...new Set(mids.filter(isMid))] };
}

/** Asks the page for its `data-mid`s, which it reports once loaded: sent
 *  once the app listens, so a report sent before that is not lost. */
export function helloMessage(): { type: "bridge.hello" } {
  return { type: "bridge.hello" };
}

/** An edit by hand made on the live page too, so it shows at once without
 *  loading the page again (the saved file is what counts): remove an
 *  element, insert one's source at a place (null: first in the body), wrap
 *  one in a box with id `box`, unwrap one, or give one its new
 *  inline style. */
export type LiveEdit =
  | { op: "remove"; mid: string }
  /** An element's source put at `place`; null: first in the body. */
  | { op: "insert"; place: DropPlace | null; html: string }
  | { op: "wrap"; mid: string; box: string }
  | { op: "unwrap"; mid: string }
  /** Its `style` attribute's new text; empty: none. */
  | { op: "style"; mid: string; style: string }
  /** Moved above or below element `ref`, or into it, last. */
  | { op: "move"; mid: string; place: DropPlace };

/** Tells the page to make an edit on its live page. */
export function editMessage(edit: LiveEdit): { type: "bridge.edit" } & LiveEdit {
  return { type: "bridge.edit", ...edit };
}
