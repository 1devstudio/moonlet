// The workspace chip's choices (X40, X68): each workspace of an account
// once, whichever members list it, as the desktop's switcher lists them.

import type { WorkspaceColor } from "@desktop/lib/protocol";
import { accountOf, isShown, switcherRows, type HostWorkspaces, type WorkspaceRef } from "@desktop/lib/workspaces";
import type { HostData } from "./app";

export interface WorkspaceChoice {
  /** The workspace, on the first host listing it, and its account. */
  ref: WorkspaceRef & { account: string };
  name: string;
  color: WorkspaceColor;
  /** Which Mac made it, while another of the account's has its name. */
  from: string | null;
  /** The host's name above its first row, when several hosts have rows. */
  hostLabel: string | null;
}

/** Each host with data, as the desktop's switcher takes it. The phone loads
 * no Claude profiles, which only the switcher's summary names. */
export function hostWorkspaces(hosts: Record<string, { id: string; label: string }>, data: Record<string, HostData>): HostWorkspaces[] {
  return Object.values(hosts).flatMap((h) => {
    const d = data[h.id];
    return d ? [{ host: h.id, label: h.label, account: d.account, workspaces: d.workspaces, sections: d.sections, sessions: d.sessions, profiles: [] }] : [];
  });
}

export function workspaceChoices(list: HostWorkspaces[]): WorkspaceChoice[] {
  return switcherRows(list).map((r) => ({
    ref: { host: r.host, id: r.ws.id, account: r.account },
    name: r.ws.name,
    color: r.ws.color,
    from: r.from,
    hostLabel: r.hostLabel,
  }));
}

/**
 * The workspace shown, from the one kept: on its own host while that lists
 * it in the kept account, else on another member of that account. A name, kept before X68, is
 * the first workspace of that name. Null shows all workspaces, as when the
 * kept one is gone.
 */
export function shownWorkspace(kept: WorkspaceRef | string | null, list: HostWorkspaces[]): WorkspaceRef | null {
  if (kept === null) return null;
  if (typeof kept === "string") return workspaceChoices(list).find((c) => c.name === kept)?.ref ?? null;
  const lists = (h: HostWorkspaces) => h.workspaces.some((w) => w.id === kept.id);
  const inAccount = (h: HostWorkspaces) => !!kept.account && accountOf(h) === kept.account && lists(h);
  // Its own host while that is still in its account, else another member of
  // it; a host that left the account keeps the workspace as its own.
  const member =
    list.find((h) => h.host === kept.host && inAccount(h)) ?? list.find(inAccount) ?? list.find((h) => h.host === kept.host && lists(h));
  return member ? { host: member.host, id: kept.id, account: accountOf(member) } : null;
}

/** Whether workspace `id` of `host`, which shares `account`, is in what is
 * shown: everything, or the shown workspace on every member of its account. */
export function inShown(shown: WorkspaceRef | null, host: string, account: string | undefined, id: string): boolean {
  return shown === null || isShown(shown, host, id, accountOf({ host, account }));
}
