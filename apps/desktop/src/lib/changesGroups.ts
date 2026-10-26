// The Changes panel's groups in a session with a design (X65, D1): the
// design folder's files, the spec's and the code's. Pure: the panel is
// components/ChangesPanel.tsx.

import type { FileChange } from "./protocol";

export interface ChangeGroup {
  name: "Design" | "Spec" | "Code";
  /** In path order. */
  files: FileChange[];
}

/** What the Changes panel says under the groups: a session design's
 *  comments and snapshots stay out of the branch. */
export const NOT_COMMITTED = "Comments and snapshots stay in .moonlet/ and are not committed.";

/** The specs' folder. */
const SPECS = "docs/specs/";

/** A session's changed files as **Design** (its design folder, the one its
 *  designs are in, `docs/design/` unless the project's config sets another),
 *  **Spec** (`docs/specs/`) and **Code** (everything else), each in path
 *  order and left out when it has none; null in a session without a design
 *  (`designs`, their folders in `worktree`), whose files list as before. */
export function changesGroups(files: FileChange[], worktree: string, designs: { path: string }[]): ChangeGroup[] | null {
  if (!designs.length) return null;
  const root = `${worktree.replace(/\/+$/, "")}/`;
  const dirs = [...new Set(designs.map((d) => (d.path.startsWith(root) ? d.path.slice(root.length) : d.path).replace(/\/*[^/]+\/*$/, "/")))];
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const isDesign = (f: FileChange) => dirs.some((dir) => f.path.startsWith(dir));
  const isSpec = (f: FileChange) => f.path.startsWith(SPECS);
  const groups: ChangeGroup[] = [
    { name: "Design", files: sorted.filter(isDesign) },
    { name: "Spec", files: sorted.filter((f) => !isDesign(f) && isSpec(f)) },
    { name: "Code", files: sorted.filter((f) => !isDesign(f) && !isSpec(f)) },
  ];
  return groups.filter((g) => g.files.length > 0);
}
