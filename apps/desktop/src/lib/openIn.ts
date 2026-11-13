import type { HostKind } from "./protocol";

export interface OpenTarget {
  id: string;
  label: string;
}

/** Apps that open a folder as a shell, not a file. */
const TERMINALS = ["iterm", "ghostty", "terminal"];
/** Apps that open folders on an SSH host (see `open_in`). */
const REMOTE = ["vscode", "cursor"];

/** Apps that open a lone file in whichever of their windows is in front. */
const PROJECT_EDITORS = ["zed"];

/**
 * What a Files tab entry opens in `target`, and on which host. An entry of
 * a session kept in sync opens in its copy on this Mac (X60). Zed, already
 * running, puts a lone file in the window in front, often another
 * project's, so a file opens with its worktree (`root`) and a folder opens
 * the worktree itself.
 */
export function entryOpenIn(target: string, entry: { path: string; dir: boolean }, at: { host: string; session: string; copy: string | null }): { path: string; host?: string; root?: string } {
  const copied = at.copy === null ? null : inCopy({ copy: at.copy, session: at.session }, entry.path);
  const where = at.copy !== null && copied !== null ? { path: copied, host: undefined, root: trimSlash(at.copy) } : { path: entry.path, host: at.host, root: trimSlash(at.session) };
  if (!PROJECT_EDITORS.includes(target)) return { path: where.path, host: where.host };
  return entry.dir ? { path: where.root, host: where.host } : where;
}

const trimSlash = (p: string) => p.replace(/\/$/, "");

/** `path` of the session at the same place under its copy, or null for a path outside the session. */
function inCopy(roots: { copy: string; session: string }, path: string): string | null {
  const root = trimSlash(roots.session);
  const rel = path === root ? "" : path.startsWith(`${root}/`) ? path.slice(root.length) : null;
  return rel === null ? null : `${trimSlash(roots.copy)}${rel}`;
}

/**
 * The "Open in" choices of a Files tab entry (X25), from the app's
 * `open_targets`. Finder reveals the entry rather than opening it: `open`
 * runs a file with its default app and launches a folder named `Foo.app`,
 * and a repository's names are not to be trusted.
 */
export function openInChoices(targets: OpenTarget[], { dir, kind }: { dir: boolean; kind: HostKind }): OpenTarget[] {
  // Editors reach a remote folder only over SSH (`ssh-remote+`), which a
  // tailnet host does not have (X57).
  if (kind !== "local") return workspaceOpenTargets(targets, kind);
  return targets
    .filter((t) => dir || !TERMINALS.includes(t.id))
    .map((t) => (t.id === "finder" ? { ...t, id: "reveal" } : t));
}

/** The "Open in" choices for a workspace's folder, by how its host is reached. */
export function workspaceOpenTargets(targets: OpenTarget[], kind: HostKind): OpenTarget[] {
  if (kind === "tailnet") return [];
  if (kind === "ssh") return targets.filter((t) => REMOTE.includes(t.id));
  return targets;
}

/**
 * Open in for an entry of a session kept in sync (X60): its copy on this
 * Mac, at the same place under the copy as under the session, with this
 * Mac's apps. Null without a copy, or for a path outside the session.
 */
export function syncedOpenIn(targets: OpenTarget[], dir: boolean, roots: { copy: string | null; session: string }, path: string): { path: string; choices: OpenTarget[] } | null {
  if (!roots.copy) return null;
  const copied = inCopy({ copy: roots.copy, session: roots.session }, path);
  return copied === null ? null : { path: copied, choices: openInChoices(targets, { dir, kind: "local" }) };
}

/** The session header's Open in (X25): a session kept in sync opens from its
 * copy with this Mac's apps (X60); any other where it is, with its host's. */
export function workspaceOpenIn(targets: OpenTarget[], ws: { kind: HostKind; host: string; path: string }, copyPath: string | null): { choices: OpenTarget[]; path: string; host: string | undefined } {
  if (copyPath) return { choices: workspaceOpenTargets(targets, "local"), path: copyPath, host: undefined };
  return { choices: workspaceOpenTargets(targets, ws.kind), path: ws.path, host: ws.host };
}
