import { useEffect, useState } from "react";
import { Archive, ChevronDown, Columns2, ExternalLink, GitBranch, GitPullRequest, PanelLeft, PanelRight, Play, Plus, Rows2, Send, SquareTerminal, X } from "lucide-react";
import { hostsApi, rpc } from "../lib/daemon";
import { leaves } from "../lib/layout";
import { M, type RepoConfig, type SessionInfo } from "../lib/protocol";
import { errorToast, getLayout, repoOf, sessKey, setLayout, useStore, wsKey } from "../lib/store";
import { archiveWorkspace, newTab, runScript, sendToAgent, split } from "../lib/actions";
import { PaneTree } from "./PaneTree";
import { Button, DiffStat, IconButton, Kbd, StateGlyph, cx } from "./ui";
import type { Workspace } from "../lib/protocol";

function OpenInMenu({ host, path }: { host: string; path: string }) {
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    if (open && !targets.length) void hostsApi.openTargets().then(setTargets);
  }, [open, targets.length]);
  const remote = host !== "local";
  const usable = targets.filter((t) => !remote || t.id === "vscode" || t.id === "cursor");
  return (
    <div className="relative">
      <Button size="sm" onClick={() => setOpen(!open)}>
        <ExternalLink size={12} /> Open in <ChevronDown size={11} />
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-40 mt-1 w-44 overflow-hidden rounded-lg border border-border-strong bg-panel-2 py-1 shadow-xl">
            {usable.map((t) => (
              <button
                key={t.id}
                className="block w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-hover"
                onClick={() => {
                  setOpen(false);
                  void hostsApi.openIn(t.id, path, host).catch(errorToast);
                }}
              >
                {t.label}
              </button>
            ))}
            {usable.length === 0 && <div className="px-3 py-1.5 text-[12px] text-faint">No editors found</div>}
          </div>
        </>
      )}
    </div>
  );
}

function Header({ host, ws }: { host: string; ws: Workspace }) {
  const git = useStore((s) => s.git[wsKey(host, ws.id)]);
  const repo = useStore((s) => repoOf(s, host, ws));
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const rightOpen = useStore((s) => s.rightOpen);
  const [config, setConfig] = useState<RepoConfig | null>(null);
  useEffect(() => {
    if (repo) void rpc<RepoConfig>(host, M.repoConfig, { id: repo.id }).then(setConfig).catch(() => setConfig(null));
  }, [host, repo]);
  return (
    <div className="drag flex h-[46px] shrink-0 items-center gap-2 border-b border-border bg-panel pl-3 pr-2" style={{ paddingLeft: sidebarOpen ? 12 : 84 }}>
      <IconButton title="Toggle sidebar (⌘B)" onClick={() => useStore.setState({ sidebarOpen: !sidebarOpen })}>
        <PanelLeft size={14} />
      </IconButton>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-semibold">{ws.name}</span>
          {host !== "local" && <span className="rounded bg-raised px-1.5 text-[10.5px] text-muted">{host}</span>}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-faint">
          <GitBranch size={11} />
          <span className="selectable truncate font-mono">{ws.branch}</span>
          <span>→</span>
          <span className="font-mono">{ws.base}</span>
          {git && (git.ahead > 0 || git.behind > 0) && (
            <span className="font-mono">
              ↑{git.ahead} ↓{git.behind}
            </span>
          )}
          {git && <DiffStat add={git.additions} del={git.deletions} />}
        </div>
      </div>
      <div className="no-drag ml-auto flex items-center gap-1.5">
        <OpenInMenu host={host} path={ws.path} />
        <Button size="sm" disabled={!config?.run} title={config?.run ? `Run: ${config.run}` : "Add `run = \"…\"` to .jaunt/config.toml"} onClick={() => void runScript("run")}>
          <Play size={12} className="text-done" /> Run
        </Button>
        <Button size="sm" onClick={() => useStore.setState({ dialog: { kind: "create-pr" } })} title="Create pull request (⇧⌘P)">
          <GitPullRequest size={12} /> Create PR
        </Button>
        <IconButton title="Archive workspace" onClick={() => void archiveWorkspace()}>
          <Archive size={14} />
        </IconButton>
        <IconButton title="Toggle review panel (⌘\)" onClick={() => useStore.setState({ rightOpen: !rightOpen })}>
          <PanelRight size={14} />
        </IconButton>
      </div>
    </div>
  );
}

function TabTitle({ host, info, unread }: { host: string; info?: SessionInfo; unread: boolean }) {
  if (!info) return <span className="text-faint">…</span>;
  const icon = info.kind === "agent" ? <StateGlyph state={info.exit ? null : info.agent_state} size={12} /> : <SquareTerminal size={12} className="text-faint" />;
  void host;
  return (
    <>
      {icon}
      <span className={cx("max-w-[160px] truncate", unread && "font-semibold text-fg")}>{info.agent ?? info.title}</span>
      {info.exit && <span className="text-[10.5px] text-faint">exited</span>}
    </>
  );
}

