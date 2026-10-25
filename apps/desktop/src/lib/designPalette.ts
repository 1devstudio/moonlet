// The Palette tab (X65): a design system's snippets (X64), each variant's
// markup in its card, which the visual editor inserts into a page. They
// come from the design's own system's cards (`design.kit`), nowhere else.

import { parse } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import type { DesignKitCard } from "./protocol";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

/** One snippet of a design system: `<group>/<name>/<variant>`, its card's
 *  group and name, and its markup. */
export interface Snippet {
  id: string;
  group: string;
  card: string;
  variant: string;
  html: string;
}

const isElement = (n: Node): n is Element => "tagName" in n;
const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value ?? null;

function* elements(root: Node): Generator<Element> {
  if (isElement(root)) yield root;
  for (const c of "childNodes" in root ? root.childNodes : []) yield* elements(c);
}

/** The snippets of `cards`, in their order: each `[data-snippet]` cell's
 *  `.ds-mount`, its markup as the card writes it. A cell without a mount
 *  has none. */
export function snippetsOf(cards: DesignKitCard[]): Snippet[] {
  const out: Snippet[] = [];
  for (const card of cards) {
    const doc = parse(card.html, { sourceCodeLocationInfo: true });
    for (const cell of elements(doc)) {
      const id = attr(cell, "data-snippet");
      if (!id) continue;
      const mount = [...elements(cell)].find((e) => (attr(e, "class") ?? "").split(/\s+/).includes("ds-mount"));
      const loc = mount?.sourceCodeLocation;
      if (!loc?.startTag || !loc.endTag) continue;
      const html = card.html.slice(loc.startTag.endOffset, loc.endTag.startOffset).trim();
      if (!html) continue;
      out.push({ id, group: card.group, card: card.name, variant: id.split("/").at(-1) ?? id, html });
    }
  }
  return out;
}

/** The snippets by group, in their order, those whose card, variant, group
 *  or id has every word of `query`, any case. */
export function paletteGroups(snippets: Snippet[], query: string): { group: string; snippets: Snippet[] }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const groups: { group: string; snippets: Snippet[] }[] = [];
  for (const s of snippets) {
    const text = `${s.group} ${s.card} ${s.variant} ${s.id}`.toLowerCase();
    if (!words.every((w) => text.includes(w))) continue;
    const g = groups.find((x) => x.group === s.group) ?? groups[groups.push({ group: s.group, snippets: [] }) - 1];
    g.snippets.push(s);
  }
  return groups;
}
