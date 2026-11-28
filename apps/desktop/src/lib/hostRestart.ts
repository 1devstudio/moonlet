// Restarting a tailnet host's daemon from this Mac (X120): which hosts offer
// it, and following one restart until a fresh daemon answers there.

import type { HostInfo } from "./protocol";

/** Whether `h` offers Restart: a tailnet host this Mac is connected to. */
export const restartOffer = (h: HostInfo) => h.kind === "tailnet" && h.status === "connected";

/** How long after the reply a fresh daemon has to answer. */
export const RESTART_BACK_MS = 60_000;

/** A restart running or failed on one host. `from`: the pid that answered
 * `daemon.restart`, which a fresh daemon replaces. */
export type HostRestart = { phase: "restarting"; from: number; since: number } | { phase: "failed"; text: string };

/** The next state of restart `r` now that host `h` is as it is and its
 * `daemon.info` answered `info` (null: it did not), and whether to ask the
 * host to connect again. `next` null: a fresh daemon answers. */
export function followRestart(r: HostRestart, h: HostInfo, info: { pid: number } | null, now: number): { next: HostRestart | null; reconnect: boolean } {
  if (r.phase !== "restarting") return { next: r, reconnect: false };
  if (info && info.pid !== r.from) return { next: null, reconnect: false };
  if (now - r.since > RESTART_BACK_MS) {
    const text = info
      ? `${h.label} still runs the same moonletd: the restart did not finish there (see its moonletd log)`
      : `${h.label} did not come back after the restart`;
    return { next: { phase: "failed", text }, reconnect: false };
  }
  return { next: r, reconnect: h.status === "needs_update" || h.status === "error" };
}

/** The toast once a fresh daemon answers on `h`. */
export const restartedText = (h: HostInfo) => `${h.label} restarted. Its sessions kept running.`;
