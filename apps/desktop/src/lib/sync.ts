// Keep in sync (X60): a live copy on this Mac of a session on its central
// host. The words the app shows for a copy, and which sessions and projects
// offer it.

import type { ConfirmOptions } from "./confirmOptions";
import type { Copy, HostKind, LinkState } from "./protocol";
import { tildePath } from "./profiles";

const tilde = (path: string, home: string | null | undefined) => tildePath(path, home ?? null);

/** `n` and the noun for it: "1 file", "3 files". */
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The copy's status line: the sidebar mark's tooltip and the popover's
 * first line. A copy waiting on a link the central host refused says to
 * pair again rather than wait (X41). */
export function syncLine(copy: Copy, at: { branch: string; home: string | null | undefined; path?: boolean; link?: LinkState }): string {
  const s = copy.state;
  if (s.kind === "paused") return `Paused: ${s.reason}`;
  if (s.kind === "waiting")
    return at.link?.kind === "refused" ? `Paused: ${copy.host} no longer accepts this Mac. Pair it again.` : `Waiting for ${copy.host}. Changes made on this Mac sync when it is back.`;
  if (s.kind === "copying") return "Copying to this Mac…";
  if (copy.differs.length) return copy.differs.length === 1 ? "1 file differs" : `${copy.differs.length} files differ`;
  const d = copy.diverged;
  if (d) return `${at.branch} has diverged: ${count(d.ahead, "commit", "commits")} on this Mac, ${d.behind} on ${copy.host}. Files still sync.`;
  const setup = copy.setup?.state;
  if (setup?.kind === "running") return "Running setup…";
  if (setup?.kind === "failed") return `Setup failed (exit ${setup.exit})`;
  if (s.kind === "syncing") return `Syncing ${count(s.files, "file", "files")}…`;
  return at.path === false ? "In sync" : `In sync · ${tilde(copy.path, at.home)}`;
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
export function syncChoice(host: string, kind: HostKind | undefined, central: string | null): { needsCentral: boolean } | null {
  if (kind !== "tailnet") return null;
  return { needsCentral: host !== central };
}

/** Whether a project offers keeping its sessions in sync: the composer's
 * checkbox and the project page's switch, only on the central host. */
export const syncOffered = (host: string, central: string | null): boolean => !!central && host === central;

/** What the popover's setup row offers: the output once it ran, and Run
 * setup, which asks first unless this exact command was approved. */
export function setupActions(setup: NonNullable<Copy["setup"]>): { log: boolean; run: { label: string; asks: boolean } | null } {
  const k = setup.state.kind;
  if (k === "running") return { log: true, run: null };
  if (k === "needs_approval") return { log: false, run: { label: "Run setup", asks: true } };
  const asks = !setup.approved;
  if (k === "skipped") return { log: false, run: { label: "Run setup", asks } };
  return { log: true, run: { label: "Run setup again", asks } };
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

/** Asks before turning sync off. The daemon saves what would be lost in a
 * new folder under `sync-leftovers`, named when it is done. */
export function stopPrompt(session: string, differing: number, moonletHome: string, home: string | null | undefined): ConfirmOptions {
  const folder = tilde(`${moonletHome}/sync-leftovers`, home);
  const saved = differing === 0 ? "" : ` ${differing === 1 ? "1 file that differs is" : `${differing} files that differ are`} saved to a folder in ${folder} first.`;
  return {
    title: "Stop keeping in sync",
    message: `Stop keeping ${session} in sync? The copy on this Mac is removed.${saved}`,
    action: "Stop keeping in sync",
    variant: differing ? "danger" : "primary",
  };
}

/** The toast when a copy went: turned off, or its session archived on the central host. */
export function endedToast(session: string, host: string, removed: { reason: "stopped" | "archived"; folder: string; leftovers: string[] }, home: string | null | undefined): string {
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
export const tooBigLine = (path: string) => `${path} is over 100 MiB and stays on each machine.`;

/** Why Compare could not read one side (X60): null when the file is just
 * not there, which Compare shows as deleted on that side. */
export function compareReadError(e: unknown): string | null {
  const message = e instanceof Error ? e.message : String(e);
  return message.includes("No such file or directory") ? null : message;
}
