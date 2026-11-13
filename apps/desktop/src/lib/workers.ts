// The Workers page (X62): the machines that run a central host's heavy
// commands, their load and slots, what they run now, and why one was
// skipped. Pure: components/settings/WorkersPage.tsx renders it.

import { machineLine, removedLine, type MachineLine } from "./cloudMachines";
import type { CloudMachine, ExecStatus, LinkInfo, WorkerInfo, WorkerSettingsEntry } from "./protocol";

export interface WorkerRow {
  id: string;
  name: string;
  badges: string[];
  line: { tone: "muted" | "blocked"; text: string };
  /** The 1-minute load against the cores; null when unknown. */
  load: { text: string; fraction: number; busy: boolean } | null;
  slots: string;
  rtt: string;
  /** Each with the host whose session it is, when it runs for another
   * host than the one the page is about (X89). */
  running: { session: string; command: string; since: number; host?: string }[];
  /** The project this worker has not approved, for **Approve**. */
  approve: { project: string } | null;
  /** Its switch and slots (X89), which any app changes; null from a
   * central host before X89. */
  settings: { worker: string; heavy: boolean; slots: number } | null;
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
  /** `worker.settings` from the central host, itself first (X89); null
   * when it is older and knows no such method. */
  settings?: WorkerSettingsEntry[] | null;
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

/** What the Workers page shows. `hint` stands above the rows while no host
 * takes the others' commands; `update` asks to update an older central host. */
export interface WorkersPageView {
  rows: WorkerRow[];
  cloud: CloudRow[];
  removed: string[];
  summary: string;
  empty: boolean;
  hint: string | null;
  update: string | null;
}

const NOBODY = "No host runs heavy commands for the others yet. Turn on Takes heavy commands from other hosts on a host below.";

/** The toast after a member's switch or slots changed (X89). */
export function settingsToast(name: string, change: { heavy?: boolean; slots?: number }): string {
  if (change.heavy !== undefined) return change.heavy ? `${name} takes heavy commands from your other hosts` : `${name} no longer takes heavy commands from your other hosts`;
  const n = change.slots ?? 0;
  return `${name} runs at most ${n} heavy ${n === 1 ? "command" : "commands"} at once`;
}

export function workersPage(input: WorkersInput): WorkersPageView {
  const { status } = input;
  const members = input.settings ?? null;
  // Since X89 every member is listed, with its switch and slots; the
  // central host's own entry comes first.
  const settingsOf = (id: string) => {
    const e = members?.find((m) => m.worker === id);
    return e ? { worker: e.worker, heavy: e.heavy, slots: e.slots } : null;
  };
  const runningOn = (name: string) =>
    status.running.filter((r) => r.worker === name).map((r) => ({ session: input.sessions[r.session] ?? r.session, command: r.command, since: r.started_at }));
  const linked = input.workers.filter((w) => w.heavy || (members !== null && settingsOf(w.id) !== null && members[0]?.worker !== w.id));
  const machines = input.cloud ?? [];
  // A removed machine's worker may still be connected for a moment.
  const cloudWorkers = new Set([...machines, ...(input.removed ?? [])].map((m) => m.worker).filter(Boolean));
  const rows: WorkerRow[] = linked.filter((w) => !cloudWorkers.has(w.id)).map((w) => {
    // Its own jobs from this central host, then what it runs for other
    // hosts (X89).
    const serving = (w.running ?? [])
      .filter((s) => s.host !== status.host.name)
      .map((s) => ({ session: s.session, command: s.command, since: s.started_at, host: s.host }));
    const running = [...runningOn(w.name), ...serving];
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
      slots: `${Math.max(running.length, w.used ?? 0)} of ${w.slots}`,
      rtt: w.rtt_ms == null ? "–" : `${w.rtt_ms} ms`,
      running,
      approve: skip?.reason === "not_approved" ? { project: skip.project } : null,
      settings: settingsOf(w.id),
    };
  });
  // Members that are not linked now: their settings still change, and
  // reach them when they link.
  for (const m of (members ?? []).slice(1)) {
    if (rows.some((r) => r.id === m.worker) || cloudWorkers.has(m.worker)) continue;
    rows.push({
      id: m.worker,
      name: m.name,
      badges: m.worker === input.me ? ["This Mac"] : [],
      line: { tone: "muted", text: "Not connected · changes apply when it links" },
      load: null,
      slots: "–",
      rtt: "–",
      running: [],
      approve: null,
      settings: settingsOf(m.worker),
    });
  }
  if (members) rows.sort((a, b) => a.name.localeCompare(b.name));
  const h = status.host;
  const hostLoad = load(h.load, h.cores);
  const busy = h.used >= h.slots || !!hostLoad?.busy;
  const basics = `${osName(h.os)} · ${h.cores} cores`;
  // The central host's own runs, then what it runs for members (X89).
  const centralRunning = [
    ...runningOn(h.name),
    ...(status.serving ?? []).map((s) => ({ session: s.session, command: s.command, since: s.started_at, host: s.host })),
  ];
  rows.push({
    id: h.name,
    name: h.name,
    badges: ["Central host"],
    line: busy ? { tone: "blocked", text: `${basics} · busy, takes commands no one else can` } : { tone: "muted", text: basics },
    load: hostLoad,
    slots: `${centralRunning.length} of ${h.slots}`,
    rtt: "–",
    running: centralRunning,
    approve: null,
    settings: members?.[0] ? settingsOf(members[0].worker) : null,
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
  const taking = linked.filter((w) => w.heavy);
  const total = taking.reduce((sum, w) => sum + w.slots, h.slots);
  const nobody = taking.length === 0 && machines.length === 0;
  return {
    rows,
    cloud,
    removed: (input.removed ?? []).map(removedLine),
    summary: `${n} ${n === 1 ? "command" : "commands"} running · ${n} of ${total} slots in use`,
    // Since X89 the rows stay, so a host can be turned on right there.
    empty: nobody && members === null,
    hint: nobody && members !== null ? NOBODY : null,
    update: input.settings === null ? `Update moonlet on ${h.name} to run commands between your hosts` : null,
  };
}

/** The host Approve on worker `worker`'s row goes to: the one whose own
 * `link.get` (`links`, by host id) names it; null when the app reaches none. */
export function workerHost(worker: string, links: Record<string, LinkInfo | null>): string | null {
  return Object.entries(links).find(([, l]) => l?.worker.id === worker)?.[0] ?? null;
}
