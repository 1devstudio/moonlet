// The Jobs tab (X62): every routed command of the session, newest first, or
// one job in detail, the way the Agents tab shows subagents.

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Check, ChevronLeft, Circle, Cloud, Copy, Cpu, Laptop, LoaderCircle, RotateCw, Server } from "lucide-react";
import { copyJobOutput, openJobTab, stopJob } from "../lib/actions";
import { rpc } from "../lib/daemon";
import { type JobIcon, type JobTone, type OutputLine, chipFromJob, jobRowLine, jobStateLine, jobsSummary, dur, outputLines, phaseList, workerLine } from "../lib/jobs";
import { loadOutput, useJobs } from "../lib/jobsStore";
import { M, type Job, type Session } from "../lib/protocol";
import { clock } from "../lib/subagents";
import { useNow } from "../lib/useNow";
import { errorToast, useStore } from "../lib/store";
import { Empty, cx } from "./ui";

export const TONE: Record<JobTone, string> = {
  muted: "text-muted",
  accent: "text-accent",
  blocked: "text-blocked",
  error: "text-error",
  done: "text-done",
};

const ICONS = { mac: Laptop, host: Server, central: Server, cloud: Cloud, rerun: RotateCw, worker: Cpu };

export function WorkerIcon({ icon, size = 12, className }: { icon: JobIcon; size?: number; className?: string }) {
  const Icon = ICONS[icon];
  return <Icon size={size} aria-hidden="true" className={cx("shrink-0", className)} />;
}

export const going = (j: Job) => j.state.kind === "waiting" || j.state.kind === "running" || j.state.kind === "bringing_back";

/** Accent while it waits or runs, green for exit 0, red for any other end. */
export function JobDot({ job }: { job: Job }) {
  const s = job.state;
  const tone = going(job) ? "bg-accent" : s.kind === "done" && s.exit === 0 ? "bg-done" : s.kind === "stopped" ? "bg-faint" : "bg-error";
  return <span aria-hidden="true" className={cx("h-[7px] w-[7px] shrink-0 rounded-full", tone, going(job) && "animate-pulse")} />;
}

/** The job's stored output, then what it prints, as lines. */
export function useJobLines(host: string, job: string): OutputLine[] | null {
  const chunks = useJobs((s) => s.output[job]);
  useEffect(() => {
    void loadOutput(host, job).catch(errorToast);
  }, [host, job]);
  return useMemo(() => (chunks ? outputLines(chunks) : null), [chunks]);
}

export const LINE_TONE: Record<NonNullable<OutputLine["tone"]>, string> = { moonlet: "text-accent", warn: "text-blocked", stderr: "text-blocked" };

/** Keeps the end of the output in view while **Follow** is on. */
export function useFollow(follow: boolean, count: number) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [follow, count]);
  return box;
}

export const copyText = (lines: OutputLine[]) => lines.map((l) => l.text).join("\n");

/** The Jobs tab: the session's jobs, or one job in detail. */
export function JobsPanel({ host, ws, jobs }: { host: string; ws: Session; jobs: Job[] }) {
  const detail = useStore((s) => s.jobDetail);
  const now = useNow(jobs.some(going));
  const open = jobs.find((j) => j.id === detail);
  if (open) return <JobDetail host={host} ws={ws} job={open} now={now} />;
  if (!jobs.length) {
    return (
      <Empty icon={<Cpu size={20} />} title="No jobs yet">
        Heavy commands this session's agents run through moonlet show here.
      </Empty>
    );
  }
  const live = jobs.filter(going);
  const stopAll = () => void rpc(host, M.jobStopAll, { session: ws.id }).catch(errorToast);
  return (
    <div className="flex flex-col">
      <div className="flex h-10 shrink-0 items-center border-b border-border px-4 ui-text-12 text-muted">
        <span className="tabular-nums">{jobsSummary(jobs, now)}</span>
        {live.length > 0 && (
          <button className="ml-auto hover:text-fg" onClick={stopAll}>
            Stop all
          </button>
        )}
      </div>
      {jobs.map((j) => {
        const line = jobRowLine(j, now);
        return (
          <div
            key={j.id}
            role="button"
            data-job={j.command}
            onClick={() => useStore.setState({ jobDetail: j.id })}
            className="cursor-default border-b border-border px-4 py-3 hover:bg-panel-2"
          >
            <div className="flex items-center gap-2.5">
              <JobDot job={j} />
              <span className="min-w-0 flex-1 truncate font-mono ui-text-13 text-fg">{j.command}</span>
              <span className="shrink-0 font-mono ui-text-12 tabular-nums text-faint">{going(j) ? clock(now - j.started_at) : dur((j.ended_at ?? now) - j.started_at)}</span>
            </div>
            <div className={cx("mt-1 flex min-w-0 items-center gap-1.5 pl-[17px] ui-text-12.5", TONE[line.tone])}>
              <WorkerIcon icon={line.icon} />
              <span className="truncate">{line.text}</span>
            </div>
          </div>
        );
      })}
      <p className="px-4 py-4 ui-text-12 text-faint">Heavy commands this session's agents ran through moonlet. Click one for its output.</p>
    </div>
  );
}

