// A design's comments (X65): the line a pin sends to the chat and how the
// chat reads it back, Send all's message, the Comments tab's groups and
// counts, and which pins lost their element. Pure: the store is designStore.ts.

import type { DesignComment } from "./protocol";
import { pageFile } from "./designPage";
import { isMid, isTag } from "./designBridge";

/** The file a design keeps its comments in (`design/comments.rs`'s
 *  `COMMENTS_FILE`): a change to it lists them again. */
export const COMMENTS_FILE = "comments.json";

/** Text on one line: every run of spaces and line breaks one space. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The line **Send** adds to the chat for a pin, on one line:
 *  `Comment on <page> [data-mid=<id>] (<tag> "<text>"): <comment>`.
 *  {@link parseCommentLine} reads it back. */
export function commentLine(pin: CommentRef): string {
  return `Comment on ${pageFile(pin.page)} [data-mid=${pin.mid}] (${pin.tag} "${oneLine(pin.text)}"): ${oneLine(pin.comment)}`;
}

/** A comment's line read back: its page, element and comment. */
export interface CommentRef {
  page: string;
  mid: string;
  tag: string;
  text: string;
  comment: string;
}

/** The line {@link commentLine} writes, read back; null for any other line. */
export function parseCommentLine(line: string): CommentRef | null {
  const m = /^Comment on (.+)\.html \[data-mid=([^\]]*)\] \((\S*) "(.*?)"\): (.+)$/.exec(line);
  return m && isMid(m[2]) && isTag(m[3]) ? { page: m[1], mid: m[2], tag: m[3], text: m[4], comment: m[5] } : null;
}

/** A user's message in the design's chat as **Comment from the canvas**
 *  cards, one per line, each numbered like its pin (null when no open or
 *  resolved pin has that comment any more); null when not every line of it
 *  is a comment's, so it shows as it is. */
export function commentCards(text: string, pins: DesignComment[]): (CommentRef & { n: number | null })[] | null {
  const lines = text.split("\n").filter((l) => l.trim());
  const refs = lines.map(parseCommentLine);
  if (!refs.length || refs.some((r) => r === null)) return null;
  return (refs as CommentRef[]).map((r) => ({
    n: pins.find((p) => p.page === r.page && p.mid === r.mid && oneLine(p.comment) === r.comment)?.n ?? null,
    ...r,
  }));
}

/** The `data-mid`s each page (by name) reported after it last loaded. */
export type PageMids = Record<string, readonly string[] | undefined>;

/** Whether a pin's element is gone: its page loaded since without its
 *  `data-mid`, or it names no element (a pin kept from before pins had one). */
export function isOrphaned(pin: DesignComment, mids: PageMids): boolean {
  if (!pin.page || !pin.mid) return true;
  const there = mids[pin.page];
  return !!there && !there.includes(pin.mid);
}

/** What the Comments tab shows. */
export interface CommentsTab {
  /** The pins listed: open ones whose element is there, or the resolved ones. */
  shown: DesignComment[];
  /** Open pins whose element is gone, under **Orphaned** (Open only). */
  orphaned: DesignComment[];
  /** Open pins, orphaned ones included, as the design's row counts them. */
  open: number;
  resolved: number;
  /** Open pins not sent yet whose element is there: what **Send all** sends. */
  unsent: number;
}

/** The Comments tab on `tab`, filtered to `page` (null: All pages). */
export function commentsTab(pins: DesignComment[], view: { tab: "open" | "resolved"; page: string | null }, mids: PageMids): CommentsTab {
  const open = pins.filter((p) => p.state === "open");
  const resolved = pins.filter((p) => p.state === "resolved");
  const onPage = (p: DesignComment) => view.page === null || p.page === view.page;
  const there = open.filter((p) => !isOrphaned(p, mids));
  return {
    shown: (view.tab === "open" ? there : resolved).filter(onPage),
    orphaned: view.tab === "open" ? open.filter((p) => isOrphaned(p, mids) && onPage(p)) : [],
    open: open.length,
    resolved: resolved.length,
    unsent: unsentPins(pins, mids).length,
  };
}

/** The open pins not sent yet whose element is there, by number. */
function unsentPins(pins: DesignComment[], mids: PageMids): DesignComment[] {
  return pins.filter((p) => p.state === "open" && p.sent_at === null && !isOrphaned(p, mids));
}

/** The one message **Send** and **Send all** add to the chat: the pins'
 *  lines, one per pin. */
export function commentsMessage(pins: CommentRef[]): string {
  return pins.map(commentLine).join("\n");
}