function TabBar({ host, ws }: { host: string; ws: Workspace }) {
  const layout = useStore((s) => s.layouts[wsKey(host, ws.id)]);
  const sessions = useStore((s) => s.sessions[host]);
  const unread = useStore((s) => s.unread);
  if (!layout) return null;
  return (
    <div className="flex h-8 shrink-0 items-stretch border-b border-border bg-panel text-[12px]">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {layout.tabs.map((t) => {
          const ids = leaves(t.root);
          const main = sessions?.[ids[0]];
          const active = t.id === layout.active;
          const isUnread = ids.some((id) => unread[sessKey(host, id)]);
          return (
            <div
              key={t.id}
              className={cx(
                "group flex shrink-0 cursor-default items-center gap-1.5 border-r border-border px-3",
                active ? "bg-[#0e0f12] text-fg" : "text-muted hover:bg-panel-2",
              )}
              onMouseDown={() => setLayout(host, ws.id, { ...getLayout(host, ws.id), active: t.id, focused: ids[0] })}
            >
              <TabTitle host={host} info={main} unread={isUnread} />
              {ids.length > 1 && <span className="text-[10.5px] text-faint">+{ids.length - 1}</span>}
              <button
                className="ml-0.5 rounded p-0.5 text-faint opacity-0 hover:bg-hover hover:text-fg group-hover:opacity-100"
                title="Close tab"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => {
                  for (const id of ids) void rpc(host, M.sessionKill, { id, remove: true });
                }}
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
        <IconButton title="New terminal (⌘T)" className="m-1" onClick={() => void newTab()}>
          <Plus size={13} />
        </IconButton>
      </div>
      <div className="flex items-center gap-0.5 px-1">
        <IconButton title="Split right (⌘D)" onClick={() => void split("row")}>
          <Columns2 size={13} />
        </IconButton>
        <IconButton title="Split down (⌥⌘D)" onClick={() => void split("col")}>
          <Rows2 size={13} />
        </IconButton>
      </div>
    </div>
  );
}

function TaskBox({ host, ws }: { host: string; ws: Workspace }) {
  const [text, setText] = useState("");
  const agent = useStore((s) => Object.values(s.sessions[host] ?? {}).find((x) => x.workspace_id === ws.id && x.kind === "agent" && !x.exit));
  const submit = async () => {
    if (!text.trim()) return;
    if (await sendToAgent(text.trim())) setText("");
  };
  if (!agent) return null;
  return (
    <div className="shrink-0 border-t border-border bg-panel px-3 py-2">
      <div className="flex items-end gap-2 rounded-lg border border-border-strong bg-panel-2 px-2.5 py-1.5 focus-within:border-accent">
        <textarea
          rows={1}
          value={text}
          placeholder={`Type a task for ${agent.agent ?? "the agent"}…  (Enter to send, ⇧Enter for a new line)`}
          className="max-h-32 min-h-[22px] flex-1 resize-none bg-transparent text-[13px] leading-[22px] outline-none placeholder:text-faint"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <IconButton title="Send to agent" onClick={() => void submit()} disabled={!text.trim()}>
          <Send size={13} />
        </IconButton>
      </div>
    </div>
  );
}

export function WorkspaceView({ host, ws }: { host: string; ws: Workspace }) {
  const layout = useStore((s) => s.layouts[wsKey(host, ws.id)]);
  const hostInfo = useStore((s) => s.hosts[host]);
  return (
    <div className="flex h-full min-w-0 flex-col">
      <Header host={host} ws={ws} />
      {hostInfo && hostInfo.status !== "connected" && (
        <div className="shrink-0 border-b border-[#4a3b17] bg-[#2a2210] px-3 py-1 text-[12px] text-blocked">
          {hostInfo.status === "reconnecting" || hostInfo.status === "connecting"
            ? `Reconnecting to ${hostInfo.label}… agents keep running.`
            : `${hostInfo.label}: ${hostInfo.message ?? hostInfo.status}`}
        </div>
      )}
      <TabBar host={host} ws={ws} />
      <div className="relative min-h-0 flex-1 bg-[#0e0f12]">
        {layout?.tabs.map((t) => (
          <div key={t.id} className="absolute inset-0" style={{ visibility: t.id === layout.active ? "visible" : "hidden" }}>
            <PaneTree host={host} wsId={ws.id} tabId={t.id} node={t.root} path={[]} focused={layout.focused} visible={t.id === layout.active} />
          </div>
        ))}
        {(!layout || layout.tabs.length === 0) && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted">
            <SquareTerminal size={22} className="text-faint" />
            <div className="text-[13px]">No terminals in this workspace.</div>
            <Button onClick={() => void newTab()}>
              <Plus size={13} /> New terminal <Kbd>⌘T</Kbd>
            </Button>
          </div>
        )}
      </div>
      <TaskBox host={host} ws={ws} />
    </div>
  );
}
