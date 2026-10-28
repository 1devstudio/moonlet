// Updating a tailnet host from this Mac (X69): which hosts the app offers to
// update, Update all, and following one update until the host is back on
// the new version.

import type { RpcError } from "./daemon";
import type { HostInfo } from "./protocol";
import { INSTALL_COMMAND, older } from "./settingsPage";

/** How long after the reply the host has to come back. */
export const COME_BACK_MS = 60_000;

/** An update running or failed on one host. */
export type HostUpdate = { phase: "updating"; to: string; since: number } | { phase: "failed"; text: string; command: string | null };

/** The version to offer `h`: this Mac's, for an older tailnet host it can
 * reach; null otherwise. */
export function updateOffer(h: HostInfo, appVersion: string): string | null {
  if (h.kind !== "tailnet" || !appVersion || !h.daemon_version) return null;
  if (h.status !== "connected" && h.status !== "needs_update") return null;
  return older(h.daemon_version, appVersion) ? appVersion : null;
}

/** The hosts Update all takes: older ones not updating already. */
export const olderHosts = (hosts: HostInfo[], appVersion: string, updates: Record<string, HostUpdate> = {}) =>
  hosts.filter((h) => updateOffer(h, appVersion) !== null && updates[h.id]?.phase !== "updating");

export const updateAllLabel = (n: number) => `Update all (${n})`;

/** What the toast and the Update all row say when hosts run an older
 * moonlet; null when none does. */
export function olderHostsText(hosts: HostInfo[], appVersion: string, updates: Record<string, HostUpdate> = {}): string | null {
  const stale = olderHosts(hosts, appVersion, updates);
  if (stale.length === 0) return null;
  return stale.length === 1 ? `${stale[0].label} runs an older moonlet` : `${stale.length} hosts run an older moonlet`;
}

/** What a failed `daemon.update` leaves on the host's row. A host from
 * before X69 (`too_old`) gets the manual way, as before (X58). */
export function updateFailed(h: HostInfo, e: RpcError): HostUpdate {
  if (e.code !== "too_old") return { phase: "failed", text: e.message, command: null };
  if (h.os === "linux") return { phase: "failed", text: `${e.message}: run this there`, command: INSTALL_COMMAND };
  if (h.os === "macos") return { phase: "failed", text: `${e.message}. Update it from its Settings › Updates.`, command: null };
  // A connected host's OS is known only after a protocol mismatch (X58).
  return { phase: "failed", text: `${e.message}. On Linux, run this there; on a Mac, use its Settings › Updates.`, command: INSTALL_COMMAND };
}

/** The next state of update `u` now that host `h` is as it is, and whether
 * to ask it to connect again (it waits for a retry in `needs_update` or after
 * an error). `next` null: the host runs the new version. */
export function followUpdate(u: HostUpdate, h: HostInfo, now: number): { next: HostUpdate | null; reconnect: boolean } {
  if (u.phase !== "updating") return { next: u, reconnect: false };
  if (h.status === "connected" && h.daemon_version && !older(h.daemon_version, u.to)) return { next: null, reconnect: false };
  if (now - u.since > COME_BACK_MS) {
    // Back, but the old daemon kept serving: the handoff failed after the reply.
    const text =
      h.status === "connected" && h.daemon_version
        ? `${h.label} still runs moonlet ${h.daemon_version}: the update did not finish there (see its moonletd log)`
        : `${h.label} did not come back after the update`;
    return { next: { phase: "failed", text, command: null }, reconnect: false };
  }
  return { next: u, reconnect: h.status === "needs_update" || h.status === "error" };
}

/** The failure to show on host `h`'s row: kept until the host runs this
 * Mac's version, whether it is connected, reconnecting or in error. */
export function failureShown(u: HostUpdate | undefined, h: HostInfo, appVersion: string): HostUpdate | null {
  if (u?.phase !== "failed") return null;
  const current = h.status === "connected" && !!h.daemon_version && !older(h.daemon_version, appVersion);
  return current ? null : u;
}

/** The sidebar line for a connected host this Mac can update, which has no
 * notice otherwise; null for any other host. */
export function offerNotice(h: HostInfo, appVersion: string): string | null {
  return h.status === "connected" && updateOffer(h, appVersion) ? `${h.label} runs moonlet ${h.daemon_version}` : null;
}
