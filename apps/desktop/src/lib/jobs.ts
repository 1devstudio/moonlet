// Jobs (X62): every routed command of a session, as the Jobs tab, a job's
// detail, its tab and the chat's Bash rows show it. Pure.

import { clock } from "./subagents";
import type { Job, JobChunk } from "./protocol";

/** A total, in whole seconds: `42s`, `1m 00s`. */
export function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** A phase's length: `2.1s` under ten seconds, then as [`dur`]. */
export const took = (ms: number): string => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : dur(ms));

const ran = (j: Job, now: number) => (j.ended_at ?? now) - j.started_at;
const reran = (j: Job) => j.timeline.some((e) => e.text.endsWith(" went away"));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const jobsTabCount = (jobs: Job[]): number => jobs.length;

/** "1 waiting · 3 done · 3m 53s on workers"; null with no jobs. */
export function jobsSummary(jobs: Job[], now: number): string | null {
  if (!jobs.length) return null;
  const count = (kinds: Job["state"]["kind"][]) => jobs.filter((j) => kinds.includes(j.state.kind)).length;
  const parts = [
    [count(["waiting"]), "waiting"],
    [count(["running", "bringing_back"]), "running"],
    [count(["done", "stopped", "lost"]), "done"],
  ]
    .filter(([n]) => n)
    .map(([n, word]) => `${n} ${word}`);
  const busy = jobs.filter((j) => j.state.kind !== "waiting").reduce((ms, j) => ms + ran(j, now), 0);
  return [...parts, `${dur(busy)} on workers`].join(" · ");
}

export type JobTone = "muted" | "accent" | "blocked" | "error" | "done";
/** The icon beside a worker's name: its kind, or a rerun's. */
export type JobIcon = "mac" | "host" | "central" | "cloud" | "rerun" | "worker";

const icon = (j: Job): JobIcon => (j.worker?.kind as JobIcon) ?? "worker";

/** A Jobs tab row's second line. */
export function jobRowLine(j: Job, now: number): { tone: JobTone; icon: JobIcon; text: string } {
  const where = j.worker?.name ?? "";
  const s = j.state;
  switch (s.kind) {
    case "waiting":
      return { tone: "accent", icon: "cloud", text: `Waiting for ${s.for}` };
    case "running":
      return { tone: "accent", icon: icon(j), text: `Running on ${s.worker} · ${clock(now - j.started_at)}` };
    case "bringing_back":
      return { tone: "accent", icon: icon(j), text: `Bringing changes back from ${where}` };
    case "stopped":
      return { tone: "muted", icon: icon(j), text: `Stopped · ${where}` };
    case "lost":
      return { tone: "error", icon: icon(j), text: "Lost" };
    case "done": {
      if (reran(j)) return { tone: "blocked", icon: "rerun", text: `Ran again on ${where} · exit ${s.exit}` };
      if (s.exit !== 0) return { tone: "error", icon: icon(j), text: [where, `exit ${s.exit}`, j.summary].filter(Boolean).join(" · ") };
      const left = j.leftovers.length ? ` · ${plural(j.leftovers.length, "leftover")}` : "";
      return { tone: "muted", icon: icon(j), text: `${where} · exit 0${left}` };
    }
  }
}

/** The line under a job's command in its detail. `session` is its session's name. */
export const jobStateLine = (j: Job, now: number, session: string) => stateLine(j, now, session, false);

/** The job tab's line: also when it ran, and who ran it. */
export const jobTabLine = (j: Job, now: number, session: string) => stateLine(j, now, session, true);

