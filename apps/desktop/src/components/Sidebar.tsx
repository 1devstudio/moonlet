import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Archive, ArrowDown, ChevronDown, ChevronRight, Folder, FolderPlus, History, Loader2, MoreHorizontal, Plus, RotateCcw, Settings, ShieldAlert } from "lucide-react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { rpc } from "../lib/daemon";
import { M, type HostInfo, type Project, type Session, type Workspace, type WorkspaceView } from "../lib/protocol";
import { arrange, compact, dropResult, lastActive, type Dragged, type Group } from "../lib/sidebar";
import { errorToast, projKey, pullBase, selectSession, sesKey, sessionState, sessionTerminals, termKey, toast, useStore } from "../lib/store";
import { aheadText, baseChip, behindHeadline, fetchedLabel, rebaseCommand, type BaseChip } from "../lib/baseSync";
import { archiveSession, openProjectSettings } from "../lib/actions";
import { Menu, MenuItems, type MenuItem } from "./Menu";
import { Button, IconButton, Kbd, StateGlyph, cx, prTone } from "./ui";

// ------------------------------------------------------------------ helpers

function updateWorkspace(host: string, id: string, patch: Partial<Pick<Workspace, "name" | "project_ids" | "sections">> & { view?: WorkspaceView }) {
  return rpc<Workspace>(host, M.workspaceUpdate, { id, ...patch }).catch(errorToast);
}

/** Deletes a section after confirming, and moves its sessions out of it. */
async function deleteSection(host: string, ws: Workspace, id: string, sessions: Session[]) {
  if (sessions.length) {
    const ok = await confirm(`Delete this section? Its ${sessions.length} session${sessions.length === 1 ? "" : "s"} move back to their projects.`, {
      title: "Delete section",
      kind: "warning",
    });
    if (!ok) return;
  }
  try {
    await Promise.all(sessions.map((s) => rpc(host, M.sessionUpdate, { id: s.id, section: "" })));
    await updateWorkspace(host, ws.id, { sections: ws.sections.filter((x) => x.id !== id) });
  } catch (e) {
    errorToast(e);
  }
}

const activeAt = (host: string, s: Session) => lastActive(useStore.getState().terminals[host] ?? {}, s);

/** Project mark: the GitHub owner's avatar (X15), else a dotted glyph like Conductor's. */
function ProjectMark({ host, projectId }: { host: string; projectId: string }) {
  const src = useStore((s) => s.avatars[projKey(host, projectId)]);
  const [failed, setFailed] = useState<string | null>(null);
  if (src && failed !== src) {
    return <img src={src} alt="" width={15} height={15} draggable={false} onError={() => setFailed(src)} className="h-[15px] w-[15px] shrink-0 rounded-[3px]" />;
  }
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" className="shrink-0 text-[#4fd1c5]" fill="currentColor">
      {[
        [8, 2],
        [3, 5],
        [13, 5],
        [3, 11],
        [13, 11],
        [8, 14],
        [8, 8],
      ].map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={i === 6 ? 1.6 : 1.3} />
      ))}
    </svg>
  );
}

/** Branch glyph tinted by PR state; a merged PR gets a merge glyph instead. */
function BranchIcon({ state }: { state?: string }) {
  const merged = state === "merged";
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" className={cx("shrink-0", prTone(state))} fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="4.5" cy="3.5" r="1.6" />
      <circle cx="4.5" cy="12.5" r="1.6" />
      {merged ? (
        <>
          <circle cx="11.5" cy="9" r="1.6" />
          <path d="M4.5 5.1v5.8M4.5 5.1c0 2.4 2.2 3.9 5.4 3.9" />
        </>
      ) : (
        <>
          <circle cx="11.5" cy="5" r="1.6" />
          <path d="M4.5 5.1v5.8M11.5 6.6c0 3-4.5 2.4-6.6 4.4" />
        </>
      )}
    </svg>
  );
}

function InlineInput({ initial, placeholder, onDone }: { initial: string; placeholder?: string; onDone: (value: string | null) => void }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <input
      ref={ref}
      value={v}
      placeholder={placeholder}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => finish(v.trim() || null)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(v.trim() || null);
        if (e.key === "Escape") finish(null);
      }}
      className="min-w-0 flex-1 rounded border border-accent bg-panel-2 px-1.5 py-0.5 text-[14px] text-fg outline-none"
    />
  );
}

// ------------------------------------------------------- base branch (X13)

const CHIP_TONE: Record<BaseChip["kind"], string> = { behind: "text-accent", pulling: "text-muted", diverged: "text-error" };

