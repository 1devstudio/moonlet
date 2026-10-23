// The Workers page (X62): the machines that run a central host's heavy
// commands, their load and slots, what they run now, and why one was
// skipped. Pure: components/settings/WorkersPage.tsx renders it.

import { machineLine, removedLine, type MachineLine } from "./cloudMachines";
import type { CloudMachine, ExecStatus, LinkInfo, WorkerInfo } from "./protocol";

export interface WorkerRow {
  id: string;
  name: string;
  badges: string[];
  line: { tone: "muted" | "blocked"; text: string };
  /** The 1-minute load against the cores; null when unknown. */
  load: { text: string; fraction: number; busy: boolean } | null;
  slots: string;
  rtt: string;
  running: { session: string; command: string; since: number }[];
  /** The project this worker has not approved, for **Approve**. */
  approve: { project: string } | null;
}

export interface WorkersInput {
  workers: WorkerInfo[];
  status: ExecStatus;
  /** This Mac's worker id, when it is one of the workers. */
  me: string | null;
  /** Session names by id. */
  sessions: Record<string, string>;
  /** The central host's cloud machines (X63), from `cloud.machines`. */
  cloud?: CloudMachine[];
  /** Machines removed in the last hour. */
  removed?: CloudMachine[];
  now?: number;
  /** Sessions by id, with whether they asked for the cloud. */
  cloudSessions?: Record<string, { name: string; cloud?: boolean }>;
}

/** A cloud machine's row: its state line, and its worker's columns once it has one. */
export interface CloudRow {
  id: string;
  name: string;
  line: MachineLine;
  load: WorkerRow["load"];
  slots: string;
  rtt: string;
  running: WorkerRow["running"];
}

const osName = (os: string) => (os === "macos" ? "macOS" : os === "linux" ? "Linux" : os);

function load(value: number | null | undefined, cores: number): WorkerRow["load"] {
  if (value == null) return null;
  const c = Math.max(cores, 1);
  return { text: `${value.toFixed(1)} / ${cores}`, fraction: Math.min(value / c, 1), busy: value >= 0.7 * c };
}

export function workersPage(input: WorkersInput): { rows: WorkerRow[]; cloud: CloudRow[]; removed: string[]; summary: string; empty: boolean } {
  const { status } = input;
  const runningOn = (name: string) =>
    status.running.filter((r) => r.worker === name).map((r) => ({ session: input.sessions[r.session] ?? r.session, command: r.command, since: r.started_at }));
  const linked = input.workers.filter((w) => w.heavy);
  const machines = input.cloud ?? [];
  const cloudWorkers = new Set(machines.map((m) => m.worker).filter(Boolean));
  const rows: WorkerRow[] = linked.filter((w) => !cloudWorkers.has(w.id)).map((w) => {
    const running = runningOn(w.name);
    const skip = status.skips.find((s) => s.worker === w.id);
    const basics = `${osName(w.os)} · ${w.cores} cores`;
    let line: WorkerRow["line"] = { tone: "muted", text: basics };
    if (skip?.reason === "not_approved") line = { tone: "blocked", text: `Not approved for ${skip.project}` };
    else if (skip) line = { tone: "blocked", text: `${basics} · skipped for ${skip.project}: ${skip.detail ?? skip.reason}` };
    return {
      id: w.id,
      name: w.name,
      badges: w.id === input.me ? ["This Mac"] : [],
      line,
      load: load(w.load, w.cores),
      slots: `${running.length} of ${w.slots}`,
      rtt: w.rtt_ms == null ? "–" : `${w.rtt_ms} ms`,
      running,
      approve: skip?.reason === "not_approved" ? { project: skip.project } : null,
    };
  });
  const h = status.host;
  const hostLoad = load(h.load, h.cores);
  const busy = h.used >= h.slots || !!hostLoad?.busy;
  const basics = `${osName(h.os)} · ${h.cores} cores`;
  rows.push({
    id: h.name,
    name: h.name,
    badges: ["Central host"],
    line: busy ? { tone: "blocked", text: `${basics} · busy, takes commands no one else can` } : { tone: "muted", text: basics },
    load: hostLoad,
    slots: `${runningOn(h.name).length} of ${h.slots}`,
    rtt: "–",
    running: runningOn(h.name),
    approve: null,
  });
  const cloud: CloudRow[] = machines.map((m) => {
    const w = linked.find((x) => x.id === m.worker);
    const running = w ? runningOn(w.name) : [];
    return {
      id: m.id,
      name: m.name,
      line: machineLine(m, input.now ?? 0, input.cloudSessions ?? {}),
      load: w ? load(w.load, w.cores) : null,
      slots: w ? `${running.length} of ${w.slots}` : "–",
      rtt: w?.rtt_ms == null ? "–" : `${w.rtt_ms} ms`,
      running,
    };
  });
  const n = status.running.length;
  const total = linked.reduce((sum, w) => sum + w.slots, h.slots);
  return {
    rows,
    cloud,
    removed: (input.removed ?? []).map(removedLine),
    summary: `${n} ${n === 1 ? "command" : "commands"} running · ${n} of ${total} slots in use`,
    empty: linked.length === 0 && machines.length === 0,
  };
}

/** The host Approve on worker `worker`'s row goes to: the one whose own
 * `link.get` (`links`, by host id) names it; null when the app reaches none. */
export function workerHost(worker: string, links: Record<string, LinkInfo | null>): string | null {
  return Object.entries(links).find(([, l]) => l?.worker.id === worker)?.[0] ?? null;
}
