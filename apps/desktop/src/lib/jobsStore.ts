// Jobs (X62) as the app keeps them: each session's jobs, from `job.list`
// and `job.changed`, and the output of the jobs a view shows, from
// `job.output` and its event. Jobs live on the session's host.

import { useEffect } from "react";
import { create } from "zustand";
import { onDaemonEvent, rpc } from "./daemon";
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
/** The central host keeps a session's last 50 jobs; a job past them leaves. */
const KEPT = 50;
/** Output that came while a job's stored output was being read. */
const pending: Record<string, JobChunk[]> = {};

/** Reads a session's jobs once; later ones come as `job.changed`. */
export function loadJobs(host: string, session: string) {
  const k = key(host, session);
  if (loading.has(k)) return;
  loading.add(k);
  void rpc<Job[]>(host, M.jobList, { session }).then(
    (list) => useJobs.setState((s) => ({ jobs: { ...s.jobs, [k]: list } })),
    () => loading.delete(k),
  );
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
      useJobs.setState((s) => {
        const list = s.jobs[k];
        if (!list) return s;
        const i = list.findIndex((j) => j.id === job.id);
        const next = i < 0 ? [job, ...list].slice(0, KEPT) : list.map((j) => (j.id === job.id ? job : j));
        return { jobs: { ...s.jobs, [k]: next } };
      });
      if (job.ended_at != null && useJobs.getState().output[job.id]) void loadOutput(e.host, job.id).catch(() => {});
    } else if (e.name === EV.jobOutput) {
      const ev = e.data as { job: string; chunks: JobChunk[] };
      if (pending[ev.job]) pending[ev.job].push(...ev.chunks);
      else useJobs.setState((s) => (s.output[ev.job] ? { output: { ...s.output, [ev.job]: [...s.output[ev.job], ...ev.chunks] } } : s));
    }
  });
}
