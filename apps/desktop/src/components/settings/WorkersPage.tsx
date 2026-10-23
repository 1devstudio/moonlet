// Settings › Machines › Workers (X62): the machines that run the central
// host's heavy commands, their load and slots, what they run now, and why
// one was skipped. Read from the central host, every two seconds while open.

import { useEffect, useState } from "react";
import { Check, Cloud, Cpu, Laptop, LoaderCircle, RotateCw, Server } from "lucide-react";
import { askConfirm } from "../../lib/confirm";
import { onDaemonEvent, rpc } from "../../lib/daemon";
import { workerApproval } from "../../lib/heavyCommands";
import { EV, M, type ExecStatus, type HeavyInfo, type LinkInfo, type Project, type WorkerInfo } from "../../lib/protocol";
import { goSettings } from "../../lib/settingsNavigation";
import { errorToast, toast, useStore } from "../../lib/store";
import { centralHostId } from "../../lib/workerLink";
import { workerHost, workersPage, type CloudRow, type WorkerRow } from "../../lib/workers";
import { cloudSummary } from "../../lib/cloudMachines";
import { retryRemoval, useCloud } from "../../lib/cloudStore";
import { readLinks } from "../../lib/heavyApproval";
import { Button, cx } from "../ui";
import { Card, PageHeading, Section } from "./controls";

