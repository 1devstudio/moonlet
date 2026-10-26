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
import type { DropPlace, LiveEdit } from "./designBridge";
import { attrText, isStyleProp, isStyleValue, parseStyle, restyled, valueParts, type Decl, type StyleSet } from "./designStyle";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];


/** An operation of the visual editor on one element of a page. */
export type EditOp = { kind: "text"; mid: string; text: string } | { kind: "delete"; mid: string } | { kind: "duplicate"; mid: string } | { kind: "wrap"; mid: string } | { kind: "unwrap"; mid: string }
  /** A copied element's source (see {@link copyElement}) after element
   *  `after`, or at the end of the body. */
  | { kind: "paste"; after: string | null; html: string }
  /** Properties of its inline `style` set (a value) or removed (null). */
  | { kind: "restyle"; mid: string; set: StyleSet }
  /** Moved to `place` (drag to move). */
  | { kind: "move"; mid: string; place: DropPlace }
  /** A design system's snippet put at `place`, or at the end of the body. */
  | { kind: "insert"; place: DropPlace | null; html: string };

/** What an edit did to its element, as the agent is told. */
export type Change =
  | { kind: "text"; text: string }
  | { kind: "deleted" }
  | { kind: "duplicated"; copy: string }
  | { kind: "wrapped"; box: string }
  | { kind: "unwrapped" }
  /** Pasted or inserted at `place`, or (null) at the end of the body. */
  | { kind: "inserted"; place: DropPlace | null }
  /** Its inline style's properties set, or (null) removed. */
  | { kind: "restyled"; set: StyleSet }
  | { kind: "moved"; place: DropPlace };

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
      if (c.place === null) return "inserted at the end of the body";
      return `inserted ${c.place.where === "below" ? "after" : c.place.where} ${c.place.ref}`;
    case "moved":
      return `moved ${c.place.where} ${c.place.ref}`;
    case "restyled":
      return `restyled with ${Object.entries(c.set)
        .map(([p, v]) => (v === null ? `no ${p}` : `${p}: ${v}`))
        .join("; ")}`;
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

/** Each element edited, in the order first edited, with its changes in
 *  order: a text change only as its latest, and its restyles as one, in
 *  the place of the first, each property at its latest value, each since
 *  the element's last undone change, so one made after an undo is said
 *  after it. */
function byElement(edits: Untold[]): { head: HandEdit; changes: string[] }[] {
  const out = new Map<string, { head: HandEdit; changes: string[]; text: number | null; style: { at: number; set: StyleSet } | null }>();
  for (const e of edits) {
    const key = `${e.page}\0${e.mid}`;
    const el = out.get(key) ?? { head: e, changes: [], text: null, style: null };
    out.set(key, el);
    const said = `${e.undone ? "undid " : ""}${changeText(e.change)}`;
    if (e.change.kind === "text" && !e.undone && el.text !== null) el.changes[el.text] = said;
    else if (e.change.kind === "text" && !e.undone) el.text = el.changes.push(said) - 1;
    else if (e.change.kind === "restyled" && !e.undone) {
      const set = { ...el.style?.set, ...e.change.set };
      const text = changeText({ kind: "restyled", set });
      if (el.style) el.changes[el.style.at] = text;
      el.style = { at: el.style ? el.style.at : el.changes.push(text) - 1, set };
    } else {
      el.changes.push(said);
      if (e.undone) el.text = el.style = null;
    }
  }
  return [...out.values()];
}

/** One line per element edited, in the order first edited: its changes in
 *  order, a text change only as its latest. */
export function editLines(edits: Untold[]): string[] {
  return byElement(edits).map((el) => elementLine(el.head, el.changes));
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
  const after = parsed(edit.html);
  const got = written(after);
  const added = [...got];
  for (const id of want) remove(added, id);
  const lost = want.filter((id) => !got.includes(id));
  if (lost.length || (added.length && !["duplicate", "wrap", "paste", "insert"].includes(op.kind))) {
    throw new EditRefused(`The page's markup around ${around(op)} is tangled: ask the agent to fix it`);
  }
  // The page read back must be the tree the live page gets: a box the
  // parser moves out of a <p> or a table's row, or a paste it moves, would
  // save another page than the canvas shows.
  if (JSON.stringify(reshaped(doc, edit.live)) !== JSON.stringify(tree(after).top)) {
    if (op.kind === "wrap") throw new EditRefused(`A box cannot go around ${op.mid} inside <${tagOf(find(doc, op.mid).parentNode)}>`);
    if (op.kind === "move") throw new EditRefused(`${op.mid} cannot go ${op.place.where} ${op.place.ref}: the page would not keep its structure`);
    throw new EditRefused(`The page would not keep its structure around ${around(op)}`);
  }
  return edit;
}

