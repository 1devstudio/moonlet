// The chat input's @ picker (X114): what `@<query>` finds, in sections,
// Plans · Designs · Files, and which one Tab narrows it to.

import type { ArtifactRow } from "./artifacts";
import { fuzzyFilter, fuzzyScore } from "./chat";

export type AtTab = "all" | "plan" | "design" | "file";
export type AtKind = Exclude<AtTab, "all">;

/** One row of the picker. `value`: a file's path, or an artifact's id. */
export interface AtRow {
  kind: AtKind;
  value: string;
  label: string;
  /** Where it lives: a file's folder, an artifact's home. */
  where: string;
  /** The artifact picked, for its chip. */
  artifact?: ArtifactRow;
}

export interface AtSection {
  kind: AtKind;
  rows: AtRow[];
  /** How many it found, shown or not. */
  total: number;
}

/** What `@<query>` found: the sections shown, in order, the empty ones
 *  left out, at most five rows each on All and 200 on the one section Tab
 *  narrowed to; and how many each section found, for the tabs. */
export interface AtFound {
  sections: AtSection[];
  totals: Partial<Record<AtKind, number>>;
}

const NARROWED = 200;

export function atSections(input: { files: readonly string[]; artifacts: readonly ArtifactRow[] }, query: string, tab: AtTab): AtFound {
  const limit = tab === "all" ? 5 : NARROWED;
  const artifactsOf = (kind: "plan" | "design") =>
    input.artifacts
      .filter((r) => r.info.kind === kind)
      .map((r) => [r, fuzzyScore(r.info.name, query)] as const)
      .filter((x): x is readonly [ArtifactRow, number] => x[1] !== null)
      .sort((a, b) => a[1] - b[1])
      .map(([r]) => r);
  const artifactRow = (kind: "plan" | "design") => (r: ArtifactRow): AtRow => ({ kind, value: r.info.id, label: r.info.name, where: r.usedBy ? `${r.home} · ${r.usedBy}` : r.home, artifact: r });
  // Files as ⌘P and the @ list rank them (X96, X30).
  const found = {
    plan: artifactsOf("plan"),
    design: artifactsOf("design"),
    file: fuzzyFilter(input.files, query, Number.MAX_SAFE_INTEGER),
  };
  const rowsOf = (kind: AtKind): AtRow[] =>
    kind === "file"
      ? found.file.slice(0, limit).map((f) => ({ kind: "file", value: f, label: f, where: f.slice(0, f.lastIndexOf("/") + 1) }))
      : found[kind].slice(0, limit).map(artifactRow(kind));
  const kinds: AtKind[] = ["plan", "design", "file"];
  const totals = Object.fromEntries(kinds.filter((k) => found[k].length > 0).map((k) => [k, found[k].length]));
  const sections = kinds.filter((k) => found[k].length > 0 && (tab === "all" || tab === k)).map((k) => ({ kind: k, total: found[k].length, rows: rowsOf(k) }));
  return { sections, totals };
}

/** The input after picking an artifact for the `@word` at the caret: the
 *  word goes, also past the caret, and one space stays between its sides. */
export function withoutToken(text: string, caret: number, token: { start: number }): { text: string; caret: number } {
  const rest = text.slice(caret).replace(/^\S*/, "");
  const head = text.slice(0, token.start);
  return { text: head + rest.replace(/^ /, head.endsWith(" ") || head === "" ? "" : " "), caret: head.length };
}

/** What a key does while the picker is open: Tab and ⇧Tab narrow, Enter
 *  picks the row selected, Esc closes it, rows or none; null leaves the
 *  key to the input. */
export function atKey(key: string, shift: boolean, rows: number): "next" | "back" | "pick" | "close" | null {
  if (key === "Tab") return shift ? "back" : "next";
  if (key === "Escape") return "close";
  if (key === "Enter" && !shift && rows > 0) return "pick";
  return null;
}

/** The rows in the order shown. */
export function atRows(sections: AtSection[]): AtRow[] {
  return sections.flatMap((s) => s.rows);
}

/** The tab Tab goes to, or ⇧Tab (`back`). */
const TABS: AtTab[] = ["all", "plan", "design", "file"];

export function nextAtTab(tab: AtTab, back: boolean): AtTab {
  const i = TABS.indexOf(tab);
  return TABS[(i + (back ? TABS.length - 1 : 1)) % TABS.length];
}
