// Edits by hand on a design's page (X65): each editor operation is a pure
// function from the page's source text to its new text, by `data-mid`. The
// page is parsed with each element's place in the source (parse5's
// sourceCodeLocationInfo), and only the edited element's text is spliced, so
// everything else, quoting, entities, void elements, line ends and spacing
// included, stays byte for byte as the agent or the user wrote it. The live
// page is never serialized: the bridge's outlines and editor attributes
// never reach the file.

import { parse, parseFragment } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import { pageFile, pageOfFile } from "./designPage";
import type { LiveEdit } from "./designBridge";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

/** An operation of the visual editor on one element of a page. */
export type EditOp = { kind: "text"; mid: string; text: string } | { kind: "delete"; mid: string } | { kind: "duplicate"; mid: string } | { kind: "wrap"; mid: string } | { kind: "unwrap"; mid: string }
  /** A copied element's source (see {@link copyElement}) after element
   *  `after`, or at the end of the body. */
  | { kind: "paste"; after: string | null; html: string };

/** What an edit did to its element, as the agent is told. */
export type Change =
  | { kind: "text"; text: string }
  | { kind: "deleted" }
  | { kind: "duplicated"; copy: string }
  | { kind: "wrapped"; box: string }
  | { kind: "unwrapped" }
  /** Pasted after element `after`, or (null) at the end of the body. */
  | { kind: "inserted"; after: string | null };

/** An edit by hand of one element of a page. */
export interface HandEdit {
  page: string;
  mid: string;
  tag: string;
  change: Change;
}

/** An edit applied to a page's source. */
export interface Edit {
  /** The page's new source. */
  html: string;
  /** The element selected after it, or none. */
  select: string | null;
  /** What it did, to which element. */
  change: Omit<HandEdit, "page">;
  /** The same edit on the live page, so it shows at once; none for a text
   *  edited in place, which the page already shows. */
  live: LiveEdit | null;
}

/** What a change says: `text “…”`, `deleted`, `duplicated as m41`, … */
function changeText(c: Change): string {
  switch (c.kind) {
    case "text":
      return `text “${c.text.replace(/\s+/g, " ").trim()}”`;
    case "deleted":
    case "unwrapped":
      return c.kind;
    case "duplicated":
      return `duplicated as ${c.copy}`;
    case "wrapped":
      return `wrapped in div ${c.box}`;
    case "inserted":
      return c.after === null ? "inserted at the end of the body" : `inserted after ${c.after}`;
  }
}

/** An element's line in the message that tells the agent: `index.html m24
 *  section: moved above m22`, its changes after the colon. */
function elementLine(e: { page: string; mid: string; tag: string }, changes: string[]): string {
  return `${pageFile(e.page)} ${e.mid} ${e.tag}: ${changes.join(", ")}`;
}

/** An edit's line, as the agent is told it. */
export function editLine(e: HandEdit): string {
  return elementLine(e, [changeText(e.change)]);
}

/** An edit by hand the agent has not been told yet; `undone`: one it was
 *  told, undone since. */
export interface Untold extends HandEdit {
  undone?: boolean;
}

/** The first line of a message that tells the agent the edits by hand. */
export const EDITS_HEADER = "Edits by hand since your last turn:";

/** One line per element edited, in the order first edited: its changes in
 *  order, a text change only as its latest text. */
export function editLines(edits: Untold[]): string[] {
  const byElement = new Map<string, { head: HandEdit; changes: string[]; text: number | null }>();
  for (const e of edits) {
    const key = `${e.page}\0${e.mid}`;
    const el = byElement.get(key) ?? { head: e, changes: [], text: null };
    byElement.set(key, el);
    const said = `${e.undone ? "undid " : ""}${changeText(e.change)}`;
    if (e.change.kind === "text" && !e.undone && el.text !== null) el.changes[el.text] = said;
    else if (e.change.kind === "text" && !e.undone) el.text = el.changes.push(said) - 1;
    else el.changes.push(said);
  }
  return [...byElement.values()].map((el) => elementLine(el.head, el.changes));
}

/** An edit's line read back: its element and what it says changed. */
export interface EditLineRead {
  page: string;
  mid: string;
  tag: string;
  said: string;
}

/** An edit's line read back, as it was sent. */
export function lineRead(e: EditLineRead): string {
  return elementLine(e, [e.said]);
}

/** A message that starts with the edits by hand, read back as their lines
 *  and the user's text after them; null for any other message. The parse of
 *  {@link editsMessage}'s lines (`elementLine`). */
