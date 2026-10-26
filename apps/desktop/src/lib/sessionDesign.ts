// A session's designs (X65): what its Design tab, its row in Sessions mode,
// its chat and its chat's slash menu show of them. Pure: the state is
// designStore.ts, the tab components/design/SessionDesign.tsx.

import { pagePath } from "./designPage";
import type { Design } from "./protocol";

/** The file above a session design's page: its path in the worktree, such
 *  as `docs/design/settings-page/pages/index.html`. */
export function worktreeFile(worktree: string, design: Design, page: string): string {
  const root = `${worktree.replace(/\/+$/, "")}/`;
  const folder = design.path.startsWith(root) ? design.path.slice(root.length) : design.path;
  return `${folder}/${pagePath(page)}`;
}
