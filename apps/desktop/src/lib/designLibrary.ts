import type { DesignChanged } from "./protocol";

/** The account's design library (X95): design systems, and the designs
 *  shared with every workspace, are in its folder, not a workspace's. */
export const LIBRARY = "library";

/** The workspaces a `design.changed` is for: a library design system's is
 *  every workspace's on its host, as each lists the library's systems. */
export function changedWorkspaces(change: DesignChanged, workspaces: string[]): string[] {
  return change.workspace === LIBRARY && change.system ? workspaces : [change.workspace];
}

/** The projects a new design system may be built from (X95): every
 *  workspace's, by workspace, the shown one first, then the others in the
 *  account's order. A project in several workspaces is listed once, under
 *  the first, and a workspace with none left is left out. */
export function sourcesByWorkspace<W extends { id: string }, P extends { id: string }>(
  workspaces: W[],
  shown: string,
  projectsOf: (workspace: string) => P[],
): { workspace: W; projects: P[] }[] {
  const ordered = [...workspaces.filter((w) => w.id === shown), ...workspaces.filter((w) => w.id !== shown)];
  const seen = new Set<string>();
  return ordered.flatMap((workspace) => {
    const projects = projectsOf(workspace.id).filter((p) => !seen.has(p.id) && (seen.add(p.id), true));
    return projects.length ? [{ workspace, projects }] : [];
  });
}
