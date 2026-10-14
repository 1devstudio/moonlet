// The Hosts screen's lines (X40): the paired Macs and the SSH hosts reached
// through them.

import type { HostStatus } from "@desktop/lib/protocol";

export type HostWord = "connected" | "connecting" | "offline";

export function hostWord(status: HostStatus): HostWord {
  if (status === "connected") return "connected";
  if (status === "connecting" || status === "reconnecting") return "connecting";
  return "offline";
}

function ago(ms: number): string {
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  const d = Math.floor(ms / 86_400_000);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export interface HostSeen {
  /** Round trip of the last `daemon.info`. */
  latencyMs: number | null;
  /** When it was last connected. */
  lastSeen: number | null;
}

/** How the host is reached, or when it was last seen. */
export function hostRoute(h: { status: HostStatus; via: string | null }, seen: HostSeen, now: number): string {
  if (hostWord(h.status) === "offline") {
    return seen.lastSeen === null ? "Not reachable over Tailscale" : `Last seen ${ago(now - seen.lastSeen)} · sessions keep running`;
  }
  if (h.via) return `Reached through ${h.via} over SSH`;
  return `Paired · direct over Tailscale${seen.latencyMs === null ? "" : ` · ${Math.round(seen.latencyMs)} ms`}`;
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** `moonletd 0.1.16 · 6 sessions · 9 terminals`; empty before the daemon answered. */
export function hostMeta(version: string | null, sessions: number, terminals: number): string {
  if (!version) return "";
  return `moonletd ${version} · ${count(sessions, "session")} · ${count(terminals, "terminal")}`;
}
