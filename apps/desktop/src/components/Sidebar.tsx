import { useMemo, type ReactNode } from "react";
import { Archive, ChevronDown, ChevronRight, FolderPlus, History, Layers, Plus, RotateCcw, Settings } from "lucide-react";
import { hostsApi, rpc } from "../lib/daemon";
import { M, type AgentState, type HostInfo, type Repo, type Workspace } from "../lib/protocol";
import { errorToast, selectWorkspace, sessKey, toast, useStore, workspaceSessions, workspaceState, wsKey } from "../lib/store";
import { IconButton, StateGlyph, cx } from "./ui";

function NavRow({ icon, label, active, onClick, right }: { icon: ReactNode; label: string; active?: boolean; onClick: () => void; right?: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "no-drag flex h-[34px] w-full items-center gap-3 rounded-md px-3 text-left text-[14px] transition-colors",
        active ? "bg-raised text-fg" : "text-muted hover:bg-panel-2 hover:text-fg",
      )}
    >
      <span className="flex w-4 justify-center">{icon}</span>
      <span className="flex-1">{label}</span>
      {right}
    </button>
  );
}

const STATE_WORD: Partial<Record<AgentState, string>> = { blocked: "needs input", error: "failed" };

function WorkspaceRow({ host, ws }: { host: string; ws: Workspace }) {
  const selected = useStore((s) => !s.showHistory && s.selected?.host === host && s.selected.workspace === ws.id);
  const state = useStore((s) => workspaceState(s, host, ws.id));
  const git = useStore((s) => s.git[wsKey(host, ws.id)]);
  const unread = useStore((s) => workspaceSessions(s, host, ws.id).some((x) => s.unread[sessKey(host, x.id)]));
  const creating = useStore((s) => workspaceSessions(s, host, ws.id).some((x) => x.kind === "setup" && !x.exit));
  const word = creating ? "creating" : state ? STATE_WORD[state] : undefined;
  return (
    <button
      title={`${ws.branch} → ${ws.base}${host !== "local" ? ` · ${host}` : ""}`}
      onClick={() => {
        useStore.setState({ showHistory: false });
        selectWorkspace(host, ws.id);
      }}
      className={cx(
        "group relative flex h-[38px] w-full items-center gap-3 pl-[22px] pr-4 text-left transition-colors",
        selected ? "bg-selected" : "hover:bg-panel-2",
      )}
    >
      {selected && <span className="absolute inset-y-0 left-0 w-[2px] bg-accent" />}
      <StateGlyph state={state} size={13} />
      <span className={cx("min-w-0 flex-1 truncate text-[14px]", selected || unread ? "text-fg" : "text-[#cfcfcf]", unread && "font-semibold")}>{ws.name}</span>
      {word ? (
        <span className={cx("shrink-0 font-mono text-[12px]", state === "blocked" ? "text-blocked" : state === "error" ? "text-error" : "text-muted")}>{word}</span>
      ) : git && (git.additions || git.deletions) ? (
        <span className="shrink-0 font-mono text-[12px] tabular-nums text-muted">
          +{git.additions}
          {git.deletions ? ` −${git.deletions}` : ""}
        </span>
      ) : null}
    </button>
  );
}

function RepoGroup({ host, repo, list, multiHost }: { host: string; repo: Repo; list: Workspace[]; multiHost: boolean }) {
  const key = `${host}/${repo.id}`;
  const collapsed = useStore((s) => !!s.collapsed[key]);
  const toggle = () => useStore.setState((s) => ({ collapsed: { ...s.collapsed, [key]: !collapsed } }));
  return (
    <div className="mb-2">
      <div className="group flex h-[34px] items-center pl-4 pr-3">
        <button onClick={toggle} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {collapsed ? <ChevronRight size={12} className="text-faint" /> : <ChevronDown size={12} className="text-faint" />}
          <span className="truncate text-[12px] font-medium uppercase tracking-[0.12em] text-muted group-hover:text-fg">{repo.name}</span>
          {multiHost && host !== "local" && <span className="truncate font-mono text-[10.5px] lowercase tracking-normal text-faint">@{host}</span>}
        </button>
        <IconButton
          title="New workspace in this repo"
          className="mr-1 opacity-0 group-hover:opacity-100"
          onClick={() => useStore.setState({ dialog: { kind: "new-workspace", host, repo: repo.id } })}
        >
          <Plus size={13} />
        </IconButton>
        <span className="w-4 text-right font-mono text-[12px] text-faint">{list.length}</span>
      </div>
      {!collapsed && list.map((w) => <WorkspaceRow key={w.id} host={host} ws={w} />)}
    </div>
  );
}

