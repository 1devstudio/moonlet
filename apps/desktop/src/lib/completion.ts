// The Tab completion popup of the shell input editor (T8).

export type CandidateKind = "dir" | "file" | "command";
export interface Completion {
  name: string;
  kind: CandidateKind;
  label: "Directory" | "File" | "Command";
  /** Length of the typed prefix, drawn bold. */
  match: number;
  /** Text that replaces the typed stem when the row is accepted. */
  insert: string;
}

const LABEL = { dir: "Directory", file: "File", command: "Command" } as const;
const ORDER = { dir: 0, file: 1, command: 2 } as const;
const MAX_ROWS = 200;

/** Rows for the candidates that extend `stem`: directories, then files,
 * then commands, each alphabetical. Dotfiles only when the stem starts
 * with a dot (T6 rules). */
export function completionModel(candidates: readonly { name: string; kind: CandidateKind }[], stem: string): Completion[] {
  return matches(candidates, stem)
    .sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.name.localeCompare(b.name))
    .slice(0, MAX_ROWS)
    .map((c) => ({ name: c.name, kind: c.kind, label: LABEL[c.kind], match: stem.length, insert: insertFor(c) }));
}

/** What Tab puts in place of `stem` (T6, T8): a single match whole, or the
 * prefix shared by every match, not only the rows the popup shows. */
export function completionInsert(candidates: readonly { name: string; kind: CandidateKind }[], stem: string): string {
  const all = matches(candidates, stem);
  if (all.length === 1) return insertFor(all[0]);
  let prefix = all.length ? all[0].name : stem;
  for (const c of all) {
    let i = 0;
    while (i < prefix.length && prefix[i] === c.name[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return shellEscape(prefix);
}

const matches = (candidates: readonly { name: string; kind: CandidateKind }[], stem: string) =>
  candidates.filter((c) => c.name.startsWith(stem) && (c.kind === "command" || stem.startsWith(".") || !c.name.startsWith(".")));

const insertFor = (c: { name: string; kind: CandidateKind }) => shellEscape(c.name) + (c.kind === "dir" ? "/" : " ");

/** Backslash-escapes what zsh, bash and fish would split or expand. */
function shellEscape(name: string): string {
  return name.replace(/[\s'"\\$`&|;<>()*?[\]{}!#~]/g, "\\$&");
}

/** The highlighted row after ↑ (`-1`) or ↓ (`1`), wrapping around. */
export function moveHighlight(count: number, current: number, delta: -1 | 1): number {
  return (current + delta + count) % count;
}
