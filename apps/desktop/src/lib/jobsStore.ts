// Jobs (X62) as the app keeps them: each session's jobs, from `job.list`
// and `job.changed`, and the output of the jobs a view shows, from
// `job.output` and its event. Jobs live on the session's host.

import { useEffect } from "react";
import { create } from "zustand";
import { DaemonError, onDaemonEvent, onHostStatus, rpc } from "./daemon";
import { EV, M, type Job, type JobChunk } from "./protocol";

interface JobsState {
  /** By `host/session`, newest first as `job.list` gives them. */
  jobs: Record<string, Job[]>;
  /** By job id, for the jobs whose output a view has loaded. */
  output: Record<string, JobChunk[]>;
}

export const useJobs = create<JobsState>(() => ({ jobs: {}, output: {} }));

const key = (host: string, session: string) => `${host}/${session}`;
const loading = new Set<string>();
/** Jobs that changed while their session's list was being read, by key. */
const early: Record<string, Job[]> = {};
/** The central host keeps a session's last 50 jobs; a job past them leaves. */
const KEPT = 50;
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
  const k = key(host, session);
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
  const chunks: JobChunk[] = [];
  try {
    let from = 0;
    for (;;) {
      const r = await rpc<{ chunks: JobChunk[]; next: number; more: boolean }>(host, M.jobOutput, { job, from });
      chunks.push(...r.chunks);
      from = r.next;
      if (!r.more) break;
    }
    useJobs.setState((s) => ({ output: { ...s.output, [job]: [...chunks, ...pending[job]] } }));
  } catch (e) {
    // A job dropped from the history has no output to show.
    if (!(e instanceof DaemonError && e.code === "not_found")) throw e;
  } finally {
    delete pending[job];
  }
}

let started = false;

/** Follows `job.changed` and `job.output` from every host. */
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
    } else if (e.name === EV.jobOutput) {
      const ev = e.data as { job: string; chunks: JobChunk[] };
      if (pending[ev.job]) pending[ev.job].push(...ev.chunks);
      else useJobs.setState((s) => (s.output[ev.job] ? { output: { ...s.output, [ev.job]: [...s.output[ev.job], ...ev.chunks] } } : s));
    }
  });
  // A host that comes back may have ended or lost jobs meanwhile.
  void onHostStatus((h) => {
    if (h.status !== "connected") return;
    for (const k of Object.keys(useJobs.getState().jobs)) {
      const [host, ...rest] = k.split("/");
      if (host === h.id) loadJobs(host, rest.join("/"), true);
    }
  });
}