function HostNotice({ host }: { host: HostInfo }) {
  if (host.status === "connected") return null;
  const text =
    host.status === "needs_install" ? "helper not installed" : host.status === "error" ? (host.message ?? "connection failed") : "reconnecting…";
  return (
    <div className="mx-4 mb-2 flex items-center gap-2 rounded-md bg-panel-2 px-2.5 py-1.5 text-[12px]">
      <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", host.status === "reconnecting" || host.status === "connecting" ? "bg-blocked" : "bg-error")} />
      <span className="truncate text-muted">
        {host.label}: {text}
      </span>
      {host.status === "needs_install" && (
        <button className="ml-auto shrink-0 text-accent hover:underline" onClick={() => useStore.setState({ dialog: { kind: "settings" } })}>
          set up
        </button>
      )}
      {host.status === "error" && (
        <button className="ml-auto shrink-0 text-accent hover:underline" onClick={() => void hostsApi.reconnect(host.id)}>
          retry
        </button>
      )}
    </div>
  );
}

function HistoryList() {
  const hosts = useStore((s) => s.hosts);
  const workspaces = useStore((s) => s.workspaces);
  const archived = Object.keys(hosts).flatMap((h) => (workspaces[h] ?? []).filter((w) => w.archived).map((w) => ({ host: h, w })));
  archived.sort((a, b) => b.w.created_at - a.w.created_at);
  return (
    <div>
      <div className="flex h-[34px] items-center pl-4 text-[12px] font-medium uppercase tracking-[0.12em] text-muted">Archived</div>
      {archived.length === 0 && <div className="px-[22px] py-1 text-[13px] text-faint">Nothing archived yet.</div>}
      {archived.map(({ host, w }) => (
        <div key={host + w.id} className="group flex h-[38px] items-center gap-3 pl-[22px] pr-4 hover:bg-panel-2">
          <Archive size={13} className="text-faint" />
          <span className="min-w-0 flex-1 truncate text-[14px] text-[#cfcfcf]">{w.name}</span>
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
  const repos = useStore((s) => s.repos);
  const workspaces = useStore((s) => s.workspaces);
  const showHistory = useStore((s) => s.showHistory);
  const home = useStore((s) => !s.selected && !s.showHistory);
  const ordered = useMemo(() => Object.values(hosts).sort((a, b) => Number(a.remote) - Number(b.remote) || a.id.localeCompare(b.id)), [hosts]);
  const multiHost = ordered.length > 1;
  const noRepos = Object.values(repos).every((r) => r.length === 0);

  return (
    <aside className="flex h-full flex-col bg-panel">
      <div className="drag h-[52px] shrink-0" />
      <nav className="px-2 pb-3">
        <NavRow icon={<Layers size={15} strokeWidth={1.75} />} label="Workspaces" active={home} onClick={() => useStore.setState({ selected: null, showHistory: false })} />
        <NavRow icon={<History size={15} strokeWidth={1.75} />} label="History" active={showHistory} onClick={() => useStore.setState({ showHistory: !showHistory })} />
        <NavRow icon={<Plus size={15} strokeWidth={1.75} />} label="New Workspace" onClick={() => useStore.setState({ dialog: { kind: "new-workspace" } })} />
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3 pt-2">
        {showHistory ? (
          <HistoryList />
        ) : noRepos ? (
          <div className="px-5 py-4 text-[13px] text-faint">
            Add a repository to run agents in their own worktrees.
            <button className="mt-2 block text-accent hover:underline" onClick={() => useStore.setState({ dialog: { kind: "add-repo" } })}>
              Add repository…
            </button>
          </div>
        ) : (
          ordered.map((h) => (
            <div key={h.id}>
              <HostNotice host={h} />
              {(repos[h.id] ?? []).map((r) => (
                <RepoGroup
                  key={r.id}
                  host={h.id}
                  repo={r}
                  multiHost={multiHost}
                  list={(workspaces[h.id] ?? []).filter((w) => !w.archived && w.repo_id === r.id).sort((a, b) => b.created_at - a.created_at)}
                />
              ))}
            </div>
          ))
        )}
      </div>
      <div className="flex items-center gap-1 px-3 py-2.5">
        <IconButton title="Add repository" onClick={() => useStore.setState({ dialog: { kind: "add-repo" } })}>
          <FolderPlus size={14} />
        </IconButton>
        <IconButton title="Settings (⌘,)" onClick={() => useStore.setState({ dialog: { kind: "settings" } })}>
          <Settings size={14} />
        </IconButton>
        <span className="ml-auto font-mono text-[11px] text-faint">⌘K</span>
      </div>
    </aside>
  );
}
