// Jobs (X62) as the app keeps them: each session's jobs, from `job.list`
// and `job.changed`, the lines that stayed on its host, from `job.stayed`,
// and the output of the jobs a view shows, from
// `job.output` and its event. Jobs live on the session's host.

import { parseCopyHost } from "./copyHost";
import { useEffect } from "react";
import { create } from "zustand";
import { DaemonError, onDaemonEvent, onHostStatus, rpc } from "./daemon";
import { type JobOutput, readOutput } from "./jobs";
import { EV, M, type Job, type JobChunk, type JobStayed } from "./protocol";

interface JobsState {
  /** By `host/session`, newest first as `job.list` gives them. */
  jobs: Record<string, Job[]>;
  /** By job id, for the jobs whose output a view has loaded: its last
   *  part, read as lines as it comes (X81). */
  output: Record<string, JobOutput>;
  /** By `host/session`, newest first: lines with a heavy command that ran
   *  on the session's host, not through moonlet. */
  stayed: Record<string, JobStayed[]>;
}

export const useJobs = create<JobsState>(() => ({ jobs: {}, output: {}, stayed: {} }));

const key = (host: string, session: string) => `${host}/${session}`;
const loading = new Set<string>();
/** Every session whose jobs were asked for, read or not, by key: a host
 * that reconnects reads them again. Host ids may hold a slash. */
const wanted = new Map<string, { host: string; session: string }>();
/** Jobs that changed while their session's list was being read, by key. */
const early: Record<string, Job[]> = {};
/** The central host keeps a session's last 50 jobs; a job past them leaves. */
const KEPT = 50;
/** Lines that stayed while a session's list of them was being read, by key. */
const earlyStayed: Record<string, JobStayed[]> = {};
/** The daemon keeps a session's last 20 lines that stayed on its host. */
const STAYED_KEPT = 20;
/** Output that came while a job's stored output was being read. */
const pending: Record<string, JobChunk[]> = {};

/** `list` with `job` in it, new or changed, keeping the newest `KEPT`. */
function upsert(list: Job[], job: Job): Job[] {
  const i = list.findIndex((j) => j.id === job.id);
  return i < 0 ? [job, ...list].slice(0, KEPT) : list.map((j) => (j.id === job.id ? job : j));
}

/** Reads a session's jobs once; later ones come as `job.changed`, and the
 * list is read again when its host reconnects. */
export function loadJobs(host: string, session: string, again = false) {
  // Another member's session through its central host (X72) has no jobs here.
  if (parseCopyHost(host)) return;
  const k = key(host, session);
  wanted.set(k, { host, session });
  if (loading.has(k) && !again) return;
  loading.add(k);
  early[k] = [];
  void rpc<Job[]>(host, M.jobList, { session }).then(
    (list) => {
      // What changed while it was read wins over the list.
      const changed = early[k] ?? [];
      delete early[k];
      setJobs(k, changed.reduceRight(upsert, list));
    },
    () => {
      delete early[k];
      loading.delete(k);
    },
  );
  // A daemon from before has no such list: none stayed, as far as it says.
  // Lines that come while it is read go first, each once.
  earlyStayed[k] = [];
  const read = (list: JobStayed[]) => {
    const came = earlyStayed[k] ?? [];
    delete earlyStayed[k];
    const same = (a: JobStayed, b: JobStayed) => a.at === b.at && a.command === b.command;
    const merged = [...came, ...list.filter((s) => !came.some((c) => same(c, s)))].slice(0, STAYED_KEPT);
    useJobs.setState((s) => ({ stayed: { ...s.stayed, [k]: merged } }));
  };
  void rpc<JobStayed[]>(host, M.jobStayed, { session }).then(read, () => read(useJobs.getState().stayed[k] ?? []));
}

/** Sets session `k`'s jobs, forgetting the output of jobs no longer kept. */
function setJobs(k: string, list: Job[]) {
  useJobs.setState((s) => {
    const kept = new Set(list.map((j) => j.id));
    const gone = (s.jobs[k] ?? []).filter((j) => !kept.has(j.id)).map((j) => j.id);
    const output = gone.some((id) => s.output[id]) ? Object.fromEntries(Object.entries(s.output).filter(([id]) => !gone.includes(id))) : s.output;
    return { jobs: { ...s.jobs, [k]: list }, output };
  });
}

