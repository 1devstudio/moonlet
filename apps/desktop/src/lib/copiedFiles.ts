// A project's copied files (X74): files git ignores that moonlet copies
// between the user's Macs, `.env` and `.env.*` by default. The daemon
// checks each pattern again; these say why one is refused before it asks.

export interface CopiedFiles {
  patterns: string[];
  cloud: boolean;
  default: boolean;
}

/** The note under the list. */
export const COPIED_NOTE = "Files git ignores that moonlet copies to your other Macs, such as secrets a worktree needs to run. They never enter git.";

/** A line under the list when it is the default one, none was set. */
export const listNote = (c: CopiedFiles): string | null => (c.default ? "The default: .env files in any folder." : null);

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
