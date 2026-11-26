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

/** The sections `query` finds, in order, the empty ones left out: at most
 *  five rows each on All, every row of the one section Tab narrowed to. */
export function atSections(input: { files: readonly string[]; artifacts: readonly ArtifactRow[] }, query: string, tab: AtTab): AtSection[] {
  const limit = tab === "all" ? 5 : 200;
  const artifactsOf = (kind: "plan" | "design"): AtRow[] =>
    input.artifacts
      .filter((r) => r.info.kind === kind)
      .map((r) => [r, fuzzyScore(r.info.name, query)] as const)
      .filter((x): x is readonly [ArtifactRow, number] => x[1] !== null)
      .sort((a, b) => a[1] - b[1])
      .map(([r]) => ({ kind, value: r.info.id, label: r.info.name, where: r.usedBy ? `${r.home} · ${r.usedBy}` : r.home, artifact: r }));
  // Files as ⌘P and the @ list rank them (X96, X30).
  const files: AtRow[] = fuzzyFilter(input.files, query, Number.MAX_SAFE_INTEGER).map((f) => ({ kind: "file", value: f, label: f, where: f.slice(0, f.lastIndexOf("/") + 1) }));
  const all: AtSection[] = [
    { kind: "plan", rows: artifactsOf("plan"), total: 0 },
    { kind: "design", rows: artifactsOf("design"), total: 0 },
    { kind: "file", rows: files, total: 0 },
  ];
  return all
    .filter((s) => s.rows.length > 0 && (tab === "all" || tab === s.kind))
    .map((s) => ({ kind: s.kind, total: s.rows.length, rows: s.rows.slice(0, limit) }));
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