const elapsed = (since: number, now: number) => {
  const s = Math.max(0, Math.round((now - since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function Badge({ children }: { children: string }) {
  return <span className="inline-flex h-[18px] items-center rounded bg-raised px-1.5 ui-text-11.5 font-normal text-muted">{children}</span>;
}

function LoadBar({ load }: { load: WorkerRow["load"] }) {
  if (!load) return <span className="ui-text-12 text-faint">–</span>;
  return (
    <span className="flex w-[120px] flex-col gap-1">
      <span className={cx("font-mono ui-text-12", load.busy ? "text-blocked" : "text-muted")}>{load.text}</span>
      <span className="h-1 overflow-hidden rounded-full bg-raised">
        <span className={cx("block h-full rounded-full", load.busy ? "bg-blocked" : "bg-muted")} style={{ width: `${Math.round(load.fraction * 100)}%` }} />
      </span>
    </span>
  );
}

function WorkerLine({ row, now, onApprove }: { row: WorkerRow; now: number; onApprove: (project: string) => void }) {
  const central = row.badges.includes("Central host");
  return (
    <div data-setting={`worker-${row.id}`} className="flex flex-col gap-2 px-4 py-3.5">
      <div className="flex items-center gap-3.5">
        <span aria-hidden="true" className={cx("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised", central ? "text-done" : "text-muted")}>
          {row.badges.includes("This Mac") ? <Laptop size={16} /> : <Server size={16} />}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-center gap-2 ui-text-13 font-medium">
            {row.name}
            {row.badges.map((b) => (
              <Badge key={b}>{b}</Badge>
            ))}
          </span>
          <span className={cx("flex items-center gap-1.5 ui-text-12", row.line.tone === "blocked" ? "text-blocked" : "text-muted")}>
            {row.line.tone === "blocked" && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-blocked" />}
            {row.line.text}
          </span>
        </div>
        {row.approve && (
          <Button size="sm" onClick={() => onApprove(row.approve!.project)}>
            Approve
          </Button>
        )}
        <LoadBar load={row.load} />
        <span className="w-[64px] font-mono ui-text-12 text-muted">{row.slots}</span>
        <span className="w-[52px] text-right font-mono ui-text-12 text-muted">{row.rtt}</span>
      </div>
      {row.running.map((r, i) => (
        <div key={i} className="ml-[46px] flex items-center gap-2 rounded-md bg-panel-2 px-3 py-1.5 ui-text-12">
          <LoaderCircle size={12} className="animate-spin text-muted" />
          <span className="text-muted">{r.session}</span>
          <span className="min-w-0 flex-1 truncate font-mono">{r.command}</span>
          <span className="font-mono text-muted">{elapsed(r.since, now)}</span>
        </div>
      ))}
    </div>
  );
}

const CLOUD_TONE = { done: "text-done", accent: "text-accent", muted: "text-muted", error: "text-error" } as const;
const CLOUD_DOT = { done: "bg-done", accent: "bg-accent", muted: "bg-idle", error: "bg-error" } as const;

function CloudLine({ row, now, host }: { row: CloudRow; now: number; host: string }) {
  const remove = () => void rpc(host, M.cloudDown, { machine: row.id }).catch(errorToast);
  return (
    <div data-setting={`cloud-machine-${row.name}`} className={cx("flex flex-col gap-2 px-4 py-3.5", row.line.tone === "error" && "bg-[#1c1213]")}>
      <div className="flex items-center gap-3.5">
        <span aria-hidden="true" className={cx("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised", CLOUD_TONE[row.line.tone])}>
          <Cloud size={16} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="font-mono ui-text-13 font-medium">{row.name}</span>
          <span className={cx("flex items-center gap-1.5 ui-text-12", row.line.tone === "error" ? "text-error" : "text-muted")}>
            <span aria-hidden="true" className={cx("h-1.5 w-1.5 shrink-0 rounded-full", CLOUD_DOT[row.line.tone])} />
            {row.line.text}
          </span>
        </div>
        {row.line.action === "remove" && (
          <Button size="sm" variant="ghost" onClick={remove}>
            Remove now
          </Button>
        )}
        {row.line.action === "retry" ? (
          <Button size="sm" onClick={() => retryRemoval(host, row.id)}>
            <RotateCw size={12} /> Retry
          </Button>
        ) : (
          <>
            <LoadBar load={row.load} />
            <span className="w-[64px] font-mono ui-text-12 text-muted">{row.slots}</span>
            <span className="w-[52px] text-right font-mono ui-text-12 text-muted">{row.rtt}</span>
          </>
        )}
      </div>
      {row.running.map((r, i) => (
        <div key={i} className="ml-[46px] flex items-center gap-2 rounded-md bg-panel-2 px-3 py-1.5 ui-text-12">
          <LoaderCircle size={12} className="animate-spin text-muted" />
          <span className="text-muted">{r.session}</span>
          <span className="min-w-0 flex-1 truncate font-mono">{r.command}</span>
          <span className="font-mono text-muted">{elapsed(r.since, now)}</span>
        </div>
      ))}
    </div>
  );
}

export function WorkersPage() {
  const hosts = useStore((s) => s.hosts);
  const [link, setLink] = useState<LinkInfo | null>(null);
  useEffect(() => void rpc<LinkInfo>("local", M.linkGet).then(setLink, () => setLink(null)), []);
  // The central host's workers: this Mac's central host's, or this Mac's own.
  const target = centralHostId(Object.values(hosts), link) ?? "local";
  const name = target === "local" ? (link?.worker.name ?? "this Mac") : (hosts[target]?.label ?? target);
  const sessions = useStore((s) => s.sessions[target]);
  const projects = useStore((s) => s.projects[target]);
  const [data, setData] = useState<{ workers: WorkerInfo[]; status: ExecStatus } | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let live = true;
    const read = () =>
      void Promise.all([rpc<WorkerInfo[]>(target, M.workerList), rpc<ExecStatus>(target, M.execStatus)]).then(
        ([workers, status]) => live && setData({ workers, status }),
        () => live && setData(null),
      );
    read();
    const timer = setInterval(() => {
      setNow(Date.now());
      read();
    }, 2000);
    const off = onDaemonEvent((e) => {
      if (e.host === target && (e.name === EV.workersChanged || e.name === EV.jobChanged)) read();
    });
    return () => {
      live = false;
      clearInterval(timer);
      void off.then((f) => f());
    };
  }, [target]);
  const names = Object.fromEntries((sessions ?? []).map((s) => [s.id, s.name]));
  // The cloud machines of this central host (X63).
  const cloud = useCloud((s) => (s.host === target ? s.machines : null));
  const page =
    data &&
    workersPage({
      workers: data.workers,
      status: data.status,
      me: link?.worker.id ?? null,
      sessions: names,
      cloud: cloud?.machines ?? [],
      removed: cloud?.removed ?? [],
      now,
      cloudSessions: Object.fromEntries((sessions ?? []).map((s) => [s.id, { name: s.name, cloud: s.cloud }])),
    });
  const approve = async (projectName: string, row: WorkerRow) => {
    const project = (projects ?? []).find((p: Project) => p.name === projectName);
    if (!project) return void toast(`${projectName} is not a project of ${name}`, "error");
    // The host whose own link is this worker, among those the app reaches.
    const worker = workerHost(row.id, await readLinks(Object.values(hosts)));
    if (!worker) return void toast(`Approve ${projectName}'s heavy commands from moonlet on ${row.name}.`, "error");
    try {
      const info = await rpc<HeavyInfo>(target, M.heavyGet, { project: project.id });
      // The exact lists, seen before they are approved.
      if (!(await askConfirm(workerApproval(projectName, row.name, info)))) return;
      await rpc(worker, M.heavyApprove, { identity: project.identity, commands: info.config.commands, env: info.config.env });
      toast(`Approved ${projectName}'s heavy commands on ${row.name}`);
    } catch (e) {
      errorToast(e);
    }
  };
  const heading = (
    <PageHeading
      title={
        <span className="flex items-center gap-2.5">
          Workers
          <Badge>{`${name} · Central host`}</Badge>
        </span>
      }
    >
      Machines that run heavy commands for {name}'s sessions. A command goes to the free worker with the lowest load, and runs on {name} when none is free.
    </PageHeading>
  );
  if (page?.empty)
    return (
      <>
        {heading}
        <div data-setting="workers-empty" className="flex flex-col items-center gap-3 rounded-[10px] border border-dashed border-border px-8 py-12 text-center">
          <span aria-hidden="true" className="flex h-11 w-11 items-center justify-center rounded-xl bg-raised text-muted">
            <Cpu size={20} />
          </span>
          <span className="ui-text-14 font-medium">Only {name} runs heavy commands</span>
          <span className="max-w-[440px] ui-text-12.5 text-muted">No machine runs heavy commands for {name} yet. Turn on Use this Mac for heavy commands, or Use for heavy commands on a remote host.</span>
          <Button variant="primary" onClick={() => void goSettings({ page: "hosts" })}>
            <Server size={13} /> Open Hosts
          </Button>
        </div>
      </>
    );
  return (
    <>
      {heading}
      {page && <span className="-mt-4 ui-text-12.5 text-muted">{page.summary}</span>}
      <Section title="Macs and hosts">
        <Card>
          <div className="flex items-center gap-3.5 px-4 py-2 ui-text-11 uppercase tracking-[0.06em] text-faint">
            <span className="flex-1">Worker</span>
            <span className="w-[120px]">Load</span>
            <span className="w-[64px]">Slots</span>
            <span className="w-[52px] text-right">Round trip</span>
          </div>
          {page?.rows.map((r) => (
            <WorkerLine key={r.id} row={r} now={now} onApprove={(p) => void approve(p, r)} />
          ))}
          {!page && <div className="px-4 py-3.5 ui-text-12.5 text-muted">Could not reach {name}.</div>}
        </Card>
      </Section>
      {cloud && page && (page.cloud.length > 0 || page.removed.length > 0) && (
        <Section
          title="Cloud machines"
          hint={
            <>
              {cloudSummary(cloud)} ·{" "}
              <button type="button" className="text-accent hover:underline" onClick={() => void goSettings({ page: "cloud" })}>
                Cloud workers settings
              </button>
            </>
          }
        >
          <Card>
            {page.cloud.map((r) => (
              <CloudLine key={r.id} row={r} now={now} host={target} />
            ))}
            {page.removed.map((line) => (
              <div key={line} className="flex items-center gap-2 px-4 py-2.5 font-mono ui-text-12 text-faint">
                <Check size={12} />
                {line}
              </div>
            ))}
          </Card>
        </Section>
      )}
    </>
  );
}