const PHASE_ICON = {
  done: <Check size={13} className="text-muted" />,
  running: <LoaderCircle size={13} className="animate-spin text-accent" />,
  pending: <Circle size={9} className="mx-[2px] text-faint" />,
  warn: <RotateCw size={13} className="text-blocked" />,
};

function JobDetail({ host, ws, job, now }: { host: string; ws: Session; job: Job; now: number }) {
  const state = jobStateLine(job, now, ws.name);
  const lines = useJobLines(host, job.id);
  const [follow, setFollow] = useState(true);
  const box = useFollow(follow, lines?.length ?? 0);
  const central = useStore((s) => s.hosts[host]?.label) ?? "this Mac";
  const chip = chipFromJob(job);
  const runHere = () => void rpc(host, M.jobRunHere, { job: job.id }).catch(errorToast);
  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1 flex-col px-4 pb-4">
        <button className="-ml-1 mt-3 flex items-center gap-0.5 self-start ui-text-12.5 text-muted hover:text-fg" onClick={() => useStore.setState({ jobDetail: null })}>
          <ChevronLeft size={14} />
          Jobs
        </button>
        <div className="mt-3 flex items-center gap-2.5">
          <JobDot job={job} />
          <span className="selectable min-w-0 flex-1 break-all font-mono ui-text-14 text-fg">{job.command}</span>
          <button title="Open as a tab" className="rounded p-1 text-muted hover:bg-hover hover:text-fg" onClick={() => openJobTab(host, ws.id, job.id)}>
            <ArrowUpRight size={14} />
          </button>
        </div>
        <div className="mt-1 pl-[17px] ui-text-12.5 text-muted">
          <span className={TONE[state.tone]}>{state.text.split(" · ")[0]}</span>
          {state.text.split(" · ").slice(1).map((p) => ` · ${p}`)}
        </div>
        <div className="mt-4 flex flex-col gap-0.5">
          {phaseList(job, now).map((p, i) => (
            <div key={i} className="flex min-h-7 items-start gap-2.5 py-1">
              <span className="flex h-[18px] w-[14px] items-center justify-center">{PHASE_ICON[p.state]}</span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className={cx("ui-text-12.5", p.state === "pending" ? "text-faint" : p.state === "warn" ? "text-blocked" : "text-fg")}>{p.name}</span>
                {p.detail && <span className="ui-text-12 text-muted">{p.detail}</span>}
              </span>
              {p.took && <span className="font-mono ui-text-12 tabular-nums text-muted">{p.took}</span>}
            </div>
          ))}
        </div>
        {job.worker && (
          <div className="mt-3 rounded-lg border border-border bg-panel-2 px-3 py-2.5">
            <div className="flex items-center gap-2 ui-text-13 text-fg">
              <WorkerIcon icon={chip.icon} size={14} className={chip.rerun ? "text-blocked" : "text-done"} />
              {job.worker.name}
              {job.worker.kind === "central" && <span className="rounded bg-raised px-1.5 ui-text-11.5 text-muted">Central host</span>}
            </div>
            <div className="mt-1 font-mono ui-text-12 text-muted">{workerLine(job.worker)}</div>
          </div>
        )}
        <div className="mt-4 flex items-center gap-2 ui-text-12.5">
          <span className="text-fg">Output</span>
          <span className="text-faint">{lines ? `${lines.length} ${lines.length === 1 ? "line" : "lines"}` : ""}</span>
          <label className="ml-auto flex items-center gap-1.5 text-muted">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            Follow
          </label>
          <button title="Copy output" className="rounded p-1 text-muted hover:bg-hover hover:text-fg" onClick={() => lines && copyJobOutput(copyText(lines))}>
            <Copy size={13} />
          </button>
        </div>
        <div ref={box} data-job-output className="selectable mt-2 min-h-[160px] flex-1 overflow-y-auto rounded-lg border border-border bg-panel px-3 py-2 font-mono ui-text-12 leading-[1.55]">
          {lines?.map((l) => (
            <div key={l.n} className={cx("whitespace-pre-wrap break-all", l.tone ? LINE_TONE[l.tone] : "text-fg")}>
              {l.text || " "}
            </div>
          ))}
        </div>
      </div>
      {job.state.kind === "waiting" ? (
        <div className="flex h-11 shrink-0 items-center justify-end border-t border-border px-4">
          <button className="ui-text-12.5 text-accent hover:text-accent-2" onClick={runHere}>
            Run on {central} now
          </button>
        </div>
      ) : (
        going(job) && (
          <div className="flex h-11 shrink-0 items-center gap-2 border-t border-border px-4 ui-text-12.5">
            <span className="min-w-0 flex-1 truncate text-faint">Changes made so far still come back.</span>
            <button className="text-muted hover:text-fg" onClick={() => stopJob(host, job.id)}>
              Stop
            </button>
          </div>
        )
      )}
    </div>
  );
}
