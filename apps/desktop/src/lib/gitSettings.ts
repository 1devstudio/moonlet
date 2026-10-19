// Settings › Git (X55): each host's daemon keeps its own Git settings in
// `~/.moonlet/git.toml`. Pure helpers for the page and the dialogs that
// follow them.

import type { GitSettings, HostInfo } from "./protocol";

export const DEFAULT_GIT_SETTINGS: GitSettings = { stage_all: true, draft_prs: false };

/** A host's Git settings: what its daemon keeps, else the defaults (not
 * loaded yet, or `null` for a daemon too old to know them). */
export function gitSettingsOf(all: Record<string, GitSettings | null | undefined>, host: string): GitSettings {
  return { ...DEFAULT_GIT_SETTINGS, ...all[host] };
}

/** The Host switch: This Mac, then each connected remote host. */
export function gitHosts(hosts: Record<string, HostInfo>): { id: string; label: string }[] {
  const remote = Object.values(hosts).filter((h) => h.remote && h.status === "connected");
  return [{ id: "local", label: "This Mac" }, ...remote.map((h) => ({ id: h.id, label: h.label || h.id }))];
}

export const tooOldText = (host: string) => `${host}'s moonletd is too old for Git settings. Reinstall the helper from Hosts.`;