/** Where an edit is, as a refusal names it: its element, or where a paste
 *  or an insert goes. */
function around(op: EditOp): string {
  if (op.kind === "paste") return op.after ?? "the body";
  if (op.kind === "insert") return op.place?.ref ?? "the body";
  return op.mid;
}

/** An element in a page's tree: its tag, its id and its child elements. */
interface Shape {
  tag: string;
  mid: string | null;
  kids: Shape[];
}

/** The node whose children are `n`'s: a `<template>`'s content. */
const container = (n: Node): Node => (isElement(n) && n.tagName === "template" && "content" in n ? (n as DefaultTreeAdapterMap["template"]).content : n);

const tagOf = (n: Node | null) => (n && isElement(n) ? n.tagName : "its parent");

/** The tree of `root`'s elements, with each element's own shape and the
 *  list each node's children are in. */
function tree(root: Node) {
  const own = new Map<Element, Shape>();
  const kidsOf = new Map<Node, Shape[]>();
  const walk = (n: Node): Shape[] => {
    const box = container(n);
    const kids = ("childNodes" in box ? box.childNodes : []).filter(isElement).map((c) => {
      const s: Shape = { tag: c.tagName, mid: midOf(c), kids: walk(c) };
      own.set(c, s);
      return s;
    });
    kidsOf.set(box, kids);
    return kids;
  };
  return { top: walk(root), own, kidsOf };
}

/** The page `doc`'s tree with `live` made on it, as the live page makes it. */
function reshaped(doc: Node, live: LiveEdit | null): Shape[] {
  const t = tree(doc);
  /** The list element `mid` is in, and where. */
  const place = (mid: string): [Shape[], number] => {
    const el = find(doc, mid);
    const list = t.kidsOf.get(el.parentNode!)!;
    return [list, list.indexOf(t.own.get(el)!)];
  };
  if (!live) return t.top;
  /** Shapes put above or below an element, or into it, last. */
  const putAt = ({ where, ref }: DropPlace, shapes: Shape[]) => {
    if (where === "into") return void t.own.get(find(doc, ref))!.kids.push(...shapes);
    const [to, j] = place(ref);
    to.splice(where === "above" ? j : j + 1, 0, ...shapes);
  };
  if (live.op === "insert") {
    const added = tree(parseFragment(live.html)).top;
    if (live.place) putAt(live.place, added);
    else {
      const body = [...elements(doc)].find((e) => e.tagName === "body");
      if (body) t.kidsOf.get(body)!.unshift(...added);
    }
    return t.top;
  }
  if (live.op === "style") return t.top;
  const [list, i] = place(live.mid);
  if (live.op === "move") {
    putAt(live.place, list.splice(i, 1));
    return t.top;
  }
  if (live.op === "remove") list.splice(i, 1);
  if (live.op === "wrap") list.splice(i, 1, { tag: "div", mid: live.box, kids: [list[i]] });
  if (live.op === "unwrap") list.splice(i, 1, ...list[i].kids);
  return t.top;
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
  if (op.kind === "insert") return insert(html, doc, op.place, op.html, floor);
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
      const ids = freshIds(html, floor);
      const copy = renumbered(html, el, ids);
      return { html: after(html, outer(el), copy), select: ids.taken[0], change: { ...who(el), change: { kind: "duplicated", copy: ids.taken[0] } }, live: { op: "insert", place: { where: "below", ref: op.mid }, html: copy } };
    }
    case "wrap": {
      inBody(el);
      const box = freshIds(html, floor).take();
      const [from, to] = outer(el);
      return { html: splice(html, [from, to], `<div data-mid="${box}">${html.slice(from, to)}</div>`), select: box, change: { ...who(el), change: { kind: "wrapped", box } }, live: { op: "wrap", mid: op.mid, box } };
    }
    case "restyle":
      return restyle(html, el, op.set);
    case "move":
      return move(html, doc, el, op.place);
    case "unwrap": {
      inBody(el);
      const [a, b] = inner(el);
      if (a >= b) throw new EditRefused(`<${el.tagName}> ${op.mid} has nothing inside to keep`);
      const first = el.childNodes.filter(isElement).map(midOf).find((m) => m !== null);
      return { html: splice(html, outer(el), html.slice(a, b)), select: first ?? parentMid(el), change: { ...who(el), change: { kind: "unwrapped" } }, live: { op: "unwrap", mid: op.mid } };
    }
  }
}