function stateLine(j: Job, now: number, session: string, tab: boolean): { tone: JobTone; text: string } {
  const who = `${tab ? "run " : ""}${j.tool_use_id ? `${tab ? "by " : ""}Claude in ${session}` : `in ${session}`}`;
  const when = tab && j.ended_at != null ? `${hms(j.started_at)} – ${hms(j.ended_at)}` : null;
  const s = j.state;
  const tail = (parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" · ");
  switch (s.kind) {
    case "waiting":
      return { tone: "accent", text: tail(["Waiting for a cloud machine", clock(now - j.started_at), who]) };
    case "running":
      return { tone: "accent", text: tail(["Running", clock(now - j.started_at), who]) };
    case "bringing_back":
      return { tone: "accent", text: tail(["Bringing changes back", who]) };
    case "done":
      return { tone: s.exit === 0 ? "done" : "error", text: tail([s.exit === 0 ? "Done" : "Failed", `exit ${s.exit}`, dur(ran(j, now)), when, who, j.summary]) };
    case "stopped":
      return { tone: "muted", text: tail(["Stopped", `exit ${s.exit}`, dur(ran(j, now)), when, who]) };
    case "lost":
      return { tone: "error", text: "Lost: the central host's daemon stopped during it" };
  }
}

export interface PhaseRow {
  name: string;
  state: "done" | "running" | "pending" | "warn";
  took: string | null;
  detail: string | null;
}

const hms = (ms: number) => {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
};

/** A job's steps: its phases, or after a rerun what happened when. */
export function phaseList(j: Job, now: number): PhaseRow[] {
  if (reran(j))
    return j.timeline.map((e) => ({ name: e.text, state: e.text.endsWith(" went away") ? "warn" : "done", took: hms(e.at), detail: e.detail ?? null }));
  const rows: PhaseRow[] = j.phases.map((p) => ({
    name: p.name,
    state: "done",
    took: p.name === "Exit status to Claude" || p.took_ms == null ? null : took(p.took_ms),
    detail: null,
  }));
  if (j.ended_at != null || j.state.kind === "done" || j.state.kind === "stopped") return rows;
  const has = (prefix: string) => rows.some((r) => r.name.startsWith(prefix));
  if (!has("Ran on")) rows.push({ name: "Running", state: "running", took: clock(now - j.started_at), detail: null });
  if (j.worker?.kind !== "central" && !has("Brought back")) rows.push({ name: "Bring changes back", state: "pending", took: null, detail: null });
  rows.push({ name: "Exit status to Claude", state: "pending", took: null, detail: null });
  return rows;
}

export interface BarPhase {
  label: string;
  took: string | null;
  /** Of the bar's width; a short phase still gets a sliver. */
  percent: number;
  tone: "done" | "accent" | "blocked";
}

const SHORT: Record<string, string> = { "Copy matched the session": "Copy matched", "Exit status to Claude": "To Claude" };

/** The job tab's bar: each phase at its real length, and the run going on. */
export function phaseBar(j: Job, now: number): BarPhase[] {
  const parts = j.phases.map((p) => ({
    label: SHORT[p.name] ?? p.name,
    ms: p.took_ms ?? 0,
    took: p.name === "Exit status to Claude" || p.took_ms == null ? null : took(p.took_ms),
    tone: (p.name === "Brought back" && j.leftovers.length ? "blocked" : "done") as BarPhase["tone"],
  }));
  if (j.state.kind === "running") {
    const ms = Math.max(0, now - j.started_at - parts.reduce((sum, p) => sum + p.ms, 0));
    parts.push({ label: "Running", ms, took: clock(ms), tone: "accent" });
  }
  const total = parts.reduce((sum, p) => sum + p.ms, 0);
  const grow = parts.map((p) => Math.max(p.ms, total / 50));
  const all = grow.reduce((a, b) => a + b, 0) || 1;
  return parts.map((p, i) => ({ label: p.label, took: p.took, percent: Math.round((grow[i] / all) * 100), tone: p.tone }));
}

type Worker = NonNullable<Job["worker"]>;

/** The worker as the job started on it, for **Worker** in the job tab. */
export function workerFacts(w: Worker): [string, string][] {
  const facts: [string, string | null][] = [
    ["Load at start", `${w.load.toFixed(1)} / ${w.cores}`],
    ["Slot", `${w.slot} of ${w.slots}`],
    ["Round trip", w.rtt_ms == null ? null : `${w.rtt_ms} ms`],
    ["Copy", w.copy ?? null],
  ];
  return facts.filter((f): f is [string, string] => f[1] != null);
}

