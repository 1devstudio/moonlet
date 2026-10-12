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

/** The state after a check that found `found` (null: nothing newer), and
 *  whether to announce it with a toast. */
export function afterCheck(prev: UpdateState, found: string | null): { state: UpdateState; announce: boolean } {
  // The fetched update is being installed; replacing it mid-way would lose it.
  if (prev.phase === "downloading" || prev.phase === "installing" || prev.phase === "ready") return { state: prev, announce: false };
  if (!found) return { state: { phase: "current" }, announce: false };
  const seen = prev.phase === "available" && prev.version === found;
  return { state: { phase: "available", version: found }, announce: !seen };
}

/** Folds the updater's download events into the state. */
export function onDownload(s: UpdateState, e: DownloadEvent): UpdateState {
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

/** The sidebar footer update button's text, null when there is nothing to update. */
export function updateButtonLabel(s: UpdateState): string | null {
  switch (s.phase) {
    case "available":
      return `Update to ${s.version}`;
    case "downloading":
      return s.total ? `Downloading ${Math.floor((s.received / s.total) * 100)}%` : `Downloading ${(s.received / 1e6).toFixed(1)} MB`;
    case "installing":
      return "Installing…";
    case "ready":
      return "Restart to update";
    default:
      return null;
  }
}