/** Elements that hold no elements of the page: void ones, those whose
 *  inside is not the page's (scripts, styles, raw text, an <svg>'s or
 *  <math>'s drawing), form controls, and embedded content. The bridge
 *  (`design_bridge.js`) keeps the same list, which a test checks. */
export const HOLDS_NO_ELEMENTS = ["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr", "svg", "math", "select", "option", "textarea", "script", "style", "title", "template", "noscript", "xmp", "iframe", "noembed", "noframes", "plaintext", "object", "video", "audio", "canvas"] as const;
const HOLDS_NONE = new Set<string>(HOLDS_NO_ELEMENTS);

/** `el` moved to `place`: taken out with its line when it has the line to
 *  itself, and put above or below element `ref`, on a line of its own
 *  indented as `ref` when `ref` has its line, or into `ref` after its last
 *  child, on a line of its own indented as that child when the end tag has
 *  its line. Never into itself, into an element that holds no elements,
 *  or the body moved. */
function move(html: string, doc: Node, el: Element, place: DropPlace): Edit {
  inBody(el);
  const mid = midOf(el)!;
  const ref = find(doc, place.ref);
  for (let p: Node | null = ref; p && isElement(p); p = p.parentNode) if (p === el) throw new EditRefused(`${mid} cannot go inside itself`);
  if (place.where === "into") {
    if (ref.tagName !== "body") inBody(ref);
    holds(ref);
  } else inBody(ref);
  const text = html.slice(...outer(el));
  const rest = splice(html, line(html, outer(el)), "");
  const target = find(parsed(rest), place.ref);
  const out = place.where === "above" ? before(rest, outer(target), text) : place.where === "below" ? after(rest, outer(target), text) : into(rest, target, text);
  return { html: out, select: mid, change: { ...who(el), change: { kind: "moved", place } }, live: { op: "move", mid, place } };
}

/** Refuses an element that holds no elements of the page. */
function holds(ref: Element) {
  const none = () => new EditRefused(`<${ref.tagName}> ${midOf(ref)} holds no elements`);
  if (HOLDS_NONE.has(ref.tagName)) throw none();
  for (let p = ref.parentNode; p && isElement(p); p = p.parentNode) if (p.tagName === "svg" || p.tagName === "math") throw none();
}

/** `html` with `text` put before `span`: on a line of its own, indented as
 *  `span`, when `span` has its line to itself; else right before it. */
function before(html: string, span: [number, number], text: string): string {
  const [from, to] = span;
  const whole = line(html, span);
  if (whole[0] === from && whole[1] === to) return splice(html, [from, from], text);
  const indent = html.slice(whole[0], from);
  return splice(html, [from, from], text + eolOf(html, to, whole[1]) + indent);
}

/** The line end after `to` on its line, else the page's. */
function eolOf(html: string, to: number, end: number): string {
  return html.slice(to, end).match(/\r?\n/)?.[0] ?? (html.includes("\r\n") ? "\r\n" : "\n");
}

/** `html` with `text` put into element `el` after its last child: when its
 *  end tag has its line to itself, on a line of its own before it,
 *  indented as its last element child when that has its line, else one
 *  step in from the end tag; else right before the end tag. */
function into(html: string, el: Element, text: string): string {
  const loc = el.sourceCodeLocation!;
  const at = loc.endTag ? loc.endTag.startOffset : loc.endOffset;
  const start = html.lastIndexOf("\n", at - 1) + 1;
  if (!loc.endTag || /\S/.test(html.slice(start, at))) return splice(html, [at, at], text);
  const last = el.childNodes.filter(isElement).at(-1);
  const own = last ? line(html, outer(last)) : null;
  const indent = own && last && own[0] !== outer(last)[0] ? html.slice(own[0], outer(last)[0]) : html.slice(start, at) + "  ";
  return splice(html, [start, start], indent + text + eolOf(html, at, html.length));
}

