// What the app shows about a new moonlet release (X35). Pure: the updater
// plugin calls live in the store.

import type { DownloadEvent } from "@tauri-apps/plugin-updater";

export type UpdateState =
  | { phase: "idle" }
  | { phase: "current" }
  | { phase: "available"; version: string }
  | { phase: "downloading"; version: string; received: number; total: number | null }
  | { phase: "installing"; version: string }
  | { phase: "ready"; version: string };

/** A toast about an update; `install` adds an Install action. */
export interface UpdateNotice {
  text: string;
  kind: "info" | "error";
  install: boolean;
}

/** What a check returned: a newer version (null: none), or why it failed. */
export type CheckOutcome = { found: string | null } | { error: string };

const info = (text: string): UpdateNotice => ({ text, kind: "info", install: false });

/** The state after a check, the toast it shows, and the error Settings
 *  shows (null clears it). `running` is this app's version. */
export function afterCheck(
  prev: UpdateState,
  outcome: CheckOutcome,
  { manual, running }: { manual: boolean; running: string | null },
): { state: UpdateState; notice: UpdateNotice | null; error: string | null } {
  // The fetched update is being installed; replacing it mid-way would lose it.
  if (prev.phase === "downloading" || prev.phase === "installing" || prev.phase === "ready") {
    return { state: prev, notice: manual ? info(`moonlet ${prev.version}: ${updateButton(prev)?.label}`) : null, error: null };
  }
  // An automatic check fails quietly: being offline is not an error.
  if ("error" in outcome) return manual ? { state: prev, notice: { text: outcome.error, kind: "error", install: false }, error: outcome.error } : { state: prev, notice: null, error: null };
  const found = outcome.found;
  if (!found) return { state: { phase: "current" }, notice: manual ? info(running ? `moonlet ${running} is up to date` : "moonlet is up to date") : null, error: null };
  const seen = prev.phase === "available" && prev.version === found;
  return { state: { phase: "available", version: found }, notice: seen && !manual ? null : { text: `moonlet ${found} is available`, kind: "info", install: true }, error: null };
}

/** Folds the updater's download events into the state. */
export function afterDownloadEvent(s: UpdateState, e: DownloadEvent): UpdateState {
  if (!("version" in s)) return s;
  switch (e.event) {
    case "Started":
      return { phase: "downloading", version: s.version, received: 0, total: e.data.contentLength ?? null };
    case "Progress":
      return s.phase === "downloading" ? { ...s, received: s.received + e.data.chunkLength } : s;
    case "Finished":
      return { phase: "installing", version: s.version };
  }
}

/** The update button in the sidebar footer and in Settings: its text, what
 *  a click does, and its tooltip. Null when there is nothing to update. */
export function updateButton(s: UpdateState): { label: string; action: "install" | "restart" | null; title: string } | null {
  switch (s.phase) {
    case "available":
      return labelled(`Update to ${s.version}`, "install");
    case "downloading":
      return labelled(s.total ? `Downloading ${Math.floor((s.received / s.total) * 100)}%` : `Downloading ${(s.received / 1e6).toFixed(1)} MB`, null);
    case "installing":
      return labelled("Installing…", null);
    case "ready":
      return { label: "Restart to update", action: "restart", title: "Restart moonlet into the new version. Terminals and agents keep running." };
    default:
      return null;
  }
}

/** A button whose tooltip is its label. */
const labelled = (label: string, action: "install" | null) => ({ label, action, title: label });

/** The status next to the version in Settings › Updates. */
export function updateStatus(s: UpdateState, checking: boolean, error: string | null): string | null {
  if (checking) return "Checking…";
  if (error) return error;
  switch (s.phase) {
    case "idle":
      return null;
    case "current":
      return "Up to date";
    case "available":
      return `${s.version} is available`;
    case "ready":
      return `${s.version} is installed`;
    default:
      return updateButton(s)?.label ?? null;
  }
}

/** Runs `check` ten seconds after launch and every six hours, while
 *  `enabled` (the "Check for updates automatically" setting) says so. */
export function scheduleUpdateChecks(check: () => void, enabled: () => boolean) {
  const auto = () => {
    if (enabled()) check();
  };
  setTimeout(auto, 10_000);
  setInterval(auto, 6 * 3_600_000);
}
