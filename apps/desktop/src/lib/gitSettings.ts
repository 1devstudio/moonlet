// Settings › Git (X55): each host's daemon keeps its own Git settings in
// `~/.moonlet/git.toml`. Pure helpers for the page and the dialogs that
// follow them.

import type { GitSettings, HostInfo } from "./protocol";
import { tildePath } from "./profiles";

export const DEFAULT_GIT_SETTINGS: GitSettings = { branch_prefix: "moonlet/", start_from: "local", stage_all: true, draft_prs: false };

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

/** Why git would reject branches named `<prefix>…`, or "". The daemon
 * checks the same. */
export function prefixError(p: string): string {
  if (/[\s~^:?*[\\]/.test(p)) return "Branch names cannot hold spaces or ~ ^ : ? * [ \\";
  if (p.includes("..") || p.includes("//") || p.includes("@{")) return "Branch names cannot hold .., // or @{";
  if (/^[/.-]/.test(p)) return "Start with a letter or digit.";
  return "";
}

/** The branch an example session would get with `prefix`. */
export const branchPreview = (prefix: string) => `${prefix}add-search-to-the-product-list`;

/** The composer's item for starting where the host's settings say. */
export const defaultStartLabel = (base: string, from: GitSettings["start_from"]) => `Start from ${from === "origin" ? `origin/${base}` : base} (default)`;

/** Where sessions' worktrees go, from the daemon's data folder. */
export const worktreesText = (data: string, home: string) => `${tildePath(`${data}/worktrees`, home)}/‹project›/‹session›`;
