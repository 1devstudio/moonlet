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
export function openInChoices(targets: OpenTarget[], { dir, remote, tailnet = false }: { dir: boolean; remote: boolean; tailnet?: boolean }): OpenTarget[] {
  // Editors reach a remote folder only over SSH (`ssh-remote+`), which a
  // tailnet host does not have (X57).
  if (tailnet) return [];
  if (remote) return targets.filter((t) => REMOTE.includes(t.id));
  return targets
    .filter((t) => dir || !TERMINALS.includes(t.id))
    .map((t) => (t.id === "finder" ? { ...t, id: "reveal" } : t));
}

/** The "Open in" choices for a workspace's folder, by how its host is reached. */
export function workspaceOpenTargets(targets: OpenTarget[], kind: "local" | "ssh" | "tailnet"): OpenTarget[] {
  if (kind === "tailnet") return [];
  if (kind === "ssh") return targets.filter((t) => REMOTE.includes(t.id));
  return targets;
}