/** The panel's worker card line: "load 1.2 / 10 · slot 1 of 2 · 6 ms". */
export function workerLine(w: Worker): string {
  return [`load ${w.load.toFixed(1)} / ${w.cores}`, `slot ${w.slot} of ${w.slots}`, w.rtt_ms == null ? null : `${w.rtt_ms} ms`].filter(Boolean).join(" · ");
}

/** The chip beside a routed Bash row: where its job runs or ran. */
export function chipFromJob(j: Job): { icon: JobIcon; text: string; rerun: boolean } {
  if (j.state.kind === "waiting") return { icon: "cloud", text: `on ${j.state.for}`, rerun: false };
  const name = j.worker?.name ?? (j.state.kind === "running" ? j.state.worker : "");
  if (reran(j)) return { icon: "rerun", text: `ran again on ${name}`, rerun: true };
  return { icon: icon(j), text: `on ${name}`, rerun: false };
}

/** The chip read from a routed command's output, when its job is not known. */
export function chipFromOutput(output: string): { icon: JobIcon; text: string; rerun: boolean } | null {
  const again = output.match(/^moonlet: .+ went away\. Running again on (.+)\.$/m);
  if (again) return { icon: "rerun", text: `ran again on ${again[1]}`, rerun: true };
  const first = output.match(/^moonlet: running on (.+)$/m);
  return first ? { icon: "worker", text: `on ${first[1]}`, rerun: false } : null;
}

/** A routed Bash row's chip: from its job when known, else from its result,
 * only for a command the hook rewrote. */
export function bashChip(job: Job | undefined, command: string, output: string | null | undefined) {
  if (job) return chipFromJob(job);
  return shownCommand(command) !== command ? chipFromOutput(output ?? "") : null;
}

/** The command as the agent wrote it, without the hook's `moonlet exec` in front. */
export function shownCommand(command: string): string {
  const m = command.match(/^'(?:[^']|'\\'')*' exec (?:--tool-use \S+ )?-- ([\s\S]*)$/);
  return m ? m[1] : command;
}

export interface OutputLine {
  n: number;
  stream: 1 | 2;
  text: string;
  /** `moonlet` for moonlet's own lines, `warn` for a worker going away. */
  tone: "moonlet" | "warn" | "stderr" | null;
}

// CSI and OSC sequences, and the lone escapes left.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]|\r/g;

const lineTone = (stream: 1 | 2, text: string): OutputLine["tone"] =>
  text.startsWith("moonlet: ") ? (text.includes(" went away") ? "warn" : "moonlet") : stream === 2 ? "stderr" : null;

/** A job's output as lines: a line ends at a newline or where the other stream takes over. */
export function outputLines(chunks: JobChunk[]): OutputLine[] {
  const lines: OutputLine[] = [];
  // The line not ended yet.
  let stream: 1 | 2 | null = null;
  let text = "";
  const end = () => {
    if (stream) lines.push({ n: lines.length + 1, stream, text, tone: lineTone(stream, text) });
    stream = null;
    text = "";
  };
  // Chunks of one stream in a row are joined first: a colour code or a
  // character can be cut between them.
  const joined: JobChunk[] = [];
  for (const c of chunks) {
    const last = joined[joined.length - 1];
    if (last?.stream === c.stream) last.text += c.text;
    else joined.push({ ...c });
  }
  for (const c of joined) {
    if (stream && stream !== c.stream) end();
    const parts = c.text.replace(ANSI, "").split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) end();
      if (i < parts.length - 1 || parts[i]) {
        stream = c.stream;
        text += parts[i];
      }
    }
  }
  end();
  return lines;
}

export type OutputFilter = "all" | "stdout" | "stderr";

/** The lines **All / stdout / stderr** and **Find in output** leave. */
export function shownLines(lines: OutputLine[], filter: OutputFilter, find: string): OutputLine[] {
  const q = find.trim().toLowerCase();
  return lines.filter((l) => (filter === "all" || l.stream === (filter === "stdout" ? 1 : 2)) && (!q || l.text.toLowerCase().includes(q)));
}