/** What **Send all** sends: every open pin not sent yet whose element is
 *  there, by number. */
export function sendAll(pins: DesignComment[], mids: PageMids): DesignComment[] {
  return unsentPins(pins, mids);
}

/** `list` with `pins` the daemon gave back in place of their old selves,
 *  new ones added, by number. */
export function withPins(list: DesignComment[], pins: DesignComment[]): DesignComment[] {
  const changed = new Map(pins.map((p) => [p.n, p]));
  const kept = list.filter((p) => !changed.has(p.n));
  return [...kept, ...pins].sort((a, b) => a.n - b.n);
}

/** Each page's open pins, by its name; a page with none is left out. */
export function pageCounts(pins: DesignComment[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of pins) if (p.state === "open") counts[p.page] = (counts[p.page] ?? 0) + 1;
  return counts;
}

/** How much of an element's text the comment box shows, in characters. */
const BOX_TEXT = 12;

/** The element as the comment box names it, its text cut inside the quotes:
 *  `nav · m12 · "General Appe…"`. */
export function boxLabel(el: { tag: string; mid: string; text: string }): string {
  const chars = [...el.text];
  const text = chars.length > BOX_TEXT ? `${chars.slice(0, BOX_TEXT).join("")}…` : el.text;
  return [el.tag, el.mid, ...(text ? [`"${text}"`] : [])].join(" · ");
}

/** A pin as the Comments tab names it: `index.html · m12 · nav "General Appearance"`. */
export function pinLabel(pin: DesignComment): string {
  return `${pageFile(pin.page)} · ${pin.mid} · ${pin.tag}${pin.text ? ` "${pin.text}"` : ""}`;
}

/** "Sent 10:18", or "Not sent". */
export function sentLabel(pin: DesignComment): string {
  if (pin.sent_at === null) return "Not sent";
  const at = new Date(pin.sent_at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `Sent ${two(at.getHours())}:${two(at.getMinutes())}`;
}

/** The Comments tab's footer: "2 not sent yet, one line each". */
export function footerLabel(unsent: number): string {
  return unsent ? `${unsent} not sent yet, one line each` : "All sent";
}

/** The attribute a chat card carries with its pin's number, which Show in
 *  chat looks for. */
export const COMMENT_PIN_ATTR = "data-comment-pin";

/** The chat cards of pin `n`. */
export function commentCardSelector(n: number): string {
  return `[${COMMENT_PIN_ATTR}="${n}"]`;
}

/** How long Show in chat waits for its chat to load. */
const SHOW_IN_CHAT_WAIT_MS = 5000;

/** What Show in chat does after looking for the pin's card: scrolls to it
 *  when `found`; else, while the chat's messages have not `loaded`, looks
 *  again, for at most 5 s; else says its message is not in the chat. */
export function chatCardLookup(l: { found: boolean; loaded: boolean; waitedMs: number }): "found" | "wait" | "missing" {
  if (l.found) return "found";
  return !l.loaded && l.waitedMs < SHOW_IN_CHAT_WAIT_MS ? "wait" : "missing";
}

/** "1 open comment", "3 open comments". */
export function openCommentsLabel(n: number): string {
  return `${n} open comment${n === 1 ? "" : "s"}`;
}

/** What Keep and Send do with the box's text: a new pin, a changed comment
 *  of a kept one, or nothing to change. */
export function keepAction(pin: DesignComment | null, comment: string): "new" | "edit" | "unchanged" {
  if (!pin) return "new";
  return oneLine(comment) === oneLine(pin.comment) ? "unchanged" : "edit";
}

/** The comment box's size, near enough to place it. */
export const BOX_SIZE = { w: 300, h: 150 } as const;

/** Where the comment box goes over the page of `size` px shown at `scale`,
 *  for an element at `rect` in the page: under it, else above it, else (an
 *  element as tall as the page) inside the page, so the box never leaves
 *  it; and never past the page's right edge. */
export function boxPlace(rect: { x: number; y: number; w: number; h: number }, scale: number, size: [number, number]): { left: number; top: number } {
  const left = Math.max(0, Math.min(rect.x * scale, size[0] - BOX_SIZE.w));
  const below = (rect.y + rect.h) * scale + 8;
  const above = rect.y * scale - BOX_SIZE.h - 8;
  const top = below + BOX_SIZE.h <= size[1] ? below : above >= 0 ? above : Math.max(0, Math.min(rect.y * scale + 8, size[1] - BOX_SIZE.h));
  return { left, top };
}
