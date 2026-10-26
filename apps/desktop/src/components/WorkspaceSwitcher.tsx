// The workspace switcher in the sidebar's title bar (X32).

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronsUpDown, Plus, Settings } from "lucide-react";
import { hostWorkspaces, sessionNeedsYou, shownWorkspace, switchWorkspace, useStore } from "../lib/store";
import { goSettings } from "../lib/settingsNavigation";
import { colorHex, isShown, switcherRows, workspaceInitial, workspacesNeedingYou, wsKey } from "../lib/workspaces";
import type { WorkspaceColor } from "../lib/protocol";
import { cx } from "./ui";

/** A workspace's colour square with its initial. */
export function WorkspaceMark({ name, color, size }: { name: string; color: WorkspaceColor; size: number }) {
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center font-bold text-[#121212]"
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.28), background: colorHex(color), fontSize: Math.round(size * 0.6) }}
    >
      {workspaceInitial(name)}
    </span>
  );
}

const AttentionDot = () => <span aria-label="needs you" className="h-1.5 w-1.5 shrink-0 rounded-full bg-blocked" />;

export function WorkspaceSwitcher() {
  const [open, setOpen] = useState(false);
  const hosts = useStore((s) => s.hosts);
  const workspaces = useStore((s) => s.workspaces);
  const sections = useStore((s) => s.sections);
  const sessions = useStore((s) => s.sessions);
  const profiles = useStore((s) => s.profiles);
  const current = useStore((s) => shownWorkspace(s));
  const rows = useMemo(() => switcherRows(hostWorkspaces(useStore.getState())), [hosts, workspaces, sections, sessions, profiles]);
  // Joined into one string, so the selector's value is stable between renders.
  const needingKey = useStore((s) => [...workspacesNeedingYou(hostWorkspaces(s), (h, x) => sessionNeedsYou(s, h, x.id))].sort().join("\n"));
  const needing = useMemo(() => new Set(needingKey ? needingKey.split("\n") : []), [needingKey]);
  const cur = rows.find((r) => isShown(current, r.host, r.ws.id));
  const othersNeedYou = [...needing].some((k) => !current || k !== wsKey(current.host, current.id));

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!cur) return null;
  return (
    <div className="no-drag relative min-w-0">
      <button
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Switch workspace, current: ${cur.ws.name}`}
        onClick={() => setOpen(!open)}
        className={cx("flex h-[30px] min-w-0 max-w-[180px] items-center gap-[7px] rounded-[7px] pl-[5px] pr-[7px] hover:bg-[#222]", open && "bg-[#222]")}
      >
        <WorkspaceMark name={cur.ws.name} color={cur.ws.color} size={18} />
        <span className="truncate ui-text-13 font-semibold text-fg">{cur.ws.name}</span>
        {othersNeedYou && <AttentionDot />}
        <ChevronsUpDown size={12} className="shrink-0 text-muted" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onMouseDown={() => setOpen(false)} />
          <div role="menu" aria-label="Workspaces" className="absolute left-0 top-[34px] z-50 flex w-64 flex-col gap-0.5 rounded-xl border border-border-strong bg-[#1a1a1a] p-1.5 shadow-2xl">
            <div className="px-2 pb-1 pt-1.5 ui-text-11.5 text-faint">Workspaces</div>
            {rows.map((r) => {
              const isCur = r === cur;
              return (
                <div key={wsKey(r.host, r.ws.id)}>
                  {r.hostLabel && <div className="px-2 pb-0.5 pt-1.5 ui-text-11 uppercase tracking-[0.08em] text-faint">{r.hostLabel}</div>}
                  <button
                    role="menuitemradio"
                    aria-checked={isCur}
                    onClick={() => {
                      setOpen(false);
                      switchWorkspace({ host: r.host, id: r.ws.id });
                    }}
                    className={cx("flex w-full items-center gap-2.5 rounded-lg px-2 py-[7px] text-left hover:bg-[#222]", isCur && "bg-[#222]")}
                  >
                    <WorkspaceMark name={r.ws.name} color={r.ws.color} size={26} />
                    <span className="flex min-w-0 flex-1 flex-col gap-px">
                      <span className="flex items-center gap-1.5 ui-text-13 font-semibold text-fg">
                        {r.ws.name}
                        {needing.has(wsKey(r.host, r.ws.id)) && !isCur && <AttentionDot />}
                      </span>
                      <span className="truncate ui-text-11.5 text-muted">{r.summary}</span>
                    </span>
                    {isCur && <Check size={14} strokeWidth={2.5} className="text-accent" />}
                    {r.kbd && <span className="font-mono ui-text-10.5 text-faint">{r.kbd}</span>}
                  </button>
                </div>
              );
            })}
            <div className="mx-0.5 my-1 h-px bg-border" />
            <button
              role="menuitem"
              className="flex h-8 items-center gap-2.5 rounded-lg px-2 text-left ui-text-13 hover:bg-[#222]"
              onClick={() => {
                setOpen(false);
                useStore.setState({ dialog: { kind: "new-workspace" } });
              }}
            >
              <Plus size={14} className="text-muted" /> New workspace…
            </button>
            <button
              role="menuitem"
              className="flex h-8 items-center gap-2.5 rounded-lg px-2 text-left ui-text-13 hover:bg-[#222]"
              onClick={() => {
                setOpen(false);
                void goSettings({ page: "workspace", host: cur.host, id: cur.ws.id });
              }}
            >
              <Settings size={14} className="text-muted" /> Workspace settings…
            </button>
            <div className="flex justify-between px-2 pb-1 pt-1.5 ui-text-11 text-faint">
              <span>Switch</span>
              <span className="font-mono">⌃⌘1–9</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