export function readEditsMessage(message: string): { edits: EditLineRead[]; text: string } | null {
  const [head, ...rest] = message.split("\n");
  if (head !== EDITS_HEADER) return null;
  const blank = rest.indexOf("");
  const lines = blank < 0 ? rest : rest.slice(0, blank);
  const edits: EditLineRead[] = [];
  for (const l of lines) {
    const m = /^(.+?\.html) (m\d+) ([a-z][a-z0-9-]*): (.+)$/.exec(l);
    const page = m ? pageOfFile(m[1]) : null;
    if (!m || page === null) return null;
    edits.push({ page, mid: m[2], tag: m[3], said: m[4] });
  }
  return edits.length ? { edits, text: blank < 0 ? "" : rest.slice(blank + 1).join("\n") } : null;
}

/** The user's message `text` with the edits by hand not told yet before it:
 *  {@link EDITS_HEADER}, a line per element, a blank line, then the text. */
export function editsMessage(edits: Untold[], text: string): string {
  const lines = editLines(edits);
  return lines.length ? [EDITS_HEADER, ...lines, "", text].join("\n") : text;
}

/** Why an edit cannot be made on this page, said to the user. */
export class EditRefused extends Error {}

/** A page's source parsed, each element with its place in the text. */
function parsed(html: string) {
  return parse(html, { sourceCodeLocationInfo: true });
}

const isElement = (n: Node): n is Element => "tagName" in n;

/** Every element of `root`, in document order, `<template>` contents too. */
function* elements(root: Node): Generator<Element> {
  if (isElement(root)) yield root;
  for (const c of "childNodes" in root ? root.childNodes : []) yield* elements(c);
  if (isElement(root) && root.tagName === "template" && "content" in root) yield* elements((root as DefaultTreeAdapterMap["template"]).content);
}

/** An element as an edit names it: its `data-mid` and tag. */
const who = (el: Element) => ({ mid: midOf(el)!, tag: el.tagName });

const midOf = (el: Element) => el.attrs.find((a) => a.name === "data-mid")?.value ?? null;

/** The element `mid` of the page, written in its source. */
function find(doc: Node, mid: string): Element {
  for (const el of elements(doc)) if (midOf(el) === mid && el.sourceCodeLocation) return el;
  throw new EditRefused(`${mid} is not on the page`);
}

/** Text as the source writes it: `&`, `<`, `>` and a no-break space as entities. */
function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\u00a0/g, "&nbsp;");
}

/** The source between an element's start tag and its end (its end tag, or
 *  where it ends when the tag is implied). */
function inner(el: Element): [number, number] {
  const loc = el.sourceCodeLocation!;
  if (!loc.startTag) throw new EditRefused(`${midOf(el)} has no start tag`);
  return [loc.startTag.endOffset, loc.endTag ? loc.endTag.startOffset : loc.endOffset];
}

const splice = (html: string, [from, to]: [number, number], text: string) => html.slice(0, from) + text + html.slice(to);

/** `op` applied to page `html`; {@link EditRefused} when it cannot be.
 *  `floor`: the highest id number the page ever had (see {@link
 *  highestMid}), which new ids come after. */
export function applyEdit(html: string, op: EditOp, floor = 0): Edit {
  const doc = parsed(html);
  const edit = edited(html, doc, op, floor);
  // The ids the page has after it, read back as a browser reads the page:
  // the ones it had, less those removed, with those added. Tags that cross
  // others' (`<b><p></b></p>`) make an element's source not its own.
  const want = written(doc);
  if (op.kind === "delete") for (const id of written(find(doc, op.mid))) remove(want, id);
  if (op.kind === "unwrap") remove(want, op.mid);
  const got = written(parsed(edit.html));
  const added = [...got];
  for (const id of want) remove(added, id);
  const lost = want.filter((id) => !got.includes(id));
  if (lost.length || (added.length && !["duplicate", "wrap", "paste"].includes(op.kind))) {
    throw new EditRefused(`The page's markup around ${op.kind === "paste" ? (op.after ?? "the body") : op.mid} is tangled: ask the agent to fix it`);
  }
  return edit;
}

/** The ids of the elements written in a page's source, in document order. */
function written(doc: Node): string[] {
  return [...elements(doc)].flatMap((e) => {
    const mid = e.sourceCodeLocation ? midOf(e) : null;
    return mid ? [mid] : [];
  });
}

