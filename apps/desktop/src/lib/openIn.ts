import type { HostKind } from "./protocol";

export interface OpenTarget {
  id: string;
  label: string;
}

/** Apps that open a folder as a shell, not a file. */
const TERMINALS = ["iterm", "ghostty", "terminal"];
/** Apps that open folders on an SSH host (see `open_in`). */
const REMOTE = ["vscode", "cursor"];

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
  const root = roots.session.replace(/\/$/, "");
  const rel = path === root ? "" : path.startsWith(`${root}/`) ? path.slice(root.length) : null;
  if (rel === null) return null;
  return { path: `${roots.copy.replace(/\/$/, "")}${rel}`, choices: openInChoices(targets, { dir, kind: "local" }) };
}

/** The session header's Open in (X25): a session kept in sync opens from its
 * copy with this Mac's apps (X60); any other where it is, with its host's. */
export function workspaceOpenIn(targets: OpenTarget[], ws: { kind: HostKind; host: string; path: string }, copyPath: string | null): { choices: OpenTarget[]; path: string; host: string | undefined } {
  if (copyPath) return { choices: workspaceOpenTargets(targets, "local"), path: copyPath, host: undefined };
  return { choices: workspaceOpenTargets(targets, ws.kind), path: ws.path, host: ws.host };
}