/** A session's jobs, newest first, read when first asked for. */
export function useSessionJobs(host: string, session: string): Job[] {
  useEffect(() => loadJobs(host, session), [host, session]);
  return useJobs((s) => s.jobs[key(host, session)] ?? EMPTY);
}

const EMPTY: Job[] = [];
const NONE: JobStayed[] = [];

/** A session's lines that stayed on its host, newest first. */
export function useSessionStayed(host: string, session: string): JobStayed[] {
  useEffect(() => loadJobs(host, session), [host, session]);
  return useJobs((s) => s.stayed[key(host, session)] ?? NONE);
}

/** The job a chat's tool call started, matched by its id; none for a call not routed. */
export function useToolJob(host: string, session: string, toolUse: string, routable: boolean): Job | undefined {
  useEffect(() => {
    if (routable && session) loadJobs(host, session);
  }, [host, session, routable]);
  return useJobs((s) => (routable ? s.jobs[key(host, session)]?.find((j) => j.tool_use_id === toolUse) : undefined));
}

/** One job of a session: undefined until the session's jobs are read, null once it is not kept. */
export function useSessionJob(host: string, session: string, job: string): Job | null | undefined {
  useEffect(() => loadJobs(host, session), [host, session]);
  return useJobs((s) => {
    const list = s.jobs[key(host, session)];
    return list && (list.find((j) => j.id === job) ?? null);
  });
}

/**
 * Reads job `job`'s whole stored output; new output comes as events. Output
 * that comes while it is read is added after it, so a running job's view may
 * repeat a line there; the job's end reads it again, as stored.
 */
export async function loadOutput(host: string, job: string) {
  if (pending[job]) return;
  pending[job] = [];
  // Each page is read as it comes, so a long output is never held whole.
  let out: JobOutput | undefined;
  try {
    let from = 0;
    for (;;) {
      const r = await rpc<{ chunks: JobChunk[]; next: number; more: boolean }>(host, M.jobOutput, { job, from });
      out = readOutput(out, r.chunks);
      from = r.next;
      if (!r.more) break;
    }
    const read = readOutput(out, pending[job]);
    useJobs.setState((s) => ({ output: { ...s.output, [job]: read } }));
  } catch (e) {
    // A job dropped from the history has no output to show.
    if (!(e instanceof DaemonError && e.code === "not_found")) throw e;
  } finally {
    delete pending[job];
  }
}

let started = false;

/** Follows `job.changed`, `job.stayed` and `job.output` from every host. */
export function startJobs() {
  if (started) return;
  started = true;
  void onDaemonEvent((e) => {
    if (e.name === EV.jobChanged) {
      const job = e.data as Job;
      const k = key(e.host, job.session);
      const list = useJobs.getState().jobs[k];
      if (early[k]) early[k].push(job);
      else if (list) setJobs(k, upsert(list, job));
      if (job.ended_at != null && useJobs.getState().output[job.id]) void loadOutput(e.host, job.id).catch(() => {});
    } else if (e.name === EV.jobStayed) {
      const st = e.data as JobStayed;
      const k = key(e.host, st.session);
      if (earlyStayed[k]) earlyStayed[k].unshift(st);
      else useJobs.setState((s) => (s.stayed[k] ? { stayed: { ...s.stayed, [k]: [st, ...s.stayed[k]].slice(0, STAYED_KEPT) } } : s));
    } else if (e.name === EV.jobOutput) {
      const ev = e.data as { job: string; chunks: JobChunk[] };
      if (pending[ev.job]) pending[ev.job].push(...ev.chunks);
      else useJobs.setState((s) => (s.output[ev.job] ? { output: { ...s.output, [ev.job]: readOutput(s.output[ev.job], ev.chunks) } } : s));
    }
  });
  // A host that comes back may have ended or lost jobs meanwhile.
  void onHostStatus((h) => {
    if (h.status !== "connected") return;
    for (const w of wanted.values()) if (w.host === h.id) loadJobs(w.host, w.session, true);
  });
}
