// The design system view and the card page (X64): their groups, header,
// banner and card frames. Pure: the store is designStore.ts.

import { ago } from "./mobile";
import { pagePath } from "./designPage";
import { designFolder, placeHost, taggedSlug, type DesignPlace } from "./designPlace";
import type { DesignCard, DesignSystem } from "./protocol";

export interface CardGroup {
  /** "" for all the cards; else the group's name. */
  key: string;
  name: string;
  count: number;
  /** A card in it has a check problem. */
  problem: boolean;
}

/** All, Foundations, the component groups by name, then Custom and Layouts. */
export function cardGroups(cards: DesignCard[]): CardGroup[] {
  const rank = (g: string) => (g === "Foundations" ? 0 : g === "Custom" ? 2 : g === "Layouts" ? 3 : 1);
  const names = [...new Set(cards.map((c) => c.group))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const group = (key: string, name: string, of: DesignCard[]) => ({ key, name, count: of.length, problem: of.some((c) => c.problems.length > 0) });
  return [group("", "All", cards), ...names.map((n) => group(n, n, cards.filter((c) => c.group === n)))];
}

export interface CardFilters {
  /** A group's key ("" for all). */
  group: string;
  onlyProblems: boolean;
  onlyChanged: boolean;
}

/** The cards the view shows, and the filters in force: a filter lets go
 *  once no card matches it, so the grid never goes blank with no way back. */
export function visibleCards(cards: DesignCard[], f: CardFilters): { cards: DesignCard[]; onlyProblems: boolean; onlyChanged: boolean } {
  const onlyProblems = f.onlyProblems && cards.some((c) => c.problems.length > 0);
  const onlyChanged = f.onlyChanged && cards.some((c) => c.changed_sources.length > 0);
  return {
    cards: cards.filter((c) => (f.group === "" || c.group === f.group) && (!onlyProblems || c.problems.length > 0) && (!onlyChanged || c.changed_sources.length > 0)),
    onlyProblems,
    onlyChanged,
  };
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
  const them = n === 1 ? "it" : "them";
  const rewrites = made === 0 ? `No card is made from ${them}.` : `A sync rewrites only ${made === 1 ? "the card" : `the ${made} cards`} made from ${them}.`;
  return `${plural(n, "source")} changed since sync · ${sys.changed_sources.map(base).join(", ")}. ${rewrites}`;
}

/** A file of a workspace's design folder, or of a session's worktree's
 *  design folder (`path`, relative to it), on the `moonlet-design://`
 *  scheme, on a host of its own, `<key>.<workspace>` or `<key>.s-<session>`
 *  (X65), so WebKit's site isolation gives each file its own web process
 *  and one that never stops running blocks no other (X64, X65). The key is
 *  the 64-bit FNV-1a hash, in hex, of `path`: the same file always gets the
 *  same host. `rev`, its changes so far, makes a frame load it again after
 *  one; `query` asks the scheme for more, such as the comment bridge.
 *  `design_scheme.rs` (`target`) parses it. */
export function designUrl(place: DesignPlace, path: string, rev = 0, query: Record<string, string> = {}, key = fnv1a64(path)): string {
  const url = `moonlet-design://${key}.${placeHost(place)}/${path.split("/").map(encodeURIComponent).join("/")}`;
  const params = new URLSearchParams({ ...(rev ? { v: String(rev) } : {}), ...query }).toString();
  return params ? `${url}?${params}` : url;
}

/** A design system's card (`path` in the system) on a host of its own (X64). */
export function cardUrl(workspace: string, slug: string, path: string, rev = 0): string {
  return designUrl(workspace, `systems/${slug}/${path}`, rev);
}

/** A design's page (`index` for `pages/index.html`) on a host of its own
 *  (X65), a workspace design's or a session design's. `bridge`: served
 *  with the comment bridge, which the canvas talks to (`design_scheme.rs`
 *  `bridging`). */
export function pageUrl(place: DesignPlace, design: string, page: string, rev = 0, bridge = false): string {
  return designUrl(place, `${designFolder(place, design)}/${pagePath(page)}`, rev, bridge ? { "moonlet-bridge": "1" } : {});
}

/** Page `page` of design `design`'s snapshot `n`, read only: never with the
 *  bridge, so nothing on it can be picked or edited. Its folder is
 *  `designs/<design>@<n>/` (a session design's `<design>@<n>/`), which the
 *  daemon serves from the snapshot (`snapshot_file` in design/history.rs,
 *  `session_file` in design/session.rs), as deep as the design's own, so
 *  the page's relative links to its assets and its design system's
 *  styles resolve as they do for the design's pages. Its host's key is the
 *  page's, an `s`, then the folder's, on which the scheme serves only that
 *  snapshot's files and design systems' (`serves` in design_scheme.rs): a
 *  link in the page never shows the current page in the preview. */
export function snapshotPageUrl(place: DesignPlace, design: string, n: number, page: string): string {
  const folder = designFolder(place, taggedSlug(design, n));
  const path = `${folder}/${pagePath(page)}`;
  return designUrl(place, path, 0, {}, `${fnv1a64(path)}s${fnv1a64(folder)}`);
}

/** The 64-bit FNV-1a hash of `text`'s UTF-8 bytes, as 16 lowercase hex digits. */
function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return hash.toString(16).padStart(16, "0");
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
  // A problem in the card's own .css or .prompt.md names its file.
  const lines = card.problems.map((p) => `- ${p.path && p.path !== card.path ? `${p.path} ` : ""}line ${p.line}: ${p.message}`).join("\n");
  return `Fix the check problems of ${card.path}, then run the check again:\n${lines}`;
}

/** The line under the header: why the system cannot be read, what its agent
 *  waits for, or the step a sync is at; null when there is nothing to say. */
export function statusLine(sys: DesignSystem): string | null {
  if (sys.error) return sys.error;
  if (sys.needs_you) return `Claude ${sys.needs_you.kind === "question" ? "asks" : "needs your approval"}: ${sys.needs_you.text}`;
  if (sys.step) return `${sys.step[0].toUpperCase()}${sys.step.slice(1)}${sys.step_summary ? ` · ${sys.step_summary}` : ""}`;
  return null;
}

/** The cards the view may show: none of a system that cannot be read. */
export function listedCards(sys: DesignSystem, listed: DesignCard[] | undefined): DesignCard[] | undefined {
  return sys.error ? undefined : listed;
}

/** "1 check problem", "3 check problems". */
export function problemsLabel(n: number): string {
  return plural(n, "check problem");
}

/** Cards render only on this Mac: their files are read here (ADR 0013). */
export function rendersHere(host: string): boolean {
  return host === "local";
}

const ZOOMS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

/** The next zoom step from `zoom`, up (1) or down (-1), within 25% and
 *  `max` (400% for a card, X64; 200% for a design's canvas, X65). */
export function zoomStep(zoom: number, dir: 1 | -1, max = 4): number {
  const steps = ZOOMS.filter((z) => z <= max);
  const next = dir === 1 ? steps.find((z) => z > zoom + 1e-9) : [...steps].reverse().find((z) => z < zoom - 1e-9);
  return next ?? zoom;
}

/** **Ask the sync agent to fix**: only to its running agent, once at a time;
 *  a sync is never started for it. */
export function fixState(agent: number | null, asking: boolean): { enabled: boolean; hint: string | null } {
  if (agent === null) return { enabled: false, hint: "Its sync agent is not running. Sync starts it." };
  return { enabled: !asking, hint: null };
}
