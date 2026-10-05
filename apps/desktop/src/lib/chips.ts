// The context chips above the shell input editor (T8): node version,
// directory, branch and uncommitted changes.

import { shortPath } from "./terminals";

export type Chip =
  | { kind: "node" | "dir" | "branch"; text: string }
  | { kind: "changes"; text: string; files: number; additions: number; deletions: number };

type StatusFile = { staged: boolean; unstaged: boolean; status: string; additions: number; deletions: number };

/** Files with uncommitted changes (staged, unstaged or untracked) and their
 * line counts. Files only committed on the branch are in the status too. */
export function uncommitted(files: readonly StatusFile[]): { files: number; additions: number; deletions: number } {
  const open = files.filter((f) => f.staged || f.unstaged || f.status === "untracked");
  return { files: open.length, additions: open.reduce((n, f) => n + f.additions, 0), deletions: open.reduce((n, f) => n + f.deletions, 0) };
}

/** `5 • +113 -30`, as Warp writes uncommitted changes. */
export const changesText = (c: { files: number; additions: number; deletions: number }) => `${c.files} • +${c.additions} -${c.deletions}`;

export function chipModel(c: {
  cwd: string;
  home: string | null;
  nodeVersion?: string;
  branch?: string;
  /** The session's git status files; absent while unknown. */
  files?: readonly StatusFile[];
}): Chip[] {
  const chips: Chip[] = [];
  if (c.nodeVersion) chips.push({ kind: "node", text: c.nodeVersion });
  chips.push({ kind: "dir", text: shortPath(c.cwd, c.home) });
  if (c.branch) chips.push({ kind: "branch", text: c.branch });
  if (c.files) {
    const u = uncommitted(c.files);
    chips.push({ kind: "changes", text: changesText(u), ...u });
  }
  return chips;
}
