// Claude Code on the remote hosts this Mac is connected to (X109): which
// hosts get a row in Settings › Updates, and what each row says. Pure: the
// RPCs live in hostClaudeStore. A run is read as on this Mac (X36).

import { isNewer, type ClaudeUpdateState } from "./claudeUpdate";
import type { HostInfo } from "./protocol";
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
  /** A `claude update` there, running or ended: never `available`. */
  run: ClaudeUpdateState;
}

export const NOT_ASKED: HostClaude = { installed: null, answered: false, unasked: false, checking: false, run: { phase: "idle" } };

/** The hosts whose Claude Code Settings shows: connected remote ones, by label. */
export function claudeHosts(hosts: HostInfo[]): HostInfo[] {
  return hosts.filter((h) => h.remote && h.status === "connected").sort((a, b) => a.label.localeCompare(b.label));
}

/** The line beside a host's Claude Code version; null for none. `latest`
 * is npm's newest, null when it could not be read. */
export function hostClaudeLine(h: HostInfo, c: HostClaude, latest: string | null): StatusLine | null {
  const r = c.run;
  switch (r.phase) {
    case "updating":
      return { tone: "muted", text: r.step === "install" ? `Installing ${r.latest}…` : `Updating to ${r.latest}…` };
    case "updated":
      return { tone: "done", text: `Updated to ${r.version}. New agents on ${h.label} start on it.` };
    case "current":
      return { tone: "done", text: `${r.version} is up to date` };
    case "failed":
      return { tone: "error", text: r.message };
  }
  if (c.checking && !c.answered) return { tone: "muted", text: "Checking…" };
  if (c.unasked) return { tone: "muted", text: `Could not ask ${h.label}` };
  if (!c.answered || !latest) return null;
  if (!c.installed) return { tone: "blocked", text: "Not found on the PATH" };
  return isNewer(latest, c.installed) ? { tone: "accent", text: `${latest} is available` } : { tone: "done", text: "Up to date" };
}

/** The release to offer the host; null for none. */
export function hostClaudeOffer(c: HostClaude, latest: string | null): string | null {
  return c.run.phase !== "updating" && c.installed && latest && isNewer(latest, c.installed) ? latest : null;
}
