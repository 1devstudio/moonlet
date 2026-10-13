// The Changes tab and the diff review (X40, D1–D3).

import { changeList } from "@desktop/lib/changes";
import type { FileDiff } from "@desktop/lib/patch";
import type { FileChange } from "@desktop/lib/protocol";

export type ListedFile = FileChange & { dir: string; name: string };

/** Changed files by folder (`src/components`, or "" at the top), each by name. */
export function folderGroups(files: FileChange[]): { dir: string; files: ListedFile[] }[] {
  const groups: { dir: string; files: ListedFile[] }[] = [];
  for (const f of changeList(files)) {
    const dir = f.dir.replace(/\/$/, "");
    const g = groups.find((x) => x.dir === dir);
    if (g) g.files.push(f);
    else groups.push({ dir, files: [f] });
  }
  for (const g of groups) g.files.sort((a, b) => a.name.localeCompare(b.name));
  return groups.sort((a, b) => a.dir.localeCompare(b.dir));
}

const LETTER: Record<FileChange["status"], string> = { modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "?", conflicted: "U" };

export const statusLetter = (f: FileChange) => LETTER[f.status];

export function commitLabel(files: FileChange[]): string {
  const n = files.filter((f) => f.staged).length;
  return n ? `Commit ${n} staged` : "Nothing staged";
}

export type DiffRow =
  | { kind: "hunk"; index: number; header: string }
  | { kind: "line"; hunk: number; sign: "+" | "-" | " "; text: string; old: number | null; new: number | null };

/** A file's diff as rows: each hunk's header, then its lines with their old
 * and new line numbers. */
export function diffRows(diff: FileDiff): DiffRow[] {
  const rows: DiffRow[] = [];
  diff.hunks.forEach((h, index) => {
    rows.push({ kind: "hunk", index, header: h.header });
    let o = h.oldStart;
    let n = h.newStart;
    for (const l of h.lines) {
      const sign = l[0];
      if (sign === "+") rows.push({ kind: "line", hunk: index, sign, text: l.slice(1), old: null, new: n++ });
      else if (sign === "-") rows.push({ kind: "line", hunk: index, sign, text: l.slice(1), old: o++, new: null });
      else if (sign === " ") rows.push({ kind: "line", hunk: index, sign, text: l.slice(1), old: o++, new: n++ });
    }
  });
  return rows;
}
