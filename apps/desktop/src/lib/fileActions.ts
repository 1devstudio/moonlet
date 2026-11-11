// File actions of the Files tab (X98): the decisions behind New file, Rename,
// Duplicate, Delete, drag to move and Open terminal here. Pure; the daemon
// does the work (`fs.create`, `fs.rename`, `fs.duplicate`, `fs.delete`).

import { parseCopyHost } from "./copyHost";
import type { ConfirmOptions } from "./confirmOptions";
import { hostPath, pathOn } from "./hostPath";
import { isUnder, movedPath } from "./layout";

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
  if (isUnder(folder, from) || folder === parentOf(from)) return null;
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

/** The unsaved marks after `from` moved to `to` on `host`. */
export function movedDirty(dirty: Readonly<Record<string, true>>, host: string, from: string, to: string): Record<string, true> {
  const out: Record<string, true> = {};
  for (const key of Object.keys(dirty)) {
    const path = pathOn(host, key);
    const moved = path === null ? null : movedPath(path, from, to);
    out[moved === null ? key : hostPath(host, moved)] = true;
  }
  return out;
}

/** The unsaved marks of `path` on `host`, or of the files in it. */
export function dirtyUnder(dirty: Readonly<Record<string, true>>, host: string, path: string): string[] {
  return Object.keys(dirty).filter((key) => {
    const p = pathOn(host, key);
    return p !== null && isUnder(p, path);
  });
}

/** The question Delete asks: about the Trash when the host has one. */
export function deletePrompt(e: { name: string; dir: boolean; trash: boolean; unsaved: number }): ConfirmOptions {
  const question = e.trash ? `Move ${e.name} to the Trash?` : `Delete ${e.name}? This can't be undone.`;
  const lost = e.unsaved ? ` Unsaved edits in ${e.unsaved} open ${e.unsaved === 1 ? "file" : "files"} are lost.` : "";
  return { title: e.dir ? "Delete folder" : "Delete file", message: question + lost, action: e.trash ? "Move to Trash" : "Delete", variant: "danger" };
}
