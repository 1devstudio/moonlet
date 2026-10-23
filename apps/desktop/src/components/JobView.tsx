// A job as a session tab (X62): its whole output with filters and find, the
// phases at their real lengths, and what came back from the worker.

import { useEffect, useMemo, useState } from "react";
import { Copy, Folder, MoreHorizontal, Search } from "lucide-react";
import { closeJobTab, copyJobOutput, openJobs, stopJob } from "../lib/actions";
import { hostsApi } from "../lib/daemon";
import { type OutputFilter, chipFromJob, jobTabLine, phaseBar, shownLines, workerFacts } from "../lib/jobs";
import { useSessionJob } from "../lib/jobsStore";
import { errorToast, useStore } from "../lib/store";
import { useNow } from "../lib/useNow";
import { JobDot, LINE_TONE, TONE, WorkerIcon, copyText, going, useFollow, useJobLines } from "./JobsPanel";
import { cx } from "./ui";

const BAR_TONE = { done: "bg-done", accent: "bg-accent", blocked: "bg-blocked" };

const size = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`;

function Side({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="ui-text-11 uppercase tracking-[0.06em] text-faint">{title}</h3>
      {children}
    </section>
  );
}

export default function JobView({ host, wsId, job: id }: { host: string; wsId: string; job: string }) {
  const job = useSessionJob(host, wsId, id);
  const session = useStore((s) => s.sessions[host]?.find((w) => w.id === wsId)?.name) ?? wsId;
  const central = useStore((s) => s.hosts[host]?.label) ?? "this Mac";
  const now = useNow(!!job && going(job));
  const lines = useJobLines(host, id);
  const [filter, setFilter] = useState<OutputFilter>("all");
  const [find, setFind] = useState("");
  const [follow, setFollow] = useState(false);
  const [menu, setMenu] = useState(false);
  const shown = useMemo(() => (lines ? shownLines(lines, filter, find) : []), [lines, filter, find]);
  const box = useFollow(follow, shown.length);
  // The tab closes when the job is dropped from the history.
  useEffect(() => {
    if (job === null) closeJobTab(host, wsId, id);
  }, [job, host, wsId, id]);
  if (!job) return null;
  const state = jobTabLine(job, now, session);
  const chip = chipFromJob(job);
  const stderr = lines?.filter((l) => l.stream === 2).length ?? 0;
  const reveal = (folder: string) => void hostsApi.openIn("reveal", folder).catch(errorToast);
  return (
    <div data-job-view={job.command} className="flex h-full min-h-0 flex-col bg-bg">
      <header className="shrink-0 border-b border-border bg-panel px-7 pb-5 pt-5">
        <div className="flex items-center gap-3">
          <JobDot job={job} />
          <span className="selectable min-w-0 truncate font-mono ui-text-18 text-fg">{job.command}</span>
          <span className={cx("flex shrink-0 items-center gap-1 rounded bg-raised px-1.5 py-0.5 ui-text-12", chip.rerun ? "text-blocked" : "text-muted")}>
            <WorkerIcon icon={chip.icon} />
            {chip.text}
          </span>
          <span className="ml-auto" />
          <button className="flex items-center gap-1.5 rounded px-2 py-1 ui-text-12.5 text-muted hover:bg-hover hover:text-fg" onClick={() => lines && copyJobOutput(copyText(lines))}>
            <Copy size={13} /> Copy output
          </button>
          <div className="relative">
            <button title="More" className="rounded p-1 text-muted hover:bg-hover hover:text-fg" onClick={() => setMenu(!menu)}>
              <MoreHorizontal size={15} />
            </button>
            {menu && (
              <div className="absolute right-0 top-8 z-20 w-48 rounded-md border border-border-strong bg-raised py-1 shadow-lg" onMouseLeave={() => setMenu(false)}>
                <button className="block w-full px-3 py-1.5 text-left ui-text-13 hover:bg-hover" onClick={() => (setMenu(false), openJobs(job.id))}>
                  Show in Jobs
                </button>
                {going(job) && (
                  <button className="block w-full px-3 py-1.5 text-left ui-text-13 text-error hover:bg-hover" onClick={() => (setMenu(false), stopJob(host, job.id))}>
                    Stop
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="mt-2 pl-[19px] ui-text-12.5 text-muted">
          <span className={TONE[state.tone]}>{state.text.split(" · ")[0]}</span>
          {state.text.split(" · ").slice(1).map((p) => ` · ${p}`)}
        </div>
        <div className="mt-4 flex max-w-[880px] gap-1 pl-[19px]">
          {phaseBar(job, now).map((p, i) => (
            <div key={i} className="flex min-w-0 flex-col gap-1.5" style={{ flexGrow: p.percent, flexBasis: 0 }}>
              <span className={cx("h-1 rounded-full", BAR_TONE[p.tone])} />
              <span className="truncate ui-text-12 text-muted">
                {p.label}
                {p.took && ` ${p.took}`}
              </span>
            </div>
          ))}
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-7">
            <div role="radiogroup" aria-label="Streams" className="flex rounded-md border border-border p-0.5 ui-text-12.5">
              {(["all", "stdout", "stderr"] as const).map((f) => (
                <button
                  key={f}
                  role="radio"
                  aria-checked={filter === f}
                  onClick={() => setFilter(f)}
                  className={cx("rounded px-2 py-0.5", filter === f ? "bg-raised text-fg" : "text-muted hover:text-fg")}
                >
                  {f === "all" ? "All" : f}
                  {f === "stderr" && stderr > 0 && <span className="ml-1 text-blocked">{stderr}</span>}
                </button>
              ))}
            </div>
            <label className="flex h-7 w-[220px] items-center gap-2 rounded-md border border-border bg-panel px-2 text-muted">
              <Search size={13} />
              <input aria-label="Find in output" placeholder="Find in output" value={find} onChange={(e) => setFind(e.target.value)} className="min-w-0 flex-1 bg-transparent ui-text-12.5 text-fg outline-none placeholder:text-faint" />
            </label>
            <span className="ml-auto whitespace-nowrap font-mono ui-text-12 tabular-nums text-muted">{lines ? `${lines.length.toLocaleString("en-US")} lines` : ""}</span>
            <label className="flex shrink-0 items-center gap-1.5 ui-text-12.5 text-muted">
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
              Follow
            </label>
          </div>
          <div ref={box} data-job-output className="selectable min-h-0 flex-1 overflow-y-auto px-7 py-3 font-mono ui-text-12.5 leading-[1.6]">
            {shown.map((l) => (
              <div key={l.n} className="flex gap-4">
                <span className="w-10 shrink-0 select-none text-right tabular-nums text-faint">{l.n}</span>
                <span className={cx("min-w-0 flex-1 whitespace-pre-wrap break-all", l.tone ? LINE_TONE[l.tone] : "text-fg")}>{l.text || " "}</span>
              </div>
            ))}
          </div>
        </div>
        <aside className="flex w-[300px] shrink-0 flex-col gap-6 overflow-y-auto border-l border-border px-6 py-5 ui-text-12.5">
          {job.worker && (
            <Side title="Worker">
              <span className="flex items-center gap-2 ui-text-13 text-fg">
                {job.worker.name}
                {job.worker.kind === "central" && <span className="rounded bg-raised px-1.5 ui-text-11.5 text-muted">Central host</span>}
              </span>
              <dl className="grid grid-cols-[96px_1fr] gap-x-2 gap-y-1">
                {workerFacts(job.worker).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted">{k}</dt>
                    <dd className="selectable break-all font-mono text-fg">{v}</dd>
                  </div>
                ))}
              </dl>
            </Side>
          )}
          {(job.brought.length > 0 || job.outputs.length > 0) && (
            <Side title="Brought back">
              {job.brought.map((b) => (
                <div key={b.path} className="flex items-center gap-2 font-mono ui-text-12">
                  <span className="min-w-0 flex-1 truncate" title={b.path}>
                    {b.path}
                  </span>
                  <span className="text-add">+{b.added}</span>
                  <span className="text-del">−{b.removed}</span>
                </div>
              ))}
              {job.outputs.map((o) => (
                <div key={o.path} className="flex items-center gap-2 font-mono ui-text-12">
                  <Folder size={12} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate">{o.path}</span>
                  <span className="text-muted">{size(o.bytes)}</span>
                </div>
              ))}
            </Side>
          )}
          {job.leftovers.length > 0 && (
            <div className="rounded-lg border border-[#5a4a1e] bg-[#1f1a0d] px-3 py-3">
              <p className="text-blocked">
                {job.leftovers.length === 1 ? `${job.leftovers[0]} changed` : `${job.leftovers.length} files changed`} on {central} during the run
              </p>
              <p className="mt-2 text-muted">
                The session kept its own version.{job.leftovers_folder && ` The run's version is in ${job.leftovers_folder}`}
              </p>
              {job.leftovers_folder && (
                <div className="mt-2 flex flex-col gap-1.5">
                  {job.leftovers.map((path) => (
                    <div key={path} className="flex items-center gap-2">
                      {job.leftovers.length > 1 && <span className="min-w-0 flex-1 truncate font-mono ui-text-12 text-muted">{path}</span>}
                      <button
                        className="rounded border border-border-strong bg-raised px-2 py-0.5 text-fg hover:bg-hover"
                        onClick={() => useStore.setState({ dialog: { kind: "job-compare", host, session: wsId, path, folder: job.leftovers_folder! } })}
                      >
                        Compare
                      </button>
                    </div>
                  ))}
                  {/* Finder reaches this Mac's folders only. */}
                  {host === "local" && (
                    <button className="self-start rounded px-2 py-0.5 text-muted hover:bg-hover hover:text-fg" onClick={() => reveal(job.leftovers_folder!)}>
                      Reveal
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {job.env.length > 0 && (
            <Side title="Passed to the worker">
              <div className="flex flex-wrap gap-1.5">
                {job.env.map((e) => (
                  <span key={e} className="rounded bg-raised px-1.5 py-0.5 font-mono ui-text-11.5 text-muted">
                    {e}
                  </span>
                ))}
              </div>
              <span className="text-muted">Names only. Values are never shown here.</span>
            </Side>
          )}
        </aside>
      </div>
    </div>
  );
}
