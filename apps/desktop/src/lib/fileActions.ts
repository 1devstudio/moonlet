// File actions of the Files tab (X98): the decisions behind New file, Rename,
// Duplicate, Delete, drag to move and Open terminal here. Pure; the daemon
// does the work (`fs.create`, `fs.rename`, `fs.duplicate`, `fs.delete`).

import { parseCopyHost } from "./copyHost";

/** Why `name` can't be a file's or a folder's name, or null when it can.
 *  Spaces around it are dropped before it is used. */
export function nameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return "A name is needed";
  if (n === "." || n === "..") return `“${n}” can't be a name`;
  if (n.includes("/")) return "A name can't have a “/”";
  return null;
}

/** What Rename selects in the name field: the name up to its last
 *  extension, so typing replaces only the name. */
export function renameSelection(name: string, dir: boolean): [number, number] {
  const dot = name.lastIndexOf(".");
  return [0, !dir && dot > 0 ? dot : name.length];
}

/** The path an entry dragged from `from` moves to when dropped on the
 *  folder `folder`, or null where the drop would do nothing or can't be. */
export function dropTarget(from: string, folder: string): string | null {
  if (folder === from || folder.startsWith(`${from}/`) || folder === parentOf(from)) return null;
  return `${folder}/${baseName(from)}`;
}

/** The folder Open terminal here starts in. */
export function terminalFolder(e: { path: string; is_dir: boolean }): string {
  return e.is_dir ? e.path : parentOf(e.path);
}

/** The folder a path is in. */
export const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
/** The last part of a path: an entry's name. */
export const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Whether the Files tab of a session on `host` offers the file actions:
 *  not in another member's session (X72), whose files its member owns. */
export function offersFileActions(host: string): boolean {
  return !parseCopyHost(host);
}