/** "main is behind origin" chip on a project row, with the Pull popover. */
function BasePullChip({ host, projectId }: { host: string; projectId: string }) {
  const sync = useStore((s) => s.base[projKey(host, projectId)]);
  const project = useStore((s) => s.projects[host]?.find((p) => p.id === projectId));
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  const chip = baseChip(sync?.status, !!sync?.pulling);
  const openable = chip?.kind === "behind" || chip?.kind === "diverged";
  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    // The sidebar list scrolled away from the chip.
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [pos]);
  if (!chip || !sync?.status || !project) return null;
  const st = sync.status;
  const toggle = () => {
    if (pos || !openable || !ref.current) return setPos(null);
    const r = ref.current.getBoundingClientRect();
    const side = ref.current.closest("aside")?.getBoundingClientRect().left ?? 0;
    setPos({ top: Math.round(r.bottom + 6), left: side + 12 });
  };
  const mono = (t: string) => <span className="font-mono text-fg">{t}</span>;
  const command = rebaseCommand(st, project.path);
  return (
    <>
      <button
        ref={ref}
        title={chip.title}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={toggle}
        className={cx("flex h-[22px] shrink-0 items-center gap-1 rounded-md border border-border-strong bg-panel-2 px-1.5 font-mono text-[11.5px] hover:bg-hover", CHIP_TONE[chip.kind])}
      >
        {chip.kind === "behind" ? <ArrowDown size={12} strokeWidth={1.75} /> : chip.kind === "pulling" ? <Loader2 size={12} strokeWidth={1.75} className="animate-spin" /> : <ShieldAlert size={12} strokeWidth={1.75} />}
        <span>{chip.text}</span>
      </button>
      {pos && openable && (
        <div
          role="dialog"
          aria-label={`Pull ${st.branch}`}
          className="fixed z-50 w-[276px] rounded-xl border border-border-strong bg-[#232323] p-1 shadow-2xl"
          style={pos}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {chip.kind === "diverged" ? (
            <div className="px-3 pb-2 pt-2.5">
              <div className="text-[13px] font-medium text-fg">Can't fast-forward {st.branch}</div>
              <div className="mt-1 text-[12px] text-muted [text-wrap:pretty]">
                Your local {mono(st.branch)} has {aheadText(st)} on {mono(st.upstream)}. jaunt only pulls when it can fast-forward, so nothing was changed.
              </div>
              <div className="mt-2.5 flex items-center gap-2 rounded-md border border-border bg-panel-2 px-2 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg" title={command}>
                  {command}
                </span>
                <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(command).then(() => toast("Copied command"), errorToast)}>
                  Copy
                </Button>
              </div>
              <div className="mt-2 text-[11.5px] text-faint">New sessions still branch from your local {st.branch}.</div>
            </div>
          ) : (
            <>
              <div className="px-3 pb-1.5 pt-2.5">
                <div className="text-[13px] font-medium text-fg">{behindHeadline(st)}</div>
                <div className="mt-1 text-[12px] text-muted [text-wrap:pretty]">
                  New sessions branch from your local {mono(st.branch)}. Pull to start them from the merged changes.
                </div>
              </div>
              <div className="flex flex-col px-1 py-1">
                {st.commits.map((c) => (
                  <div key={c.sha} className="flex h-[26px] items-center gap-2 rounded-md px-2">
                    <span className="shrink-0 font-mono text-[11.5px] text-faint">{c.sha.slice(0, 7)}</span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-[#cfcfcf]" title={c.subject}>
                      {c.subject}
                    </span>
                  </div>
                ))}
                {st.behind > st.commits.length && <div className="px-2 py-1 text-[11.5px] text-faint">and {st.behind - st.commits.length} more</div>}
              </div>
              <div className="flex items-center gap-2 border-t border-border px-2 pb-1 pt-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint" title={sync.fetchError ?? undefined}>
                  {fetchedLabel(sync, Date.now())}
                </span>
                <Button size="sm" variant="ghost" onClick={() => setPos(null)}>
                  Later
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    setPos(null);
                    void pullBase(host, projectId);
                  }}
                >
                  <ArrowDown size={12} strokeWidth={1.75} /> Pull {st.branch}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------- rows

/** The session being dragged (HTML drag data is not readable during dragover). */
let dragging: (Dragged & { host: string }) | null = null;

interface RowMenuState {
  x: number;
  y: number;
  host: string;
  session: Session;
  workspace: Workspace;
}

function SessionRow({ host, s, onMenu }: { host: string; s: Session; onMenu: (e: React.MouseEvent) => void }) {
  const selected = useStore((st) => !st.showHistory && st.selected?.host === host && st.selected.session === s.id);
  const state = useStore((st) => sessionState(st, host, s.id));
  const git = useStore((st) => st.git[sesKey(host, s.id)]);
  const pr = useStore((st) => st.prs[sesKey(host, s.id)]);
  const unread = useStore((st) => sessionTerminals(st, host, s.id).some((x) => st.unread[termKey(host, x.id)]));
  const creating = useStore((st) => sessionTerminals(st, host, s.id).some((x) => x.kind === "setup" && !x.exit));
  const [renaming, setRenaming] = useState(false);
  const notable = state && state !== "idle";
  return (
    <div
      role="button"
      title={`${s.branch} → ${s.base}${host !== "local" ? ` · ${host}` : ""}`}
      onClick={() => {
        useStore.setState({ showHistory: false });
        selectSession(host, s.id);
      }}
      onDoubleClick={() => setRenaming(true)}
      draggable={!renaming}
      onDragStart={(e) => {
        dragging = { host, sessionId: s.id, projectId: s.project_id, section: s.section };
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", s.name);
      }}
      onDragEnd={() => {
        dragging = null;
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e);
      }}
      className={cx(
        "group relative flex h-[38px] w-full cursor-default items-center gap-3 pl-[30px] pr-4 text-left transition-colors",
        selected ? "bg-selected" : "hover:bg-panel-2",
      )}
    >
      {selected && <span className="absolute inset-y-0 left-0 w-[2px] bg-accent" />}
      {notable ? <StateGlyph state={state} size={15} /> : <BranchIcon state={pr?.state} />}
      {renaming ? (
        <InlineInput
          initial={s.name}
          onDone={(v) => {
            setRenaming(false);
            if (v && v !== s.name) void rpc(host, M.sessionUpdate, { id: s.id, name: v }).catch(errorToast);
          }}
        />
      ) : (
        <span className={cx("min-w-0 flex-1 truncate text-[14px]", selected || unread ? "text-fg" : "text-[#cfcfcf]", unread && "font-semibold")}>{s.name}</span>
      )}
      {!renaming &&
        (creating ? (
          <span className="shrink-0 font-mono text-[12px] text-muted">creating</span>
        ) : state === "blocked" ? (
          <span className="shrink-0 font-mono text-[12px] text-blocked">needs input</span>
        ) : pr?.state === "merged" ? (
          <span className="shrink-0 font-mono text-[12px] text-merged">merged</span>
        ) : git && (git.additions || git.deletions) ? (
          <span className="shrink-0 font-mono text-[12px] tabular-nums text-muted">
            +{compact(git.additions)}
            {git.deletions ? ` -${compact(git.deletions)}` : ""}
          </span>
        ) : null)}
    </div>
  );
}

function GroupBlock({ host, ws, g, onRowMenu }: { host: string; ws: Workspace; g: Group; onRowMenu: (s: Session, e: React.MouseEvent) => void }) {
  const key = `${host}/${ws.id}/${g.key}`;
  const collapsed = useStore((s) => !!s.collapsed[key]);
  const toggle = () => useStore.setState((s) => ({ collapsed: { ...s.collapsed, [key]: !collapsed } }));
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const accepts = () => !!dragging && dragging.host === host && dropResult(dragging, g) !== null;
  const dropProps = {
    onDragEnter: (e: React.DragEvent) => {
      if (!accepts()) return;
      e.preventDefault();
      depth.current += 1;
      setOver(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!accepts()) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    },
    onDragLeave: () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      const d = dragging;
      dragging = null;
      const r = d && dropResult(d, g);
      if (d && r) void rpc(host, M.sessionUpdate, { id: d.sessionId, section: r.section }).catch(errorToast);
    },
  };
  const header =
    g.kind === "project" ? (
      <>
        <ProjectMark host={host} projectId={g.projectId!} />
        <span className="truncate text-[14px] font-semibold text-[#d6d6d6]">{g.label}</span>
      </>
    ) : g.kind === "section" ? (
      <>
        <Folder size={14} className="shrink-0 text-muted" />
        <span className="truncate text-[14px] font-semibold text-[#d6d6d6]">{g.label}</span>
      </>
    ) : g.kind === "status" ? (
      <span className="truncate text-[11.5px] font-medium uppercase tracking-[0.1em] text-muted">{g.label}</span>
    ) : null;
  return (
    <div {...dropProps} className={cx("mb-1 rounded-md transition-colors", over && "bg-selected outline outline-1 outline-accent/60")}>
      {header && (
        <div className="group flex h-[38px] items-center gap-2.5 pl-4 pr-3">
          <button onClick={toggle} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
            {header}
            {collapsed && <ChevronRight size={12} className="text-faint" />}
          </button>
          {g.kind === "project" && <BasePullChip host={host} projectId={g.projectId!} />}
          {g.kind === "project" && (
            <IconButton title="Project settings" className="h-7 w-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => openProjectSettings({ host, project: g.projectId! })}>
              <Settings size={15} />
            </IconButton>
          )}
          {g.kind === "project" && (
            <IconButton title="New session" className="h-7 w-7" onClick={() => useStore.setState({ dialog: { kind: "new-session", host, project: g.projectId, workspace: ws.id } })}>
              <Plus size={16} />
            </IconButton>
          )}
          {g.kind === "section" && (
            <IconButton
              title="Delete section"
              className="opacity-0 group-hover:opacity-100"
              onClick={() => void deleteSection(host, ws, g.sectionId!, g.sessions)}
            >
              <span className="text-[13px]">×</span>
            </IconButton>
          )}
        </div>
      )}
      {!collapsed && g.sessions.map((s) => <SessionRow key={s.id} host={host} s={s} onMenu={(e) => onRowMenu(s, e)} />)}
      {!collapsed && g.kind === "section" && g.sessions.length === 0 && (
        <div className="pb-1.5 pl-[30px] text-[12.5px] text-faint">Drag sessions here</div>
      )}
    </div>
  );
}

function WorkspaceBlock({ host, ws, onRowMenu }: { host: string; ws: Workspace; onRowMenu: (m: RowMenuState) => void }) {
  const key = `ws:${host}/${ws.id}`;
  const collapsed = useStore((s) => !!s.collapsed[key]);
  const projects = useStore((s) => s.projects[host] ?? []);
  const sessions = useStore((s) => s.sessions[host] ?? []);
  const terminals = useStore((s) => s.terminals[host]);
  const multiHost = useStore((s) => Object.keys(s.hosts).length > 1);
  const [editing, setEditing] = useState<null | "rename" | "section">(null);
  const groups = useMemo(
    () => arrange(ws, projects, sessions, (s) => sessionState(useStore.getState(), host, s.id), (s) => activeAt(host, s)),
    // `terminals` changes agent states and activity times.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws, projects, sessions, terminals, host],
  );
  const v = ws.view;
  const setView = (patch: Partial<WorkspaceView>) => void updateWorkspace(host, ws.id, { view: { ...v, ...patch } });
  const wsProjects = ws.project_ids.map((id) => projects.find((p) => p.id === id)).filter((p): p is Project => !!p);
  const toggleFilter = (id: string) => {
    const cur = v.filter.length ? v.filter : wsProjects.map((p) => p.id);
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    setView({ filter: next.length === wsProjects.length ? [] : next });
  };
  const items: MenuItem[] = [
    {
      kind: "submenu",
      label: "Group by",
      items: (
        [
          ["project", "Project"],
          ["status", "Status"],
          ["none", "None"],
        ] as const
      ).map(([id, label]) => ({ label, checked: v.group_by === id, onSelect: () => setView({ group_by: id }) })),
    },
    {
      kind: "submenu",
      label: "Filter by project",
      items: [
        { label: "All projects", checked: v.filter.length === 0, onSelect: () => setView({ filter: [] }) },
        { kind: "divider" },
        ...wsProjects.map((p) => ({ label: p.name, checked: v.filter.length === 0 || v.filter.includes(p.id), onSelect: () => toggleFilter(p.id) })),
      ],
    },
    {
      kind: "submenu",
      label: "Sort by",
      items: (
        [
          ["recent", "Recent activity"],
          ["created", "Created"],
          ["name", "Name"],
        ] as const
      ).map(([id, label]) => ({ label, checked: v.sort_by === id, onSelect: () => setView({ sort_by: id }) })),
    },
    { kind: "divider" },
    { label: "New section…", icon: <Plus size={15} className="text-muted" />, onSelect: () => setEditing("section") },
    { label: "Add project…", icon: <FolderPlus size={15} className="text-muted" />, onSelect: () => useStore.setState({ dialog: { kind: "add-project", host, workspace: ws.id } }) },
    { kind: "divider" },
    { label: "Rename workspace…", onSelect: () => setEditing("rename") },
    {
      label: "Delete workspace",
      danger: true,
      onSelect: async () => {
        try {
          await rpc(host, M.workspaceDelete, { id: ws.id });
          toast(`Deleted ${ws.name}; its projects and sessions are kept`);
        } catch (e) {
          errorToast(e);
        }
      },
    },
  ];
  return (
    <div className="mb-3">
      <div className="group mx-2 flex h-[38px] items-center gap-1 rounded-lg bg-[#1e1e1e] pl-2.5 pr-1.5">
        {editing === "rename" ? (
          <InlineInput
            initial={ws.name}
            onDone={(name) => {
              setEditing(null);
              if (name && name !== ws.name) void updateWorkspace(host, ws.id, { name });
            }}
          />
        ) : (
          <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => useStore.setState((s) => ({ collapsed: { ...s.collapsed, [key]: !collapsed } }))}>
            <span className="truncate text-[14px] font-semibold text-muted group-hover:text-fg">{ws.name}</span>
            {multiHost && host !== "local" && <span className="truncate font-mono text-[11px] text-faint">@{host}</span>}
            {collapsed ? <ChevronRight size={13} className="text-faint" /> : <ChevronDown size={13} className="text-faint opacity-0 group-hover:opacity-100" />}
          </button>
        )}
        <Menu
          items={items}
          trigger={(open) => (
            <IconButton title="Workspace options" className="h-7 w-7" onClick={open}>
              <MoreHorizontal size={16} />
            </IconButton>
          )}
        />
      </div>
      {!collapsed && (
        <div className="pt-1">
          {editing === "section" && (
            <div className="flex items-center gap-2 py-1 pl-4 pr-3">
              <Folder size={14} className="text-muted" />
              <InlineInput
                initial=""
                placeholder="Section name"
                onDone={(name) => {
                  setEditing(null);
                  if (name) void updateWorkspace(host, ws.id, { sections: [...ws.sections, { id: `${ws.id}:${Date.now().toString(36)}`, name }] });
                }}
              />
            </div>
          )}
          {groups.map((g) => (
            <GroupBlock key={g.key} host={host} ws={ws} g={g} onRowMenu={(s, e) => onRowMenu({ x: e.clientX, y: e.clientY, host, session: s, workspace: ws })} />
          ))}
          {wsProjects.length === 0 && (
            <button
              className="ml-4 mt-1 flex items-center gap-2 text-[13px] text-faint hover:text-accent"
              onClick={() => useStore.setState({ dialog: { kind: "add-project", host, workspace: ws.id } })}
            >
              <FolderPlus size={14} /> Add a project to this workspace
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function RowContextMenu({ m, onClose }: { m: RowMenuState; onClose: () => void }) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [onClose]);
  const { host, session: s, workspace: ws } = m;
  const moveTo = (section: string) => void rpc(host, M.sessionUpdate, { id: s.id, section }).catch(errorToast);
  const items: MenuItem[] = [
    { label: "Open", onSelect: () => selectSession(host, s.id) },
    ws.sections.length
      ? { kind: "submenu", label: "Move to section", items: ws.sections.map((sec) => ({ label: sec.name, checked: s.section === sec.id, onSelect: () => moveTo(sec.id) })) }
      : { label: "Move to section…", hint: "none yet", onSelect: () => toast("Create one first: workspace ⋯ › New section…") },
    ...(s.section && ws.sections.some((x) => x.id === s.section) ? [{ label: "Remove from section", onSelect: () => moveTo("") }] : []),
    { kind: "divider" },
    {
      label: "Archive",
      icon: <Archive size={14} className="text-muted" />,
      onSelect: () => {
        void archiveSession(false, { host, ws: s });
      },
    },
  ];
  return (
    <div
      className="fixed z-50 w-60 rounded-xl border border-border-strong bg-[#232323] p-1 shadow-2xl"
      style={{ left: Math.min(m.x, window.innerWidth - 250), top: Math.min(m.y, window.innerHeight - 220) }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <MenuItems items={items} onClose={onClose} />
      <div className="px-3 pb-1 pt-1.5 text-[11.5px] text-faint">Double-click a session to rename it</div>
    </div>
  );
}

function HistoryList() {
  const hosts = useStore((s) => s.hosts);
  const sessions = useStore((s) => s.sessions);
  const archived = Object.keys(hosts).flatMap((h) => (sessions[h] ?? []).filter((w) => w.archived).map((w) => ({ host: h, w })));
  archived.sort((a, b) => b.w.created_at - a.w.created_at);
  return (
    <div>
      <div className="flex h-[34px] items-center pl-4 text-[12px] font-medium uppercase tracking-[0.12em] text-muted">Archived sessions</div>
      {archived.length === 0 && <div className="px-[22px] py-1 text-[13px] text-faint">Nothing archived yet.</div>}
      {archived.map(({ host, w }) => (
        <div key={host + w.id} className="group flex h-[38px] items-center gap-3 pl-[22px] pr-4 hover:bg-panel-2">
          <Archive size={13} className="text-faint" />
          <span className="min-w-0 flex-1 truncate text-[14px] text-[#cfcfcf]">{w.name}</span>
          <IconButton
            title="Restore session"
            className="opacity-0 group-hover:opacity-100"
            onClick={async () => {
              try {
                await rpc(host, M.sessionUnarchive, { id: w.id });
                useStore.setState({ showHistory: false });
                selectSession(host, w.id);
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

function HostNotice({ host }: { host: HostInfo }) {
  if (host.status === "connected") return null;
  const text = host.status === "needs_install" ? "helper not installed" : host.status === "error" ? (host.message ?? "connection failed") : "reconnecting…";
  return (
    <div className="mx-3 mb-2 flex items-center gap-2 rounded-md bg-panel-2 px-2.5 py-1.5 text-[12px]">
      <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", host.status === "reconnecting" || host.status === "connecting" ? "bg-blocked" : "bg-error")} />
      <span className="truncate text-muted">
        {host.label}: {text}
      </span>
    </div>
  );
}

function NavRow({ icon, label, active, onClick, hint }: { icon: ReactNode; label: string; active?: boolean; onClick: () => void; hint?: string }) {
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
      {hint && <Kbd>{hint}</Kbd>}
    </button>
  );
}

export function Sidebar() {
  const hosts = useStore((s) => s.hosts);
  const workspaces = useStore((s) => s.workspaces);
  const showHistory = useStore((s) => s.showHistory);
  const [rowMenu, setRowMenu] = useState<RowMenuState | null>(null);
  const [creating, setCreating] = useState(false);
  const ordered = useMemo(() => Object.values(hosts).sort((a, b) => Number(a.remote) - Number(b.remote) || a.id.localeCompare(b.id)), [hosts]);

  return (
    <aside className="flex h-full flex-col bg-panel">
      <div data-tauri-drag-region className="drag h-[52px] shrink-0" />
      <nav className="px-2 pb-3">
        <NavRow icon={<Plus size={15} strokeWidth={1.75} />} label="New session" hint="⇧⌘N" onClick={() => useStore.setState({ dialog: { kind: "new-session" } })} />
        <NavRow icon={<History size={15} strokeWidth={1.75} />} label="History" active={showHistory} onClick={() => useStore.setState({ showHistory: !showHistory })} />
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {showHistory ? (
          <HistoryList />
        ) : (
          ordered.map((h) => (
            <div key={h.id}>
              <HostNotice host={h} />
              {(workspaces[h.id] ?? []).map((ws) => (
                <WorkspaceBlock key={ws.id} host={h.id} ws={ws} onRowMenu={setRowMenu} />
              ))}
            </div>
          ))
        )}
        {!showHistory && (
          <div className="mx-2">
            {creating ? (
              <div className="flex h-[38px] items-center gap-2 rounded-lg bg-[#1e1e1e] px-2.5">
                <InlineInput
                  initial=""
                  placeholder="Workspace name"
                  onDone={async (name) => {
                    setCreating(false);
                    if (!name) return;
                    try {
                      await rpc(ordered.find((h) => h.status === "connected")?.id ?? "local", M.workspaceCreate, { name });
                    } catch (e) {
                      errorToast(e);
                    }
                  }}
                />
              </div>
            ) : (
              <button className="flex h-[34px] w-full items-center gap-3 rounded-md px-3 text-left text-[13.5px] text-faint hover:bg-panel-2 hover:text-fg" onClick={() => setCreating(true)}>
                <Plus size={14} /> New workspace
              </button>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 px-3 py-2.5">
        <IconButton title="Settings (⌘,)" onClick={() => useStore.setState({ dialog: { kind: "settings" } })}>
          <Settings size={14} />
        </IconButton>
        <span className="ml-auto">
          <Kbd>⌘K</Kbd>
        </span>
      </div>
      {rowMenu && <RowContextMenu m={rowMenu} onClose={() => setRowMenu(null)} />}
    </aside>
  );
}
