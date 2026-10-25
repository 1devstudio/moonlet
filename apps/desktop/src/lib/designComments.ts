// A design's comments (X65): the line a pin sends to the chat and how the
// chat reads it back, Send all's message, the Comments tab's groups and
// counts, and which pins lost their element. Pure: the store is designStore.ts.

import type { DesignComment } from "./protocol";
import { pageFile } from "./designPage";
import { isMid, isTag } from "./designBridge";

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

/** What **Send all** sends: every open pin not sent yet whose element is
 *  there, as one message of their lines, and their numbers; null when none. */
export function sendAll(pins: DesignComment[], mids: PageMids): { pins: number[]; text: string } | null {
  const unsent = unsentPins(pins, mids);
  return unsent.length ? { pins: unsent.map((p) => p.n), text: unsent.map(commentLine).join("\n") } : null;
}

/** Each page's open pins, by its name; a page with none is left out. */
export function pageCounts(pins: DesignComment[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of pins) if (p.state === "open") counts[p.page] = (counts[p.page] ?? 0) + 1;
  return counts;
}

/** The element as the comment box names it: `nav · m12 · "General Appearance"`. */
export function boxLabel(el: { tag: string; mid: string; text: string }): string {
  return [el.tag, el.mid, ...(el.text ? [`"${el.text}"`] : [])].join(" · ");
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
