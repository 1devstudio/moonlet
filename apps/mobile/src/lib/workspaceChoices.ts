import type { Workspace, WorkspaceColor } from "@desktop/lib/protocol";

/** Workspace names across hosts, once each, first host's colour (X40). */
export function workspaceChoices(perHost: Workspace[][]): { name: string; color: WorkspaceColor }[] {
  const seen = new Map<string, WorkspaceColor>();
  for (const list of perHost) for (const w of list) if (!seen.has(w.name)) seen.set(w.name, w.color);
  return [...seen].map(([name, color]) => ({ name, color }));
}
