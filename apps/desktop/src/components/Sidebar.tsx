import { useMemo } from "react";
import { Archive, ChevronDown, ChevronRight, FolderPlus, History, Monitor, Plus, RotateCcw, Server, Settings } from "lucide-react";
import { hostsApi, rpc } from "../lib/daemon";
import { M, type AgentState, type HostInfo, type Repo, type Workspace } from "../lib/protocol";
import { errorToast, selectWorkspace, sessKey, toast, useStore, workspaceSessions, workspaceState, wsKey } from "../lib/store";
import { DiffStat, IconButton, Kbd, StateGlyph, cx } from "./ui";

function HostStatusDot({ host }: { host: HostInfo }) {
  const color =
    host.status === "connected" ? "bg-done" : host.status === "error" || host.status === "needs_install" ? "bg-error" : "bg-blocked pulse";
  return <span className={cx("inline-block h-1.5 w-1.5 rounded-full", color)} title={host.message ?? host.status} />;
}

function WorkspaceRow({ host, ws, index }: { host: string; ws: Workspace; index: number }) {
  const selected = useStore((s) => s.selected?.host === host && s.selected.workspace === ws.id);
  const state = useStore((s) => workspaceState(s, host, ws.id));
  const git = useStore((s) => s.git[wsKey(host, ws.id)]);
  const unread = useStore((s) => workspaceSessions(s, host, ws.id).some((x) => s.unread[sessKey(host, x.id)]));
  return (
    <button
      onClick={() => selectWorkspace(host, ws.id)}
      className={cx(
        "group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
        selected ? "bg-raised" : "hover:bg-panel-2",
      )}
    >
      <span className="mt-[3px] flex w-3.5 justify-center">
        <StateGlyph state={state} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className={cx("truncate text-[13px]", selected || unread ? "text-fg" : "text-[#c5c9d1]", unread && "font-semibold")}>{ws.name}</span>
          {unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
        </span>
        <span className="flex items-center gap-2 text-[11px] text-faint">
          <span className="truncate font-mono">{ws.branch}</span>
          {git && <DiffStat add={git.additions} del={git.deletions} className="ml-auto shrink-0" />}
        </span>
      </span>
      {index < 9 && <span className="mt-0.5 hidden text-[10px] text-faint group-hover:inline">⌘{index + 1}</span>}
    </button>
  );
}

function RepoGroup({ host, repo, list, offset }: { host: string; repo: Repo; list: Workspace[]; offset: number }) {
  const key = `${host}/${repo.id}`;
  const collapsed = useStore((s) => !!s.collapsed[key]);
  const toggle = () => useStore.setState((s) => ({ collapsed: { ...s.collapsed, [key]: !collapsed } }));
  return (
    <div className="mb-1">
      <div className="group flex items-center gap-1 px-2 py-1">
        <button onClick={toggle} className="flex min-w-0 flex-1 items-center gap-1 text-[11.5px] font-semibold tracking-wide text-muted hover:text-fg">
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <span className="truncate">{repo.name}</span>
          <span className="font-normal text-faint">{list.length || ""}</span>
        </button>
        <IconButton
          title="New workspace in this repo"
          className="opacity-0 group-hover:opacity-100"
          onClick={() => useStore.setState({ dialog: { kind: "new-workspace", host, repo: repo.id } })}
        >
          <Plus size={13} />
        </IconButton>
      </div>
      {!collapsed && (
        <div className="px-1">
          {list.map((w, i) => (
            <WorkspaceRow key={w.id} host={host} ws={w} index={offset + i} />
          ))}
          {list.length === 0 && (
            <button
              className="w-full rounded-md px-2 py-1 text-left text-[12px] text-faint hover:bg-panel-2 hover:text-muted"
              onClick={() => useStore.setState({ dialog: { kind: "new-workspace", host, repo: repo.id } })}
            >
              + New workspace
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function HostSection({ host, offset }: { host: HostInfo; offset: number }) {
  const repos = useStore((s) => s.repos[host.id] ?? []);
  const workspaces = useStore((s) => s.workspaces[host.id] ?? []);
  const multiHost = useStore((s) => Object.keys(s.hosts).length > 1);
  const active = workspaces.filter((w) => !w.archived);
  let running = offset;
  return (
    <div className="mb-2">
      {multiHost && (
        <div className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-faint">
          {host.remote ? <Server size={11} /> : <Monitor size={11} />}
          <span className="truncate">{host.label}</span>
          <HostStatusDot host={host} />
          {host.status === "reconnecting" && <span className="font-normal normal-case tracking-normal">reconnecting…</span>}
          {host.status === "needs_install" && (
            <button
              className="ml-auto font-normal normal-case tracking-normal text-accent hover:underline"
              onClick={() => useStore.setState({ dialog: { kind: "settings" } })}
            >
              set up
            </button>
          )}
          {host.status === "error" && (
            <button className="ml-auto font-normal normal-case tracking-normal text-accent hover:underline" onClick={() => void hostsApi.reconnect(host.id)}>
              retry
            </button>
          )}
        </div>
      )}
      {repos.map((r) => {
        const list = active.filter((w) => w.repo_id === r.id).sort((a, b) => a.created_at - b.created_at);
        const node = <RepoGroup key={r.id} host={host.id} repo={r} list={list} offset={running} />;
        running += list.length;
        return node;
      })}
    </div>
  );
}

function HistoryList() {
  const hosts = useStore((s) => s.hosts);
  const workspaces = useStore((s) => s.workspaces);
  const archived = Object.keys(hosts).flatMap((h) => (workspaces[h] ?? []).filter((w) => w.archived).map((w) => ({ host: h, w })));
  archived.sort((a, b) => b.w.created_at - a.w.created_at);
  return (
    <div className="px-1">
      <div className="px-2 pb-1 pt-2 text-[11.5px] font-semibold text-muted">Archived workspaces</div>
      {archived.length === 0 && <div className="px-2 py-1 text-[12px] text-faint">Nothing archived yet.</div>}
      {archived.map(({ host, w }) => (
        <div key={host + w.id} className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-panel-2">
          <Archive size={12} className="text-faint" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] text-[#c5c9d1]">{w.name}</span>
            <span className="block truncate font-mono text-[11px] text-faint">{w.branch}</span>
          </span>
          <IconButton
            title="Restore workspace"
            className="opacity-0 group-hover:opacity-100"
            onClick={async () => {
              try {
                await rpc(host, M.wsUnarchive, { id: w.id });
                useStore.setState({ showHistory: false });
                selectWorkspace(host, w.id);
                toast(`Restored ${w.name}`);
              } catch (e) {
                errorToast(e);
              }
            }}
          >
            <RotateCcw size={12} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}

export function Sidebar() {
  const hosts = useStore((s) => s.hosts);
  const showHistory = useStore((s) => s.showHistory);
  const sessions = useStore((s) => s.sessions);
  const ordered = useMemo(() => Object.values(hosts).sort((a, b) => Number(a.remote) - Number(b.remote) || a.id.localeCompare(b.id)), [hosts]);
  const counts = useMemo(() => {
    const c: Record<AgentState, number> = { working: 0, blocked: 0, done: 0, error: 0, idle: 0 };
    for (const hs of Object.values(sessions)) for (const x of Object.values(hs)) if (x.kind === "agent" && !x.exit) c[x.agent_state]++;
    return c;
  }, [sessions]);
  const noRepos = useStore((s) => Object.values(s.repos).every((r) => r.length === 0));

  let offset = 0;
  return (
    <aside className="flex h-full flex-col border-r border-border bg-panel">
      <div className="drag h-[46px] shrink-0" />
      <div className="flex items-center gap-1 px-2 pb-2">
        <button
          className="no-drag flex h-7 flex-1 items-center gap-2 rounded-md border border-border-strong bg-raised px-2 text-[12.5px] text-fg hover:bg-hover"
          onClick={() => useStore.setState({ dialog: { kind: "new-workspace" } })}
        >
          <Plus size={14} className="text-accent" />
          New workspace
          <span className="ml-auto">
            <Kbd>⇧⌘N</Kbd>
          </span>
        </button>
        <IconButton title="Add repository" onClick={() => useStore.setState({ dialog: { kind: "add-repo" } })}>
          <FolderPlus size={14} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {showHistory ? (
          <HistoryList />
        ) : noRepos ? (
          <div className="px-4 py-6 text-[12px] text-faint">
            Add a repository to start running agents in their own worktrees.
            <button className="mt-2 block text-accent hover:underline" onClick={() => useStore.setState({ dialog: { kind: "add-repo" } })}>
              Add repository…
            </button>
          </div>
        ) : (
          ordered.map((h) => {
            const node = <HostSection key={h.id} host={h} offset={offset} />;
            offset += (useStore.getState().workspaces[h.id] ?? []).filter((w) => !w.archived).length;
            return node;
          })
        )}
      </div>
      <div className="border-t border-border px-3 py-2">
        <div className="mb-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
          <span className="flex items-center gap-1" title="Working">
            <StateGlyph state="working" size={11} /> {counts.working}
          </span>
          <span className={cx("flex items-center gap-1", counts.blocked > 0 && "text-blocked")} title="Needs input">
            <StateGlyph state="blocked" size={11} /> {counts.blocked}
          </span>
          <span className="flex items-center gap-1" title="Ready for review">
            <StateGlyph state="done" size={11} /> {counts.done}
          </span>
          {counts.error > 0 && (
            <span className="flex items-center gap-1 text-error" title="Failed">
              <StateGlyph state="error" size={11} /> {counts.error}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <IconButton title="Archived workspaces" className={cx(showHistory && "bg-hover text-fg")} onClick={() => useStore.setState({ showHistory: !showHistory })}>
            <History size={13} />
          </IconButton>
          <IconButton title="Settings" onClick={() => useStore.setState({ dialog: { kind: "settings" } })}>
            <Settings size={13} />
          </IconButton>
          <span className="ml-auto text-[10.5px] text-faint">
            <Kbd>⌘K</Kbd> commands
          </span>
        </div>
      </div>
    </aside>
  );
}
