// A session's Jobs tab (X62, X63): its routed commands, newest first, or one
// in detail with its output, as the desktop's Jobs tab shows them.

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, Circle, Cloud, Cpu, Laptop, LoaderCircle, RotateCw, Server } from "lucide-react";
import { rpc } from "@desktop/lib/daemon";
import { type JobIcon, type JobTone, chipFromJob, going, dur, jobRowLine, jobStateLine, jobsSummary, outputLines, phaseList, workerLine } from "@desktop/lib/jobs";
import { loadOutput, useJobs } from "@desktop/lib/jobsStore";
import { M, type Job, type Session } from "@desktop/lib/protocol";
import { clock } from "@desktop/lib/subagents";
import { useApp } from "../lib/app";
import { jobFooter } from "../lib/jobsView";
import { useNow } from "../lib/now";
import { Btn, cx } from "../components/ui";

const TONE: Record<JobTone, string> = { muted: "text-muted", accent: "text-accent", blocked: "text-blocked", error: "text-error", done: "text-done" };
const ICONS = { mac: Laptop, host: Server, central: Server, cloud: Cloud, rerun: RotateCw, worker: Cpu };
const LINE_TONE = { moonlet: "text-accent", warn: "text-blocked", stderr: "text-blocked" };

function WorkerIcon({ icon, className }: { icon: JobIcon; className?: string }) {
  const Icon = ICONS[icon];
  return <Icon size={13} aria-hidden="true" className={cx("flex-none", className)} />;
}

function JobDot({ job }: { job: Job }) {
  const s = job.state;
  const tone = going(job) ? "bg-accent" : s.kind === "done" && s.exit === 0 ? "bg-done" : s.kind === "stopped" ? "bg-faint" : "bg-error";
  return <span aria-hidden="true" className={cx("h-2 w-2 flex-none rounded-full", tone, going(job) && "animate-pulse")} />;
}

const fail = (e: unknown) => console.error(e);

