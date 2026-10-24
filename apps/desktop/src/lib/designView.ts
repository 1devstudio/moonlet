// The design system view and the card page (X64): their groups, header,
// banner and card frames. Pure: the store is designStore.ts.

import { ago } from "./mobile";
import type { DesignCard, DesignSystem } from "./protocol";

export interface CardGroup {
  name: string;
  count: number;
  /** A card in it has a check problem. */
  problem: boolean;
}

/** All, Foundations, the component groups by name, then Custom and Layouts. */
export function cardGroups(cards: DesignCard[]): CardGroup[] {
  const rank = (g: string) => (g === "Foundations" ? 0 : g === "Custom" ? 2 : g === "Layouts" ? 3 : 1);
  const names = [...new Set(cards.map((c) => c.group))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const group = (name: string, of: DesignCard[]) => ({ name, count: of.length, problem: of.some((c) => c.problems.length > 0) });
  return [group("All", cards), ...names.map((n) => group(n, cards.filter((c) => c.group === n)))];
}

const base = (path: string) => path.split("/").filter(Boolean).pop() ?? path;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "From moonlet · synced 3 days ago at 4db5585 · 11 cards". */
export function headerLine(sys: DesignSystem, projects: { path: string; name: string }[], cards: number, now: number): string {
  const from = sys.sources.map((s) => projects.find((p) => p.path === s)?.name ?? base(s)).join(", ");
  const synced = sys.synced_at === null ? "not synced yet" : `synced ${ago(now - sys.synced_at)}${sys.synced_commit ? ` at ${sys.synced_commit}` : ""}`;
  return `From ${from} · ${synced} · ${plural(cards, "card")}`;
}

/** The banner while sources changed since the sync, or null. */
export function changedBanner(sys: DesignSystem, cards: DesignCard[]): string | null {
  const n = sys.changed_sources.length;
  if (!n) return null;
  const made = cards.filter((c) => c.changed_sources.length > 0).length;
  const rewrites = made === 1 ? "the card made from it" : `the ${made} cards made from them`;
  return `${plural(n, "source")} changed since sync · ${sys.changed_sources.map(base).join(", ")}. A sync rewrites only ${rewrites}.`;
}

/** A card's URL on the `moonlet-design://` scheme. */
export function cardUrl(workspace: string, slug: string, path: string): string {
  return `moonlet-design://${encodeURIComponent(workspace)}/systems/${encodeURIComponent(slug)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** "7 variants", from its snippets; "" for a card with none. */
export function variantsLabel(card: DesignCard): string {
  return card.snippets.length ? plural(card.snippets.length, "variant") : "";
}

/** The zoom that fits `viewport` into `box`, at most 200%. */
export function fitScale(viewport: [number, number], box: [number, number]): number {
  return Math.min(box[0] / viewport[0], box[1] / viewport[1], 2);
}

/** What **Ask the sync agent to fix** sends. */
export function fixMessage(card: DesignCard): string {
  const lines = card.problems.map((p) => `- line ${p.line}: ${p.message}`).join("\n");
  return `Fix the check problems of ${card.path}, then run the check again:\n${lines}`;
}
