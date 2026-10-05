// The context chips above the shell input editor (T8): node version,
// directory, branch and uncommitted changes.

import { shortPath } from "./terminals";

export type Chip = { kind: "node" | "dir" | "branch" | "changes"; text: string };

export function chipModel(c: {
  cwd: string;
  home: string | null;
  nodeVersion?: string;
  branch?: string;
  /** The session's git status files; absent while unknown. */
  files?: readonly { staged: boolean; unstaged: boolean; status: string }[];
}): Chip[] {
  const chips: Chip[] = [];
  if (c.nodeVersion) chips.push({ kind: "node", text: c.nodeVersion });
  chips.push({ kind: "dir", text: shortPath(c.cwd, c.home) });
  if (c.branch) chips.push({ kind: "branch", text: c.branch });
  if (c.files) {
    // Files only committed on the branch are in the status too; they are not "uncommitted".
    const n = c.files.filter((f) => f.staged || f.unstaged || f.status === "untracked").length;
    chips.push({ kind: "changes", text: `± ${n}` });
  }
  return chips;
}
