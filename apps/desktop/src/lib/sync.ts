// Keep in sync (X60): a live copy on this Mac of a session on its central
// host. The words the app shows for a copy, and which sessions and projects
// offer it.

import type { ConfirmOptions } from "./confirmOptions";
import type { Copy } from "./protocol";

/** `path` with the home folder as `~`. */
export function tilde(path: string, home: string | null | undefined): string {
  if (!home) return path;
  const h = home.replace(/\/$/, "");
  return path === h ? "~" : path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path;
}

const files = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The copy's status line: the sidebar mark's tooltip and the popover's first line. */
export function syncLine(copy: Copy, at: { branch: string; home: string | null | undefined; path?: boolean }): { text: string } {
  const s = copy.state;
  if (s.kind === "paused") return { text: `Paused: ${s.reason}` };
  if (s.kind === "waiting") return { text: `Waiting for ${copy.host}. Changes made on this Mac sync when it is back.` };
  if (s.kind === "copying") return { text: "Copying to this Mac…" };
  if (copy.differs.length) return { text: copy.differs.length === 1 ? "1 file differs" : `${copy.differs.length} files differ` };
  const d = copy.diverged;
  if (d) return { text: `${at.branch} has diverged: ${files(d.ahead, "commit", "commits")} on this Mac, ${d.behind} on ${copy.host}. Files still sync.` };
  const setup = copy.setup?.state;
  if (setup?.kind === "running") return { text: "Running setup…" };
  if (setup?.kind === "failed") return { text: `Setup failed (exit ${setup.exit})` };
  if (s.kind === "syncing") return { text: `Syncing ${files(s.files, "file", "files")}…` };
  return { text: at.path === false ? "In sync" : `In sync · ${tilde(copy.path, at.home)}` };
}

/** How the sidebar mark looks: muted while the copy can't sync, accent when it needs the user. */
export function markTone(copy: Copy): "muted" | "accent" | "plain" {
  const k = copy.state.kind;
  if (k === "copying" || k === "waiting" || k === "paused") return "muted";
  if (copy.differs.length || copy.diverged) return "accent";
  return "plain";
}

/** Whether a session's right-click menu has Keep in sync with this Mac: on
 * the central host's sessions, and on another tailnet host's once the user
 * makes it the central host. */
export function syncChoice(host: string, kind: string | undefined, central: string | null): { needsCentral: boolean } | null {
  if (kind !== "tailnet") return null;
  return { needsCentral: host !== central };
}

/** The composer's Keep in sync checkbox, and the project page's switch:
 * only for a project on the central host, ticked by the project's choice. */
export function composerSync(host: string, central: string | null, keepNew: boolean): { show: boolean; checked: boolean } {
  const show = !!central && host === central;
  return { show, checked: show && keepNew };
}

/** Asks to make a tailnet host the central host before keeping one of its sessions in sync. */
export function centralPrompt(session: string, host: string): ConfirmOptions {
  return {
    title: "Keep in sync",
    message: `Keeping ${session} in sync needs ${host} as this Mac's central host. Make it the central host?`,
    action: "Make it the central host",
  };
}

/** Asks before a copy runs its project's setup, showing the exact command. */
export function setupPrompt(project: string, command: string): ConfirmOptions & { code: string } {
  return {
    title: "Run setup",
    message: `Run ${project}'s setup in the copy on this Mac? (from .moonlet/config.toml)`,
    code: command,
    action: "Run setup",
    cancel: "Skip",
  };
}

const base = (path: string) => path.replace(/\/$/, "").split("/").pop() ?? "";

/** Asks before turning sync off. The daemon saves differing files under
 * `sync-leftovers/<the copy's folder name>`. */
export function stopPrompt(session: string, differing: number, copyPath: string, moonletHome: string, home: string | null | undefined): ConfirmOptions {
  const folder = tilde(`${moonletHome}/sync-leftovers/${base(copyPath)}`, home);
  const saved = differing === 0 ? "" : ` ${differing === 1 ? "1 file that differs is" : `${differing} files that differ are`} saved to ${folder} first.`;
  return {
    title: "Stop keeping in sync",
    message: `Stop keeping ${session} in sync? The copy on this Mac is removed.${saved}`,
    action: "Stop keeping in sync",
    variant: differing ? "danger" : "primary",
  };
}

/** The toast when a copy went: turned off, or its session archived on the central host. */
export function endedToast(session: string, host: string, removed: { reason: string; folder: string; leftovers: string[] }, home: string | null | undefined): string {
  const n = removed.leftovers.length;
  const lead = removed.reason === "archived" ? `${session} was archived on ${host}.` : `Stopped keeping ${session} in sync.`;
  if (n === 0) return removed.reason === "archived" ? `${lead} Its copy on this Mac is removed.` : lead;
  return `${lead} ${n === 1 ? "1 file from this Mac is" : `${n} files from this Mac are`} in ${tilde(removed.folder, home)}.`;
}

/** The notification when files start to differ. */
export function differsNotice(session: string, host: string, paths: string[]): { title: string; body: string; text: string } {
  const body =
    paths.length === 1 ? `${paths[0]} changed on both ${host} and this Mac. Pick a version.` : `${paths.length} files changed on both ${host} and this Mac. Pick a version for each.`;
  return { title: session, body, text: `${session}: ${body}` };
}

/** A file the daemon leaves out of the copy for its size. */
export const tooBigLine = (path: string) => `${path} is over 100 MB and stays on each machine.`;