/** `el` with its inline style's properties set or removed, spliced, the
 *  rest of its style kept as written (designStyle's `restyled`); the
 *  attribute is written in double quotes after the element's others, and
 *  removed once nothing is left in it. A property or value that is not one
 *  is refused. */
function restyle(html: string, el: Element, set: StyleSet): Edit {
  inBody(el);
  const loc = el.sourceCodeLocation!;
  const old = el.attrs.find((a) => a.name === "style");
  const had = parseStyle(old?.value ?? "");
  for (const [prop, value] of Object.entries(set)) {
    if (!isStyleProp(prop)) throw new EditRefused(`${prop} is not a style property`);
    // Parts the property's value already had (a background's image) stay
    // as written; only what is new must be a value the editor writes.
    const kept = valueParts(had.find(([p]) => p === prop)?.[1] ?? "");
    const fresh = value === null ? [] : valueParts(value).filter((p) => !kept.includes(p));
    if (value !== null && (fresh.length ? !isStyleValue(fresh.join(" ")) : !value.trim())) throw new EditRefused(`${value} is not a value the editor writes`);
  }
  const spliced = restyled(old?.value ?? "", set);
  const text = spliced.trim() ? spliced : "";
  const attr = text ? `style="${attrText(text)}"` : "";
  const at = loc.attrs?.style;
  let out: string;
  if (old && at) {
    // Removed with the space before it.
    const from = text ? at.startOffset : at.startOffset - (/\s+$/.exec(html.slice(0, at.startOffset))?.[0].length ?? 0);
    out = splice(html, [from, at.endOffset], attr);
  } else if (text) {
    // After its last attribute, before any space and `/>` or `>`.
    const end = loc.startTag!.endOffset;
    let close = html[end - 2] === "/" ? end - 2 : end - 1;
    while (/\s/.test(html[close - 1])) close--;
    out = splice(html, [close, close], ` ${attr}`);
  } else out = html;
  return { html: out, select: midOf(el), change: { ...who(el), change: { kind: "restyled", set } }, live: { op: "style", mid: midOf(el)!, style: text } };
}

/** The highest number of a `data-mid` in page `html`, anywhere in it
 *  (inside an `<svg>` and its other exceptions too); 0 for none. */
