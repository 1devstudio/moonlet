// Claude Code on the remote hosts this Mac is connected to (X109): which
// hosts get a row in Settings › Updates, and what each row says. Pure: the
// RPCs live in hostClaudeStore. A run is read as on this Mac (X36).

import { isNewer, type ClaudeUpdateState } from "./claudeUpdate";
import type { HostInfo, HostStatus } from "./protocol";
import type { StatusLine } from "./settingsPage";

/** What this Mac knows of one host's Claude Code. */
export interface HostClaude {
  /** The version `claude --version` printed there; null for none. */
  installed: string | null;
  /** A check got an answer, so `installed` null means no `claude`. */
  answered: boolean;
  /** The last check got no answer from the host. */
  unasked: boolean;
  checking: boolean;
  /** A `claude update` there, running or ended: never `available`. One
   * found running elsewhere has an empty `latest`: the release is npm's. */
  run: ClaudeUpdateState;
}

export const NOT_ASKED: HostClaude = { installed: null, answered: false, unasked: false, checking: false, run: { phase: "idle" } };

/** The hosts whose Claude Code Settings shows: connected remote ones, by label. */
export function claudeHosts(hosts: HostInfo[]): HostInfo[] {
  return hosts.filter((h) => h.remote && h.status === "connected").sort((a, b) => a.label.localeCompare(b.label));
}

/** The version beside the host's name: "…" until it answers, none
 * when it has no `claude` (the line says so). */
export function hostClaudeVersion(c: HostClaude): string | null {
  return c.installed ?? (c.answered ? null : "…");
}

/** The line beside a host's Claude Code version; null for none. `latest`
 * is npm's newest, null when it could not be read. */
export function hostClaudeLine(h: HostInfo, c: HostClaude, latest: string | null): StatusLine | null {
  const r = c.run;
  switch (r.phase) {
    case "updating": {
      const to = r.latest || latest;
      if (r.step === "install") return { tone: "muted", text: to ? `Installing ${to}…` : "Installing…" };
      return { tone: "muted", text: to ? `Updating to ${to}…` : "Updating…" };
    }
    case "updated":
      return { tone: "done", text: `Updated to ${r.version}. New agents on ${h.label} start on it.` };
    case "current":
      return { tone: "done", text: `${r.version} is up to date` };
    case "failed":
      return { tone: "error", text: r.message };
  }
  if (c.checking && !c.answered) return { tone: "muted", text: "Checking…" };
  if (c.unasked) return { tone: "muted", text: `Could not ask ${h.label}` };
  if (!c.answered) return null;
  if (!c.installed) return { tone: "blocked", text: "Not found on the PATH" };
  if (!latest) return null;
  return isNewer(latest, c.installed) ? { tone: "accent", text: `${latest} is available` } : { tone: "done", text: "Up to date" };
}

/** The release to offer the host; null for none, and when the last check
 * got no answer, so what the host runs now is unknown. */
export function hostClaudeOffer(c: HostClaude, latest: string | null): string | null {
  return c.run.phase !== "updating" && !c.unasked && c.installed && latest && isNewer(latest, c.installed) ? latest : null;
}

/** Whether a host's status change calls for asking its Claude Code again:
 * a remote host Settings asked before is connected again, and its daemon
 * may have restarted with another PATH. One never asked is left alone, so
 * starting the app runs no `claude --version` on every host. */
export function recheckHostClaudeOnReconnect(h: HostInfo, prev: HostStatus | undefined, asked: boolean): boolean {
  return asked && h.remote && h.status === "connected" && prev !== "connected";
}
