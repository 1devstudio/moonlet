// A project's copied files (X74): files git ignores that moonlet copies
// between the user's Macs, `.env` and `.env.*` by default. The daemon
// checks each pattern again; these say why one is refused before it asks.

import { tildePath } from "./profiles";

export interface CopiedFiles {
  patterns: string[];
  cloud: boolean;
  default: boolean;
}

/** The note under the list. */
export const COPIED_NOTE = "Files git ignores that moonlet copies to your other Macs, such as secrets a worktree needs to run. They never enter git.";

/** A line under the list when it is the default one, none was set. */
export const listNote = (c: CopiedFiles): string | null => (c.default ? "The default: .env files in any folder." : null);

/** The section's line when the list could not be loaded, with Check again. */
export const loadFailedNote = (message: string): string => `Could not load this project's copied files: ${message}`;

/** Why `p` is no pattern of the list, as the daemon would refuse it; null
 * when it is one. */
function refused(p: string): string | null {
  if (!p) return "Type a pattern, such as .env.local.";
  if (p.startsWith("!")) return "A pattern cannot take files back (!).";
  if (/[\r\n]/.test(p)) return "One line per pattern.";
  if (p.split("/").includes("..")) return "A pattern stays inside the worktree (..).";
  if (p.startsWith("//") || p.startsWith("~")) return "A pattern is relative to the worktree.";
  return null;
}

/** `patterns` with `input` added at the end, or why it cannot be. */
export function addPattern(patterns: string[], input: string): { patterns: string[] } | { error: string } {
  const p = input.trim();
  const error = refused(p);
  if (error) return { error };
  if (patterns.includes(p)) return { error: `${p} is already in the list.` };
  return { patterns: [...patterns, p] };
}

/** `patterns` without `p`. */
export const removePattern = (patterns: string[], p: string): string[] => patterns.filter((x) => x !== p);

/** Saves of a whole list, starting from `saved`, the one the daemon has.
 * Each is sent once the one before it is answered, so an earlier edit
 * never lands after a later one. `onFail` runs for a failed save only
 * while no later save was made, with the list last saved, to put back. */
export function listSaver<T>(saved: T, send: (value: T) => Promise<unknown>) {
  let tail: Promise<unknown> = Promise.resolve();
  let latest = 0;
  return (value: T, onFail: (e: unknown, saved: T) => void): Promise<void> => {
    const n = ++latest;
    const sent = tail.then(() => send(value));
    tail = sent.then(
      () => {
        saved = value;
      },
      () => {},
    );
    return sent.then(
      () => {},
      (e: unknown) => {
        if (n === latest) onFail(e, saved);
      },
    );
  };
}

/** What the list names in a session's worktree. */
export interface CopiedFilesStatus {
  files: string[];
  skipped: { path: string; reason: string }[];
}

/** The sync popover's line, which opens the list: the copied files, or
 * with none, the files left out; none without either. */
export function copiedLine(s: CopiedFilesStatus): string | null {
  const n = s.files.length;
  if (n) return n === 1 ? "1 copied file" : `${n} copied files`;
  const out = s.skipped.length;
  if (out) return out === 1 ? "1 file not copied" : `${out} files not copied`;
  return null;
}

/** Why a matching file is not copied. */
export const skippedLine = (s: { path: string; reason: string }) => `${s.path} ${s.reason} and stays on each Mac.`;

/** The toast when this Mac's version of a copied file went to leftovers. */
export const keptToast = (k: { label: string; path: string; folder: string }, home: string | null) =>
  `${k.label}: ${k.path} changed on both Macs. This Mac's version is in ${tildePath(k.folder, home)}`;

/** The confirmation when a paired Mac is removed: the copied files it may
 * hold, by project, whose secrets to rotate (ADR 0014). `patterns` is null
 * for a project whose list could not be looked up: named as such, never as
 * one without copied files. */
export function removeMacMessage(lists: { project: string; patterns: string[] | null }[]): string {
  const held = lists.flatMap((l) => (l.patterns?.length ? [`${l.project} (${l.patterns.join(", ")})`] : []));
  const unknown = lists.filter((l) => l.patterns === null).map((l) => l.project);
  let out = "It will need to be paired again.";
  if (held.length) out += ` It may hold copies of the files your projects copy between your Macs: ${held.join(", ")}. Rotate the secrets in them.`;
  if (unknown.length) out += ` The copied files of ${unknown.join(", ")} could not be looked up: rotate their secrets too if they copy any.`;
  return out;
}
