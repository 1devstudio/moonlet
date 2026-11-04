// A session's processes (X83): the Processes tab's rows, and what the
// archive confirm says about what still runs.

import type { ConfirmOptions } from "./confirmOptions";
import type { ProcessesKilled, ProcessRef, SessionKillProcesses, SessionProcess, SessionProcesses } from "./protocol";

/** What the daemon's Stop all (`session.kill_processes` without pids) stops:
 * every process but those it marks the tabs' own (`tab`), never what was
 * left in the worktree. The rows the Processes tab shows as stopping. */
export function stoppedByStopAll(list: SessionProcesses): SessionProcess[] {
  return list.processes.filter((p) => !p.tab);
}

/** What archiving stops beyond the tabs themselves: what Stop all stops, and
 * what was left in the worktree. */
function stopped(list: SessionProcesses | null): SessionProcess[] {
  return list ? [...stoppedByStopAll(list), ...list.leftovers] : [];
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

/** What archiving stops before the session is archived. */
export function toStopOnArchive(list: SessionProcesses | null): SessionProcess[] {
  return stopped(list);
}

/** `session.kill_processes`' params: each of `ps` by its pid and the start
 * the kernel listed it with, so a pid reused since is left alone, whatever
 * the clock did meanwhile (a plain pid when the start is not known); no
 * `ps`, Stop all, which the daemon decides. */
export function killParams(id: string, ps?: SessionProcess[]): SessionKillProcesses {
  if (!ps) return { id };
  return { id, pids: ps.map((p): ProcessRef => (p.start === undefined ? p.pid : { pid: p.pid, start: p.start })) };
}

/** What a Stop says when processes outlived it ("1 process still runs after
 * SIGKILL: 4250."); null when none did, or the daemon did not say. */
export function stillRunningLine(killed: unknown): string | null {
  const left = (killed as Partial<ProcessesKilled> | null)?.still_running;
  if (!Array.isArray(left) || !left.length) return null;
  return `${left.length} ${left.length === 1 ? "process still runs" : "processes still run"} after SIGKILL: ${left.join(", ")}.`;
}

/** `options` with `line` after its message; the same options without one. */
export function withRunning(options: ConfirmOptions, line: string | null): ConfirmOptions {
  if (!line) return options;
  const message = options.message;
  return { ...options, message: typeof message === "function" ? (checked) => `${message(checked)} ${line}` : `${message} ${line}` };
}

export interface ProcessRow {
  pid: number;
  name: string;
  origin: string;
  age: string;
  cpu: string;
  memory: string;
  /** Has its own Stop; the tabs' own processes end with their tab. */
  stop: boolean;
}

/** "42s", "45m", "2h", "6d": the largest whole unit. */
function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** "900 KB", "210 MB", "3.0 GB": as `moonlet ps` prints it
 * (`crates/moonlet-cli/src/ps.rs`). */
function memory(bytes: number): string {
  const mb = 1 << 20;
  if (bytes < mb) return `${Math.floor(bytes / 1024)} KB`;
  if (bytes < mb * 1024) return `${Math.round(bytes / mb)} MB`;
  return `${(bytes / (mb * 1024)).toFixed(1)} GB`;
}

/** A row of the Processes tab; `cpu` is its CPU use in percent of a core,
 * null until it was looked at twice. */
export function processRow(p: SessionProcess, now: number, cpu: number | null): ProcessRow {
  const o = p.origin;
  return {
    pid: p.pid,
    name: p.name,
    origin: o.kind === "terminal" ? `Terminal · ${o.title}` : o.kind === "run" ? `Run · ${o.title}` : o.kind === "agent" ? `Agent · ${o.title}` : o.parent,
    age: p.started === undefined ? "–" : age(now - p.started),
    cpu: cpu === null ? "–" : `${Math.round(cpu)}%`,
    memory: p.rss === undefined ? "–" : memory(p.rss),
    stop: !p.tab,
  };
}

/** The tab's header: "5 processes · 1 left in the worktree". */
export function processesSummary(list: SessionProcesses): string {
  const n = list.processes.length;
  const head = `${n} ${n === 1 ? "process" : "processes"}`;
  return list.leftovers.length ? `${head} · ${list.leftovers.length} left in the worktree` : head;
}

/** Which of the Processes tab's looks still count: only the latest begun,
 * and only while its session (host and id) is the one shown. A slow look, or
 * a Stop's refresh of a session shown before, is dropped. */
export function processLooks() {
  let shown: { host: string; id: string } | null = null;
  let latest = 0;
  return {
    /** Session `id` of `host` shows now: every earlier look is dropped. */
    show(host: string, id: string) {
      shown = { host, id };
      latest++;
    },
    /** A look at session `id` of `host` starts; its token. */
    begin(host: string, id: string): number {
      // One for a session no longer shown never counts, nor drops one that does.
      if (shown?.host !== host || shown.id !== id) return -1;
      return ++latest;
    },
    /** Whether what the look of `token` found may be shown. */
    current(token: number): boolean {
      return token === latest;
    },
  };
}

/** A process's CPU time at one look, and when it was taken. */
export interface CpuLook {
  cpu_ms: number;
  at: number;
}

/** CPU use between two looks at one process, in percent of a core (200 for
 * two busy cores); null without an earlier look, with no time between them,
 * or when the CPU time went down: the pid is another process's now. */
export function cpuPercent(prev: CpuLook | undefined, next: CpuLook): number | null {
  if (!prev || next.at <= prev.at || next.cpu_ms < prev.cpu_ms) return null;
  return ((next.cpu_ms - prev.cpu_ms) / (next.at - prev.at)) * 100;
}
