// Settings › Git (X55): each host's daemon keeps its own Git settings in
// `~/.moonlet/git.toml`. Pure helpers for the page and the dialogs that
// follow them.

import type { GitSettings, HostInfo } from "./protocol";
import { tildePath } from "./profiles";

export const DEFAULT_GIT_SETTINGS: GitSettings = {
  branch_prefix: "moonlet/",
  start_from: "local",
  archive_worktree: "remove",
  archive_branch: "merged",
  delete_remote_branch: false,
  stage_all: true,
  draft_prs: false,
  fetch_minutes: 5,
  fast_forward_base: false,
};

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
  if (/[\s\x00-\x1f\x7f~^:?*[\\]/.test(p)) return "Branch names cannot hold spaces or ~ ^ : ? * [ \\";
  if (p.includes("..") || p.includes("//") || p.includes("@{")) return "Branch names cannot hold .., // or @{";
  if (/^[/.-]/.test(p)) return "Start with a letter or digit.";
  // The last part goes on with the session's name.
  const parts = p.split("/");
  if (parts.some((part, i) => part.startsWith(".") || (i < parts.length - 1 && part.endsWith(".lock")))) return "No part can start with . or end with .lock";
  return "";
}

/** The branch an example session would get with `prefix`. */
export const branchPreview = (prefix: string) => `${prefix}add-search-to-the-product-list`;

/** The composer's item for starting where the host's settings say. */
export const defaultStartLabel = (base: string, from: GitSettings["start_from"]) => `Start from ${from === "origin" ? `origin/${base}` : base} (default)`;

/** "Fetch from origin" as the page and search show it: minutes, or Manually for 0. */
export const fetchLabel = (minutes: number) => (minutes > 0 ? `${minutes} min` : "Manually");

/** The choices of "Fetch from origin": 5 min, 15 min and Manually, with an
 * interval set in git.toml by hand in its place among them. */
export function fetchOptions(current: number): { id: string; label: string }[] {
  const minutes = [5, 15, 0];
  if (!minutes.includes(current)) minutes.splice(current < 15 ? 1 : 2, 0, current);
  return minutes.map((m) => ({ id: String(m), label: fetchLabel(m) }));
}

/** The host's worktrees folder, from `daemon.info`; a daemon from before
 * `data_dir` keeps them in `~/.moonlet`. */
export const worktreesFolder = (info: { home: string; data_dir?: string }) => `${info.data_dir || `${info.home}/.moonlet`}/worktrees`;

/** Where sessions' worktrees go, as the page shows it. */
export const worktreesText = (folder: string, home: string) => `${tildePath(folder, home)}/‹project›/‹session›`;

/** What archiving a session will do, before the prompt asks (X55). */
export interface ArchivePlan {
  removeWorktree: boolean;
  /** `ask`: the prompt's "Also delete the branch" decides. */
  branch: "ask" | "keep" | "delete";
  /** Why the branch is kept or deleted, for the prompt. */
  why: "policy" | "merged" | "not-merged";
  /** Delete it on origin too when it is deleted here. */
  remote: boolean;
}

/** The plan for archiving a session on `branch`, whose PR is in `prState`
 * (`merged`, `open`…, or none). The project's base branch is never deleted,
 * nor a branch still checked out in a kept folder. */
export function archivePlan(g: GitSettings, prState: string | null | undefined, branch: string, base: string): ArchivePlan {
  const removeWorktree = g.archive_worktree !== "keep";
  const merged = prState === "merged";
  const remote = g.delete_remote_branch && merged;
  if (!removeWorktree || branch === base) return { removeWorktree, branch: "keep", why: "policy", remote: false };
  switch (g.archive_branch) {
    case "ask":
      return { removeWorktree, branch: "ask", why: "policy", remote };
    case "keep":
      return { removeWorktree, branch: "keep", why: "policy", remote: false };
    case "always":
      return { removeWorktree, branch: "delete", why: "policy", remote };
    default:
      return merged ? { removeWorktree, branch: "delete", why: "merged", remote } : { removeWorktree, branch: "keep", why: "not-merged", remote: false };
  }
}

/** `session.archive`'s flags for `plan`, with the prompt's checkbox. */
export function archiveFlags(plan: ArchivePlan, checked: boolean) {
  const del = plan.branch === "delete" || (plan.branch === "ask" && checked);
  return { remove_worktree: plan.removeWorktree, delete_branch: del, delete_remote: del && plan.remote };
}
