// A session's files, as the daemon lists them (ignored files left out), for
// the chat's @ list and file links (X30) and Open file (X96).

import { rpc } from "./daemon";
import { M } from "./protocol";
import { hostPath } from "./store";

const fileCache = new Map<string, Promise<string[]>>();

/** Project-relative paths of the files under `root`, kept for 30 s; `fresh` reads the disk again. */
export function projectFiles(host: string, root: string, fresh = false): Promise<string[]> {
  const key = hostPath(host, root);
  let p = fresh ? undefined : fileCache.get(key);
  if (!p) {
    p = rpc<string[]>(host, M.fsFiles, { root }).catch(() => [] as string[]);
    fileCache.set(key, p);
    // Refresh on the next use after a while.
    setTimeout(() => fileCache.delete(key), 30_000);
  }
  return p;
}
