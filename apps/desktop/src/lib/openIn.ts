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
 * Mac, at the same relative path, with this Mac's apps. Null without a
 * copy, or for a path outside the session.
 */
export function syncedOpenIn(targets: OpenTarget[], { dir }: { dir: boolean; kind: HostKind }, copyPath: string | null, sessionPath: string, path: string): { path: string; choices: OpenTarget[] } | null {
  if (!copyPath) return null;
  const root = sessionPath.replace(/\/$/, "");
  const rel = path === root ? "" : path.startsWith(`${root}/`) ? path.slice(root.length) : null;
  if (rel === null) return null;
  return { path: `${copyPath.replace(/\/$/, "")}${rel}`, choices: openInChoices(targets, { dir, kind: "local" }) };
}

/** Open in for the folder of a session kept in sync: its copy, with this Mac's apps (X60). */
export function syncedWorkspaceOpenIn(targets: OpenTarget[], copyPath: string | null): OpenTarget[] {
  return copyPath ? workspaceOpenTargets(targets, "local") : [];
}