export function JobsTab({ host, session, jobs }: { host: string; session: Session; jobs: Job[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const now = useNow(jobs.some(going) ? 1000 : 30_000);
  const job = jobs.find((j) => j.id === open);
  if (job) return <JobDetail host={host} session={session} job={job} now={now} onBack={() => setOpen(null)} />;
  const live = jobs.some(going);
  return (
    <div className="scroll h-full">
      <div className="flex h-11 items-center border-b border-border px-4 text-[13px] text-muted">
        <span className="tabular-nums">{jobsSummary(jobs, now)}</span>
        {live && (
          <button type="button" className="ml-auto text-muted" onClick={() => void rpc(host, M.jobStopAll, { session: session.id }).catch(fail)}>
            Stop all
          </button>
        )}
      </div>
      {jobs.map((j) => {
        const line = jobRowLine(j, now);
        return (
          <button key={j.id} type="button" onClick={() => setOpen(j.id)} className="flex w-full flex-col gap-1 border-b border-border px-4 py-3 text-left">
            <span className="flex w-full items-center gap-2.5">
              <JobDot job={j} />
              <span className="min-w-0 flex-1 truncate font-mono text-[13.5px]">{j.command}</span>
              <span className="flex-none font-mono text-[12px] tabular-nums text-faint">{going(j) ? clock(now - j.started_at) : dur((j.ended_at ?? now) - j.started_at)}</span>
            </span>
            <span className={cx("flex min-w-0 items-center gap-1.5 pl-[18px] text-[12.5px]", TONE[line.tone])}>
              <WorkerIcon icon={line.icon} />
              <span className="truncate">{line.text}</span>
            </span>
          </button>
        );
      })}
      <p className="px-4 py-4 text-[12.5px] text-faint">Heavy commands this session's agents ran through moonlet. Tap one for its output.</p>
    </div>
  );
}

const PHASE_ICON = {
  done: <Check size={13} className="text-muted" />,
  running: <LoaderCircle size={13} className="animate-spin text-accent" />,
  pending: <Circle size={9} className="mx-[2px] text-faint" />,
  warn: <RotateCw size={13} className="text-blocked" />,
};

function JobDetail({ host, session, job, now, onBack }: { host: string; session: Session; job: Job; now: number; onBack: () => void }) {
  const hostLabel = useApp((s) => s.hosts[host]?.label ?? host);
  const chunks = useJobs((s) => s.output[job.id]);
  useEffect(() => {
    void loadOutput(host, job.id).catch(fail);
  }, [host, job.id]);
  const lines = useMemo(() => (chunks ? outputLines(chunks) : null), [chunks]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines?.length]);
  const state = jobStateLine(job, now, session.name);
  const footer = jobFooter(job, session.name, hostLabel);
  const chip = chipFromJob(job);
  const stop = () => void rpc(host, M.jobStop, { job: job.id }).catch(fail);
  return (
    <div className="flex h-full flex-col">
      <div className="scroll flex min-h-0 flex-1 flex-col px-4 pb-4">
        <button type="button" onClick={onBack} className="-ml-1 mt-3 flex items-center gap-0.5 self-start text-[13px] text-muted">
          <ChevronLeft size={16} /> Jobs
        </button>
        <div className="mt-3 flex items-center gap-2.5">
          <JobDot job={job} />
          <span className="min-w-0 flex-1 font-mono text-[14px] break-all">{job.command}</span>
        </div>
        <div className="mt-1 pl-[18px] text-[13px] text-muted">
          <span className={TONE[state.tone]}>{state.text.split(" · ")[0]}</span>
          {state.text
            .split(" · ")
            .slice(1)
            .map((p) => ` · ${p}`)}
        </div>
        {footer?.note && <p className="mt-3 text-[13px] leading-[1.45] text-muted">{footer.note}</p>}
        <div className="mt-4 flex flex-col">
          {phaseList(job, now).map((p, i) => (
            <div key={i} className="flex min-h-8 items-start gap-2.5 py-1">
              <span className="flex h-[18px] w-[14px] items-center justify-center">{PHASE_ICON[p.state]}</span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className={cx("text-[13px]", p.state === "pending" ? "text-faint" : p.state === "warn" ? "text-blocked" : "text-fg")}>{p.name}</span>
                {p.detail && <span className="text-[12.5px] text-muted">{p.detail}</span>}
              </span>
              {p.took && <span className="font-mono text-[12px] tabular-nums text-muted">{p.took}</span>}
            </div>
          ))}
        </div>
        {job.worker && (
          <div className="mt-3 rounded-[10px] border border-border bg-raised px-3 py-2.5">
            <div className="flex items-center gap-2 text-[13.5px]">
              <WorkerIcon icon={chip.icon} className={chip.rerun ? "text-blocked" : "text-done"} />
              {job.worker.name}
              {job.worker.kind === "central" && <span className="rounded bg-panel px-1.5 text-[11.5px] text-muted">Central host</span>}
            </div>
            <div className="mt-1 font-mono text-[12px] text-muted">{workerLine(job.worker)}</div>
          </div>
        )}
        <div className="mt-4 flex items-center gap-2 text-[13px]">
          <span>Output</span>
          <span className="text-faint">{lines ? `${lines.length} ${lines.length === 1 ? "line" : "lines"}` : ""}</span>
        </div>
        <div ref={box} className="mt-2 max-h-[50vh] min-h-[160px] overflow-y-auto rounded-[10px] border border-border bg-bg px-3 py-2 font-mono text-[12px] leading-[1.55]">
          {lines?.map((l) => (
            <div key={l.n} className={cx("break-all whitespace-pre-wrap", l.tone ? LINE_TONE[l.tone] : "text-fg")}>
              {l.text || " "}
            </div>
          ))}
        </div>
      </div>
      {footer && (
        <div className="flex flex-none flex-col gap-2 border-t border-border px-4 pt-3 pb-3">
          {footer.stop && <span className="text-center text-[12.5px] text-faint">{footer.stop}</span>}
          {footer.runHere && (
            <Btn tone="primary" onClick={() => void rpc(host, M.jobRunHere, { job: job.id }).catch(fail)}>
              {footer.runHere}
            </Btn>
          )}
          <Btn onClick={stop}>Stop</Btn>
        </div>
      )}
    </div>
  );
}