export function highestMid(html: string): number {
  // Read as with scripts off, so the inside of a <noscript>, which a page
  // running scripts reads as text, counts too.
  return highest(parse(html, { scriptingEnabled: false }));
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
function freshIds(html: string, floor = 0) {
  let next = Math.max(highestMid(html), floor) + 1;
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
function renumbered(html: string, el: Element, ids: ReturnType<typeof freshIds>, addMissing = false): string {
  const [from, to] = outer(el);
  // Each id's value where its attribute writes it; with `addMissing`, an
  // element that needs an id and has none gets one after its tag's name.
  const spans: { at: [number, number]; text: (id: string) => string }[] = [];
  for (const e of elements(el)) {
    const loc = e.sourceCodeLocation;
    const at = loc?.attrs?.["data-mid"];
    if (at && midOf(e)) spans.push({ at: attrValue(html, at), text: (id) => id });
    else if (addMissing && loc?.startTag && needsId(e, el)) {
      const end = loc.startTag.startOffset + 1 + e.tagName.length;
      spans.push({ at: [end, end], text: (id) => ` data-mid="${id}"` });
    }
  }
  let out = "";
  let at = from;
  for (const s of spans.sort((x, y) => x.at[0] - y.at[0])) {
    out += html.slice(at, s.at[0]) + s.text(ids.take());
    at = s.at[1];
  }
  return out + html.slice(at, to);
}

/** Where an attribute's value is written in `html`, from the attribute's own
 *  place in the source: after its `=`, inside its quotes if it has them, as
 *  written (an entity in it included). */
function attrValue(html: string, at: { startOffset: number; endOffset: number }): [number, number] {
  const m = /=\s*(["']?)/.exec(html.slice(at.startOffset, at.endOffset));
  if (!m) throw new EditRefused("An element's data-mid has no value");
  return [at.startOffset + m.index + m[0].length, at.endOffset - m[1].length];
}

/** `html` with `text` put after `span`: on a line of its own, indented as
 *  `span`, when `span` has its line to itself; else right after it. */
function after(html: string, span: [number, number], text: string): string {
  const [from, to] = span;
  const whole = line(html, span);
  if (whole[0] === from && whole[1] === to) return splice(html, [to, to], text);
  const indent = html.slice(whole[0], from);
  return splice(html, [to, to], eolOf(html, to, whole[1]) + indent + text);
}

/** The inline style of each element of page `html` that has one, by its
 *  `data-mid`, as its source writes it (designStyle's parse). */
export function inlineStyles(html: string): Record<string, Decl[]> {
  const out: Record<string, Decl[]> = {};
  for (const el of elements(parsed(html))) {
    const mid = midOf(el);
    const style = el.attrs.find((a) => a.name === "style")?.value;
    const decls = mid && style ? parseStyle(style) : [];
    if (mid && decls.length) out[mid] = decls;
  }
  return out;
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
  return placed(html, doc, mid === null ? null : { where: "below", ref: mid }, copied.slice(...outer(root)), floor);
}

/** A design system's snippet inserted at `place`, else at the end of the
 *  body: one element as it is, several in a `div`, every element given a
 *  fresh id. */
function insert(html: string, doc: Node, place: DropPlace | null, snippet: string, floor: number): Edit {
  const nodes = parseFragment(snippet, { sourceCodeLocationInfo: true }).childNodes.filter((n) => n.nodeName !== "#comment" && !(n.nodeName === "#text" && !/\S/.test((n as DefaultTreeAdapterMap["textNode"]).value)));
  if (!nodes.some(isElement)) throw new EditRefused("The snippet has no element to insert");
  const one = nodes.length === 1 ? (nodes[0] as Element) : null;
  return placed(html, doc, place, one ? snippet.slice(...outer(one)) : `<div>${snippet.trim()}</div>`, floor);
}

/** Element source `source` put at `place`, else after the body's last
 *  element with an id, else first in the body, with its ids fresh. */
function placed(html: string, doc: Node, place: DropPlace | null, source: string, floor: number): Edit {
  const ids = freshIds(html, floor);
  const root = parseFragment(source, { sourceCodeLocationInfo: true }).childNodes.find(isElement)!;
  const text = renumbered(source, root, ids, true);
  const change = { mid: ids.taken[0], tag: root.tagName, change: { kind: "inserted", place } as const };
  const select = ids.taken[0];
  if (place) {
    const ref = find(doc, place.ref);
    if (place.where === "into") holds(ref);
    else inBody(ref);
    if (place.where === "above") return { html: before(html, outer(ref), text), select, change, live: { op: "insert", place, html: text } };
    if (place.where === "into") return { html: into(html, ref, text), select, change, live: { op: "insert", place, html: text } };
    return { html: after(html, outer(ref), text), select, change, live: { op: "insert", place, html: text } };
  }
  const body = [...elements(doc)].find((e) => e.tagName === "body");
  const last = body?.childNodes.filter(isElement).filter((e) => midOf(e) !== null && e.sourceCodeLocation).at(-1);
  if (last) return { html: after(html, outer(last), text), select, change, live: { op: "insert", place: { where: "below", ref: midOf(last)! }, html: text } };
  const start = body?.sourceCodeLocation?.startTag?.endOffset;
  if (start === undefined) throw new EditRefused("The page has no body to paste into");
  return { html: splice(html, [start, start], text), select, change, live: { op: "insert", place: null, html: text } };
}

/** Elements that draw nothing of their own and get no id, as `moonlet
 *  design check` takes them. */
const NO_ID = new Set(["script", "style", "template", "noscript"]);

/** Whether element `e` inside `root` needs an id: not one of {@link
 *  NO_ID} or inside one, and not part of an <svg>'s or <math>'s drawing. */
function needsId(e: Element, root: Element): boolean {
  if (NO_ID.has(e.tagName)) return false;
  for (let p = e.parentNode; p && isElement(p) && e !== root; p = p.parentNode) {
    if (NO_ID.has(p.tagName) || p.tagName === "svg" || p.tagName === "math") return false;
    if (p === root) break;
  }
  return true;
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

/** The chip over the canvas: how many edits the next message tells the
 *  agent, one per change of an element, a text only as its latest, "3
 *  edits by hand · go with your next message"; null for none. */
export function editsChip(edits: Untold[]): string | null {
  const n = byElement(edits).reduce((sum, el) => sum + el.changes.length, 0);
  return n ? `${n} ${n === 1 ? "edit" : "edits"} by hand · go with your next message` : null;
}