/** `list` less one `id`. */
function remove(list: string[], id: string | null) {
  const at = id === null ? -1 : list.indexOf(id);
  if (at >= 0) list.splice(at, 1);
}

function edited(html: string, doc: Node, op: EditOp, floor: number): Edit {
  if (op.kind === "paste") return paste(html, doc, op.after, op.html, floor);
  const el = find(doc, op.mid);
  switch (op.kind) {
    case "text":
      if (!textOnly(el)) throw new EditRefused(`${op.mid} holds more than text: edit the text of its parts`);
      return { html: splice(html, inner(el), escapeText(op.text)), select: op.mid, change: { ...who(el), change: { kind: "text", text: op.text } }, live: null };
    case "delete": {
      inBody(el);
      return { html: splice(html, line(html, outer(el)), ""), select: sibling(el, 1) ?? sibling(el, -1) ?? parentMid(el), change: { ...who(el), change: { kind: "deleted" } }, live: { op: "remove", mid: op.mid } };
    }
    case "duplicate": {
      inBody(el);
      const ids = freshIds(doc, floor);
      const copy = renumbered(html, el, ids);
      return { html: after(html, outer(el), copy), select: ids.taken[0], change: { ...who(el), change: { kind: "duplicated", copy: ids.taken[0] } }, live: { op: "insert", after: op.mid, html: copy } };
    }
    case "wrap": {
      inBody(el);
      const box = freshIds(doc, floor).take();
      const [from, to] = outer(el);
      return { html: splice(html, [from, to], `<div data-mid="${box}">${html.slice(from, to)}</div>`), select: box, change: { ...who(el), change: { kind: "wrapped", box } }, live: { op: "wrap", mid: op.mid, box } };
    }
    case "unwrap": {
      inBody(el);
      const [a, b] = inner(el);
      if (a >= b) throw new EditRefused(`<${el.tagName}> ${op.mid} has nothing inside to keep`);
      const first = el.childNodes.filter(isElement).map(midOf).find((m) => m !== null);
      return { html: splice(html, outer(el), html.slice(a, b)), select: first ?? parentMid(el), change: { ...who(el), change: { kind: "unwrapped" } }, live: { op: "unwrap", mid: op.mid } };
    }
  }
}

/** The highest number of a `data-mid` in page `html`, anywhere in it
 *  (inside an `<svg>` and its other exceptions too); 0 for none. */
export function highestMid(html: string): number {
  return highest(parsed(html));
}

function highest(doc: Node): number {
  let top = 0;
  for (const e of elements(doc)) {
    const n = /^m(\d+)$/.exec(midOf(e) ?? "")?.[1];
    if (n !== undefined) top = Math.max(top, Number(n));
  }
  return top;
}

/** The next free ids of a page, `m<n>` after the highest it has, as
 *  `moonlet design check --fix` gives them, and after `floor`, the highest
 *  it had before (an id an element deleted since held is never given
 *  again); `taken` lists those given so far. */
function freshIds(doc: Node, floor = 0) {
  let next = Math.max(highest(doc), floor) + 1;
  const taken: string[] = [];
  return {
    taken,
    take: () => {
      const id = `m${next++}`;
      taken.push(id);
      return id;
    },
  };
}

/** The source of `el`, its own `data-mid` and every one inside it given a
 *  fresh id in document order; only the ids' values change. */
function renumbered(html: string, el: Element, ids: ReturnType<typeof freshIds>): string {
  const [from, to] = outer(el);
  const spans: [number, number][] = [];
  for (const e of elements(el)) {
    const at = e.sourceCodeLocation?.attrs?.["data-mid"];
    const mid = midOf(e);
    if (!at || !mid) continue;
    // The value is the attribute's last `mid`, whatever its quotes.
    const value = html.lastIndexOf(mid, at.endOffset);
    spans.push([value, value + mid.length]);
  }
  let out = "";
  let at = from;
  for (const [a, b] of spans.sort((x, y) => x[0] - y[0])) {
    out += html.slice(at, a) + ids.take();
    at = b;
  }
  return out + html.slice(at, to);
}

/** `html` with `text` put after `span`: on a line of its own, indented as
 *  `span`, when `span` has its line to itself; else right after it. */
function after(html: string, span: [number, number], text: string): string {
  const [from, to] = span;
  const whole = line(html, span);
  if (whole[0] === from && whole[1] === to) return splice(html, [to, to], text);
  const indent = html.slice(whole[0], from);
  const eol = html.slice(to, whole[1]).match(/\r?\n/)?.[0] ?? (html.includes("\r\n") ? "\r\n" : "\n");
  return splice(html, [to, to], eol + indent + text);
}

