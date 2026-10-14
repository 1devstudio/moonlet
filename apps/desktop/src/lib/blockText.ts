// Command blocks as text (T4, T8): pure helpers shared by the desktop's
// terminals and the phone app's Terminal tab (X40). No xterm here.

/** `~`-shortens a path under `home`. */
export function shortPath(p: string, home: string | null): string {
  if (home && (p === home || p.startsWith(home + "/"))) return "~" + p.slice(home.length);
  return p;
}

/** The command a user typed, from its screen rows (T8): rows the terminal
 * wrapped join their previous row as is, real line breaks stay. Row texts
 * are untrimmed, so a space at the wrap survives. */
export function commandFromRows(rows: readonly { text: string; wrapped: boolean }[]): string {
  const lines: string[] = [];
  for (const r of rows) {
    if (r.wrapped && lines.length) lines[lines.length - 1] += r.text;
    else lines.push(r.text);
  }
  return lines
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
}

/** When an OSC 133 mark came, from its parameters after the mark letter
 * (S2): a mark replayed from the daemon's snapshot carries
 * `moonlet_age=<ms>`, how long ago the daemon saw it; a live mark came
 * now; a replayed one without an age (an older daemon) has no time. */
export function markTime(params: readonly string[], replaying: boolean, now: number): number | undefined {
  for (const p of params) {
    const m = /^moonlet_age=(\d+)$/.exec(p);
    if (m) return now - Number(m[1]);
  }
  return replaying ? undefined : now;
}

/** What ⌘C (`all`), ⇧⌘C (`output`) and ⌥⌘C (`command`) copy from the
 * selected block (T8). */
export function blockCopy(b: { command: string; output: string }, part: "all" | "output" | "command"): string {
  if (part === "output") return b.output;
  if (part === "command") return b.command;
  return b.output ? `$ ${b.command}\n${b.output}` : `$ ${b.command}`;
}

/** A block as text for an agent's input (T8): the command line and its
 * output in a code fence longer than any fence inside either. */
export function blockForAgent(b: { command: string; output: string }): string {
  const longest = Math.max(2, ...(`${b.command}\n${b.output}`.match(/`{3,}/g) ?? []).map((f) => f.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${blockCopy(b, "all")}\n${fence}\n`;
}

/** Rows of a Blocks-mode block (T8), from its prompt mark's row and the row
 * its output starts on. The shell's prompt is empty rows: with two, the
 * first holds the separator and the second the header; with one, they
 * share it. A shell that left no empty row (an older integration) gets no
 * header row: the header goes at the end of the command line. */
export function blockLayout(prompt: number, output: number, empty: (y: number) => boolean): { separator: number; header: number | null; commandFrom: number } {
  if (!empty(prompt)) return { separator: prompt, header: null, commandFrom: prompt };
  if (empty(prompt + 1) && prompt + 2 < output) return { separator: prompt, header: prompt + 1, commandFrom: prompt + 2 };
  return { separator: prompt, header: prompt, commandFrom: prompt + 1 };
}

/** What re-running a block types into the shell (T4, T8). The command is
 * read back from the screen, so anything a program printed there could be
 * in it: control characters are dropped, so the text cannot act as keys or
 * end a paste, and a multi-line command goes as one bracketed paste, so no
 * line runs on its own before Enter, as the input editor sends commands. */
export function rerunInput(command: string): string | null {
  const text = command.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
  if (!text.trim()) return null;
  return text.includes("\n") ? `\x1b[200~${text}\x1b[201~\r` : `${text}\r`;
}

/** Where a block's header comes from: the user's home and the session. */
export interface BlockContext {
  home: string | null;
  worktree?: string;
  branch?: string;
  /** Recorded on each block when its command starts, for its header. */
  nodeVersion?: string;
  changes?: { files: number; additions: number; deletions: number };
}

function duration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(3)}s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** The line above a command (T8): chips for the node version, directory,
 * session branch and uncommitted changes, then the duration, with
 * `exit 1` before it when the command failed. */
export function blockHeader(
  b: {
    cwd?: string;
    node?: string;
    changes?: { files: number; additions: number; deletions: number };
    exit?: number;
    startedAt?: number;
    endedAt?: number;
    end?: unknown;
  },
  ctx: BlockContext,
): { node: string | null; place: string; branch: string | null; changes: string | null; exit: string | null; duration: string | null; running: boolean } {
  const cwd = b.cwd ?? "";
  const inside = !!ctx.worktree && (cwd === ctx.worktree || cwd.startsWith(ctx.worktree + "/"));
  const timed = !!b.end && b.startedAt !== undefined && b.endedAt !== undefined;
  const c = b.changes;
  return {
    node: b.node ?? null,
    place: shortPath(cwd, ctx.home),
    // The session's branch, only inside its worktree.
    branch: inside && ctx.branch ? ctx.branch : null,
    // `5 • +113 -30`: the session's uncommitted changes, only inside it.
    changes: inside && c ? `${c.files} • +${c.additions} -${c.deletions}` : null,
    exit: b.end && b.exit ? `exit ${b.exit}` : null,
    duration: timed ? `(${duration(b.endedAt! - b.startedAt!)})` : null,
    running: !b.end,
  };
}
