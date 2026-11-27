// What the copy buttons beside a path in a header copy: a file's path in its
// worktree and its full path on disk.

export interface CopyChoice {
  label: string;
  text: string;
}

/** A file's copies, from `path` relative to the worktree `root` or full:
 *  the path in the worktree and the full path; the full path alone for a
 *  file outside the worktree or with none. */
export function fileCopies(root: string | null, path: string): CopyChoice[] {
  const base = root?.replace(/\/+$/, "") ?? null;
  const full = path.startsWith("/") || base === null ? path : `${base}/${path}`;
  const rel = base !== null && full.startsWith(`${base}/`) ? full.slice(base.length + 1) : null;
  const fullCopy = { label: "Copy full path", text: full };
  return rel === null ? [fullCopy] : [{ label: "Copy path", text: rel }, fullCopy];
}