/** The source of element `mid` of page `html`, for a paste; null when the
 *  page has none. */
export function copyElement(html: string, mid: string): string | null {
  for (const el of elements(parsed(html))) if (midOf(el) === mid && el.sourceCodeLocation) return html.slice(...outer(el));
  return null;
}

/** A copied element pasted after element `mid`, else after the body's last
 *  element with an id, else first in the body; its ids fresh. */
function paste(html: string, doc: Node, mid: string | null, copied: string, floor: number): Edit {
  const root = parseFragment(copied, { sourceCodeLocationInfo: true }).childNodes.find(isElement);
  if (!root?.sourceCodeLocation) throw new EditRefused("Nothing to paste");
  const ids = freshIds(doc, floor);
  const text = renumbered(copied, root, ids);
  let at: Element | undefined;
  if (mid !== null) {
    at = find(doc, mid);
    inBody(at);
  }
  const body = [...elements(doc)].find((e) => e.tagName === "body");
  at ??= body?.childNodes.filter(isElement).filter((e) => midOf(e) !== null && e.sourceCodeLocation).at(-1);
  const change = { mid: ids.taken[0], tag: root.tagName, change: { kind: "inserted", after: mid } as const };
  if (at) return { html: after(html, outer(at), text), select: ids.taken[0], change, live: { op: "insert", after: midOf(at), html: text } };
  const start = body?.sourceCodeLocation?.startTag?.endOffset;
  if (start === undefined) throw new EditRefused("The page has no body to paste into");
  return { html: splice(html, [start, start], text), select: ids.taken[0], change, live: { op: "insert", after: null, html: text } };
}

/** Refuses the body and anything outside it: only the body's elements are edited. */
function inBody(el: Element) {
  if (el.tagName === "body") throw new EditRefused("The page's body stays");
  for (let p = el.parentNode; p && isElement(p); p = p.parentNode) if (p.tagName === "body") return;
  throw new EditRefused(`${midOf(el)} is not in the page's body`);
}

/** An element's whole source, from its start tag to its end. */
function outer(el: Element): [number, number] {
  const loc = el.sourceCodeLocation!;
  return [loc.startOffset, loc.endOffset];
}

/** `span` with its whole line, line end included, when nothing but spaces
 *  shares the line with it; else `span`. */
function line(html: string, [from, to]: [number, number]): [number, number] {
  const start = html.lastIndexOf("\n", from - 1) + 1;
  const end = html.slice(to).search(/\r?\n|$/) + to;
  if (/\S/.test(html.slice(start, from)) || /\S/.test(html.slice(to, end))) return [from, to];
  const eol = html.startsWith("\r\n", end) ? 2 : html.startsWith("\n", end) ? 1 : 0;
  return [start, end + eol];
}

/** The nearest element outside `el` with a `data-mid`. */
function parentMid(el: Element): string | null {
  for (let p = el.parentNode; p && isElement(p); p = p.parentNode) {
    const mid = midOf(p);
    if (mid) return mid;
  }
  return null;
}

/** The `data-mid` of `el`'s next (1) or previous (-1) sibling element that has one. */
function sibling(el: Element, dir: 1 | -1): string | null {
  const all = (el.parentNode?.childNodes ?? []).filter(isElement);
  for (let i = all.indexOf(el) + dir; i >= 0 && i < all.length; i += dir) {
    const mid = midOf(all[i]);
    if (mid) return mid;
  }
  return null;
}

/** Elements whose text is not the page's text: scripts, styles and the like. */
const RAW = new Set(["script", "style", "textarea", "title", "template", "noscript", "xmp", "iframe", "noembed", "noframes", "plaintext"]);

/** Whether an element's children are only text, so its text is edited in
 *  place: no element, comment or raw text inside, and a start tag in the
 *  source. */
function textOnly(el: Element): boolean {
  return !RAW.has(el.tagName) && !!el.sourceCodeLocation?.startTag && el.childNodes.every((c) => c.nodeName === "#text");
}

/** The chip over the canvas: how many lines the next message tells the
 *  agent, "3 edits by hand · go with your next message"; null for none. */
export function editsChip(edits: Untold[]): string | null {
  const n = editLines(edits).length;
  return n ? `${n} ${n === 1 ? "edit" : "edits"} by hand · go with your next message` : null;
}
