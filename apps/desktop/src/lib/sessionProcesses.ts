// A session's processes (X83): what the archive confirm says about what
// still runs.

import type { ConfirmOptions } from "./confirmOptions";
import type { SessionProcess, SessionProcesses } from "./protocol";

/** What archiving stops beyond the tabs themselves: their jobs, what agents
 * started, and what was left in the worktree. */
function stopped(list: SessionProcesses | null): SessionProcess[] {
  return list ? [...list.processes.filter((p) => !p.tab), ...list.leftovers] : [];
}

/** Names, each once, in the order first seen; a repeated one as `node ×2`. */
function names(ps: SessionProcess[]): string {
  const counts = new Map<string, number>();
  for (const p of ps) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(", ");
}

/** The archive confirm's line on what still runs ("3 processes still run:
 * vite, tail, node. Archiving stops them."), or null when only the tabs'
 * own processes run, or the daemon could not say. */
export function runningLine(list: SessionProcesses | null): string | null {
  const ps = stopped(list);
  if (!ps.length) return null;
  return ps.length === 1 ? `1 process still runs: ${names(ps)}. Archiving stops it.` : `${ps.length} processes still run: ${names(ps)}. Archiving stops them.`;
}

/** The pids archiving stops before the session is archived. */
export function toStopOnArchive(list: SessionProcesses | null): number[] {
  return stopped(list).map((p) => p.pid);
}

/** `options` with `line` after its message; the same options without one. */
export function withRunning(options: ConfirmOptions, line: string | null): ConfirmOptions {
  if (!line) return options;
  const message = options.message;
  return { ...options, message: typeof message === "function" ? (checked) => `${message(checked)} ${line}` : `${message} ${line}` };
}
