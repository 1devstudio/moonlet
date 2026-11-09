import type { DesignChanged } from "./protocol";

/** The account's design library (X95): design systems, and the designs
 *  shared with every workspace, are in its folder, not a workspace's. */
export const LIBRARY = "library";

/** The workspaces a `design.changed` is for: a library design system's is
 *  every workspace's on its host, as each lists the library's systems. */
export function changedWorkspaces(change: DesignChanged, workspaces: string[]): string[] {
  return change.workspace === LIBRARY && change.system ? workspaces : [change.workspace];
}
