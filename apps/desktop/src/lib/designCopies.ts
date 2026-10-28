// Design systems and workspace designs on every member (X71): each has an
// owner, where its agent runs, and a read-only copy on every other member.
// What the app reads from where, and what a copy says.

import { accountOf, type HostWorkspaces, type WorkspaceRef } from "./workspaces";

/** Who owns a listed design system or design: `owner` is null for the
 * host's own (an older daemon leaves both out). */
export interface Owned {
  owner?: { worker: string; name: string } | null;
  owner_agent?: boolean;
}

/** The host whose daemon Design mode reads workspace `ref`'s designs from:
 * this Mac whenever it is a member of the workspace's account and lists
 * it, since it holds a copy of each and the canvas frames this Mac's
 * folders, while its daemon is connected; else the shown host, as before
 * X71. */
export function designHost(ref: WorkspaceRef, hosts: HostWorkspaces[], localUp = true): string {
  const local = hosts.find((h) => h.host === "local");
  const member = !!local && localUp && (ref.host === "local" || (!!ref.account && accountOf(local) === ref.account));
  return member && local.workspaces.some((w) => w.id === ref.id) ? "local" : ref.host;
}

/** The session designs of a workspace on each of `hosts`, its members:
 *  session designs live in their session's worktree, on the host the
 *  session runs on, so each comes with that host. Undefined while no host
 *  has listed them. */
export function sessionDesignsAcross<D>(hosts: string[], listOf: (host: string) => D[] | undefined): { host: string; design: D }[] | undefined {
  const lists = hosts.map((host) => ({ host, list: listOf(host) }));
  if (lists.every((l) => l.list === undefined)) return undefined;
  return lists.flatMap(({ host, list }) => (list ?? []).map((design) => ({ host, design })));
}

/** `from studio-mini` for a copy; null for this host's own. */
export function copyLabel(item: Owned): string | null {
  return item.owner ? `from ${item.owner.name}` : null;
}

/** The line a copy's view shows above its content. */
export function copyNotice(item: Owned): string | null {
  return item.owner ? `A copy from ${item.owner.name} · read only` : null;
}

/** `Syncing on studio-mini` while the owner's agent works on a copy. */
export function ownerWorking(item: Owned, kind: "system" | "design"): string | null {
  if (!item.owner || !item.owner_agent) return null;
  return `${kind === "system" ? "Syncing" : "Working"} on ${item.owner.name}`;
}

/** The confirmation before **Move here**; `force` while the owner looks
 * busy, which `design.move` otherwise refuses. */
export function moveConfirm(name: string, item: Owned, kind: "system" | "design"): { title: string; body: string; confirm: string; force: boolean } {
  const owner = item.owner?.name ?? "the other Mac";
  const busy = !!item.owner_agent;
  const runs = kind === "system" ? "Its sync agent will run on this Mac from now on, with this Mac's clones of its projects." : "Its agent will run on this Mac from now on.";
  return {
    title: `Move ${name} here?`,
    body: `${busy ? `${owner} looks busy: its agent is working on it, and its changes since the last snapshot stay there. ` : ""}${runs} ${owner} keeps a read-only copy.`,
    confirm: busy ? "Move anyway" : "Move here",
    force: busy,
  };
}
