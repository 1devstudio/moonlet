// The Processes tab (X83): what the session's terminals and agents run, and
// what was left working in its worktree, by name, with Stop.

import { useCallback, useEffect, useRef, useState } from "react";
import { Activity } from "lucide-react";
import { rpc } from "../lib/daemon";
import { M, type Session, type SessionProcess, type SessionProcesses } from "../lib/protocol";
import { type CpuLook, cpuPercent, killParams, processRow, processesSummary, stoppedByStopAll } from "../lib/sessionProcesses";
import { errorToast } from "../lib/store";
import { Empty, cx } from "./ui";

/** How often the tab looks again while shown. */
const LOOK_MS = 3000;

export function ProcessesPanel({ host, ws }: { host: string; ws: Session }) {
  const [list, setList] = useState<SessionProcesses | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cpu, setCpu] = useState<Record<number, number | null>>({});
  const [stopping, setStopping] = useState<number[]>([]);
  const looks = useRef(new Map<number, CpuLook>());

  const load = useCallback(async () => {
    try {
      const got = await rpc<SessionProcesses>(host, M.sessionProcesses, { id: ws.id });
      const at = Date.now();
      const next = new Map<number, CpuLook>();
      const use: Record<number, number | null> = {};
      for (const p of [...got.processes, ...got.leftovers]) {
        if (p.cpu_ms === undefined) continue;
        const look = { cpu_ms: p.cpu_ms, at };
        use[p.pid] = cpuPercent(looks.current.get(p.pid), look);
        next.set(p.pid, look);
      }
      looks.current = next;
      setCpu(use);
      setList(got);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [host, ws.id]);

  useEffect(() => {
    looks.current = new Map();
    setList(null);
    void load();
    const t = setInterval(() => void load(), LOOK_MS);
    return () => clearInterval(t);
  }, [load]);

  const stop = async (ps?: SessionProcess[]) => {
    const shown = (ps ?? (list ? stoppedByStopAll(list) : [])).map((p) => p.pid);
    setStopping((s) => [...s, ...shown]);
    try {
      await rpc(host, M.sessionKillProcesses, killParams(ws.id, ps));
    } catch (e) {
      errorToast(e);
    }
    setStopping((s) => s.filter((pid) => !shown.includes(pid)));
    await load();
  };

  if (error && !list) {
    return (
      <Empty icon={<Activity size={20} />} title="Can't list processes">
        {error}
      </Empty>
    );
  }
  if (!list) return null;
  if (!list.processes.length && !list.leftovers.length) {
    return (
      <Empty icon={<Activity size={20} />} title="Nothing runs in this session">
        Processes its terminals and agents start show here.
      </Empty>
    );
  }
  const stoppable = stoppedByStopAll(list).length > 0;
  const row = (p: SessionProcess) => {
    const r = processRow(p, Date.now(), cpu[p.pid] ?? null);
    const busy = stopping.includes(p.pid);
    return (
      <div key={p.pid} data-process={r.name} className="flex items-center gap-3 border-b border-border px-4 py-2">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-baseline gap-2">
            <span className="truncate font-mono ui-text-13 text-fg">{r.name}</span>
            <span className="font-mono ui-text-12 tabular-nums text-faint">{r.pid}</span>
          </span>
          <span className="truncate ui-text-12 text-muted">{r.origin}</span>
        </span>
        <span className="w-10 text-right font-mono ui-text-12 tabular-nums text-muted" title="Running for">
          {r.age}
        </span>
        <span className="w-10 text-right font-mono ui-text-12 tabular-nums text-muted" title="CPU">
          {r.cpu}
        </span>
        <span className="w-16 text-right font-mono ui-text-12 tabular-nums text-muted" title="Memory">
          {r.memory}
        </span>
        {r.stop ? (
          <button
            className={cx("w-11 rounded px-1.5 py-0.5 text-right ui-text-12 text-muted hover:bg-hover hover:text-error", busy && "pointer-events-none text-faint")}
            onClick={() => void stop([p])}
          >
            {busy ? "…" : "Stop"}
          </button>
        ) : (
          <span className="w-11 px-1.5 text-right ui-text-12 text-faint" title="Closing its tab ends it">
            tab
          </span>
        )}
      </div>
    );
  };
  return (
    <div className="flex flex-col">
      <div className="flex h-10 shrink-0 items-center border-b border-border px-4 ui-text-12 text-muted">
        <span className="tabular-nums">{processesSummary(list)}</span>
        {stoppable && (
          <button className="ml-auto hover:text-fg" onClick={() => void stop()}>
            Stop all
          </button>
        )}
      </div>
      {list.processes.map(row)}
      {list.leftovers.length > 0 && (
        <>
          <div className="px-4 pb-1 pt-4 ui-text-12 font-medium text-fg">Left in the worktree</div>
          <p className="m-0 px-4 pb-2 ui-text-12 text-faint">Nothing in moonlet owns these any more; they work in this session's folder.</p>
          {list.leftovers.map(row)}
        </>
      )}
      <p className="px-4 py-4 ui-text-12 text-faint">By name only, never with their arguments. Stop sends SIGTERM, then SIGKILL after 3 s.</p>
    </div>
  );
}
