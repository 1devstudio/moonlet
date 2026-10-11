import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Archive, ArrowDown, ChevronDown, ChevronRight, Command, FolderPlus, History, Loader2, MoreHorizontal, Plus, RotateCcw, Settings, ShieldAlert } from "lucide-react";
import { rpc } from "../lib/daemon";
import { M, type HostInfo, type Project, type Section, type SectionView, type Session, type Workspace } from "../lib/protocol";
import { arrange, compact, hostSections, lastActive, projectRemoval, type Group } from "../lib/sidebar";
import { errorToast, projKey, pullBase, selectSession, sesKey, sessionState, sessionTerminals, shownWorkspace, termKey, toast, useStore } from "../lib/store";
import { aheadText, baseChip, behindHeadline, chipClick, fetchedLabel, pullPopoverPlacement, rebaseCommand, type BaseChip } from "../lib/baseSync";
import { archiveSession, openProjectSettings } from "../lib/actions";
import { askConfirm } from "../lib/confirm";
import { ARCHIVE_FOLD_MS, type Archiving } from "../lib/archiveLoader";
import { ArchiveLoader } from "./ArchiveLoader";
import { spawnedFrom } from "../lib/spawned";
import { Menu, MenuItems, type MenuItem } from "./Menu";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { Button, IconButton, Kbd, StateGlyph, cx, prTone } from "./ui";

// ------------------------------------------------------------------ helpers

function updateSection(host: string, id: string, patch: { name?: string; view?: SectionView }) {
  return rpc<Section>(host, M.sectionUpdate, { id, ...patch }).catch(errorToast);
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
      className="min-w-0 flex-1 rounded border border-accent bg-panel-2 px-1.5 py-0.5 ui-text-14 text-fg outline-none"
    />
  );
}

// ------------------------------------------------------- base branch (X13)

const CHIP_TONE: Record<BaseChip["kind"], string> = { behind: "text-accent", pulling: "text-muted", diverged: "text-error" };

/** Closes the open pull popover. A chip's mousedown does not reach the
 *  window, so opening another popover closes this one through here. */
let closeBasePopover: (() => void) | null = null;

/** "main is behind origin" chip beside the project name. Hovering shows the
 *  details popover; clicking pulls. */
type PopoverPos = ReturnType<typeof pullPopoverPlacement> & { left: number };

function BasePullChip({ host, projectId }: { host: string; projectId: string }) {
  const sync = useStore((s) => s.base[projKey(host, projectId)]);
  const project = useStore((s) => s.projects[host]?.find((p) => p.id === projectId));
  const [pos, setPos] = useState<PopoverPos | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const leaveTimer = useRef<number | undefined>(undefined);
  const chip = baseChip(sync?.status, !!sync?.pulling);
  const openable = chip?.kind === "behind" || chip?.kind === "diverged";
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);
  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    closeBasePopover?.();
    closeBasePopover = close;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    // The sidebar list scrolled away from the chip; the popover's own commit
    // list scrolling keeps it open.
    const onScroll = (e: Event) => !popRef.current?.contains(e.target as Node) && close();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      if (closeBasePopover === close) closeBasePopover = null;
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [pos]);
  if (!chip || !sync?.status || !project) return null;
  const st = sync.status;
  const open = () => {
    window.clearTimeout(leaveTimer.current);
    if (pos || !openable || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const side = ref.current.closest("aside")?.getBoundingClientRect().left ?? 0;
    setPos({ ...pullPopoverPlacement(r, window.innerHeight), left: side + 12 });
  };
  // A short grace period lets the pointer cross the gap into the popover.
  const leave = () => {
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => setPos(null), 150);
  };
  const click = () => {
    const action = chipClick(chip);
    if (action === "details") return open();
    if (action !== "pull") return;
    window.clearTimeout(leaveTimer.current);
    setPos(null);
    void pullBase(host, projectId);
  };
  const mono = (t: string) => <span className="font-mono text-fg">{t}</span>;
  const command = rebaseCommand(st, project.path);
  return (
    <>
      <button
        ref={ref}
        aria-label={chip.title}
        onMouseDown={(e) => e.stopPropagation()}
        onMouseEnter={open}
        onMouseLeave={leave}
        onClick={click}
        className={cx("flex h-[22px] shrink-0 items-center gap-1 rounded-md border border-border-strong bg-panel-2 px-1.5 font-mono ui-text-11.5 hover:bg-hover", CHIP_TONE[chip.kind])}
      >
        {chip.kind === "behind" ? <ArrowDown size={12} strokeWidth={1.75} /> : chip.kind === "pulling" ? <Loader2 size={12} strokeWidth={1.75} className="animate-spin" /> : <ShieldAlert size={12} strokeWidth={1.75} />}
        <span>{chip.text}</span>
      </button>
      {pos && openable && (
        <div
          ref={popRef}
          role="dialog"
          aria-label={`Pull ${st.branch}`}
          className="fixed z-50 flex w-[276px] flex-col overflow-hidden rounded-xl border border-border-strong bg-[#232323] p-1 shadow-2xl"
          style={pos}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseEnter={open}
          onMouseLeave={leave}
        >
          {chip.kind === "diverged" ? (
            <div className="overflow-y-auto px-3 pb-2 pt-2.5">
              <div className="ui-text-13 font-medium text-fg">Can't fast-forward {st.branch}</div>
              <div className="mt-1 ui-text-12 text-muted [text-wrap:pretty]">
                Your local {mono(st.branch)} has {aheadText(st)} on {mono(st.upstream)}. moonlet only pulls when it can fast-forward, so nothing was changed.
              </div>
              <div className="mt-2.5 flex items-center gap-2 rounded-md border border-border bg-panel-2 px-2 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono ui-text-11.5 text-fg" title={command}>
                  {command}
                </span>
                <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(command).then(() => toast("Copied command"), errorToast)}>
                  Copy
                </Button>
              </div>
              <div className="mt-2 ui-text-11.5 text-faint">New sessions still branch from your local {st.branch}.</div>
            </div>
          ) : (
            <>
              <div className="shrink-0 px-3 pb-1.5 pt-2.5">
                <div className="ui-text-13 font-medium text-fg">{behindHeadline(st)}</div>
                <div className="mt-1 ui-text-12 text-muted [text-wrap:pretty]">
                  New sessions branch from your local {mono(st.branch)}. Click the chip to pull the merged changes.
                </div>
              </div>
              <div className="flex min-h-0 max-h-[190px] flex-col overflow-y-auto px-1 py-1">
                {st.commits.map((c) => (
                  <div key={c.sha} className="flex h-[26px] items-center gap-2 rounded-md px-2">
                    <span className="shrink-0 font-mono ui-text-11.5 text-faint">{c.sha.slice(0, 7)}</span>
                    <span className="min-w-0 flex-1 truncate ui-text-12.5 text-[#cfcfcf]" title={c.subject}>
                      {c.subject}
                    </span>
                  </div>
                ))}
                {st.behind > st.commits.length && <div className="px-2 py-1 ui-text-11.5 text-faint">and {st.behind - st.commits.length} more</div>}
              </div>
              <div className="shrink-0 border-t border-border px-3 pb-1.5 pt-2">
                <div className="truncate font-mono ui-text-11 text-faint" title={sync.fetchError ?? undefined}>
                  {fetchedLabel(sync, Date.now())}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------- rows

/** A right-clicked session row, or a project header when `projectId` is set. */
interface RowMenuState {
  x: number;
  y: number;
  host: string;
  section: Section;
  session?: Session;
  projectId?: string;
}

function SessionRow({ host, s, onMenu }: { host: string; s: Session; onMenu: (e: React.MouseEvent) => void }) {
  const selected = useStore((st) => !st.showHistory && st.selected?.host === host && st.selected.session === s.id);
  const state = useStore((st) => sessionState(st, host, s.id));
  const git = useStore((st) => st.git[sesKey(host, s.id)]);
  const pr = useStore((st) => st.prs[sesKey(host, s.id)]);
  const unread = useStore((st) => sessionTerminals(st, host, s.id).some((x) => st.unread[termKey(host, x.id)]));
  const creating = useStore((st) => sessionTerminals(st, host, s.id).some((x) => x.kind === "setup" && !x.exit));
  const archiving = useStore((st) => st.archiving[sesKey(host, s.id)]);
  const from = useStore((st) => spawnedFrom(s, st.sessions[host] ?? []));
  const [renaming, setRenaming] = useState(false);
  const notable = state && state !== "idle";
  if (archiving) return <ArchivingRow name={s.name} a={archiving} />;
  return (
    <div
      role="button"
      aria-current={selected ? "true" : undefined}
      title={`${s.branch} → ${s.base}${host !== "local" ? ` · ${host}` : ""}${from ? `\n${from}` : ""}`}
      onClick={() => {
        useStore.setState({ showHistory: false });
        selectSession(host, s.id);
      }}
      onDoubleClick={() => setRenaming(true)}
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
        <span className={cx("min-w-0 flex-1 truncate ui-text-14", selected || unread ? "text-fg" : "text-[#cfcfcf]", unread && "font-semibold")}>{s.name}</span>
      )}
      {!renaming &&
        (creating ? (
          <span className="shrink-0 font-mono ui-text-12 text-muted">creating</span>
        ) : state === "blocked" ? (
          <span className="shrink-0 font-mono ui-text-12 text-blocked">needs input</span>
        ) : pr?.state === "merged" ? (
          <span className="shrink-0 font-mono ui-text-12 text-merged">merged</span>
        ) : git && (git.additions || git.deletions) ? (
          <span className="shrink-0 font-mono ui-text-12 tabular-nums text-muted">
            +{compact(git.additions)}
            {git.deletions ? ` -${compact(git.deletions)}` : ""}
          </span>
        ) : null)}
    </div>
  );
}

/** A session row while it archives: a pixel scene, then a fold (X21). */
function ArchivingRow({ name, a }: { name: string; a: Archiving }) {
  return (
    <div
      title={a.done ? "Archived" : "Archiving…"}
      className="overflow-hidden"
      style={{ height: a.folding ? 0 : 38, opacity: a.folding ? 0 : 1, transition: `height ${ARCHIVE_FOLD_MS}ms ease, opacity 220ms ease` }}
    >
      <div className="relative h-[38px] overflow-hidden bg-panel">
        <ArchiveLoader loader={a.loader} />
        <div className="relative flex h-[38px] w-1/2 items-center gap-3 pl-[30px]">
          <span role="status" aria-label={a.done ? "Archived" : "Archiving"} className="flex w-[15px] shrink-0 justify-center text-muted">
            {a.done ? <StateGlyph state="done" size={15} /> : <Loader2 size={13} strokeWidth={1.75} className="animate-spin" />}
          </span>
          <span className="min-w-0 flex-1 truncate ui-text-14 text-[#cfcfcf]">{name}</span>
        </div>
      </div>
    </div>
  );
}

function GroupBlock({ host, workspaceId, sec, g, onRowMenu }: { host: string; workspaceId: string; sec: Section; g: Group; onRowMenu: (target: { session?: Session; projectId?: string }, e: React.MouseEvent) => void }) {
  // Keyed by the section id, which X32 kept from the X5 workspace it was, so
  // collapse state carries over.
  const key = `${host}/${sec.id}/${g.key}`;
  const collapsed = useStore((s) => !!s.collapsed[key]);
  const toggle = () => useStore.setState((s) => ({ collapsed: { ...s.collapsed, [key]: !collapsed } }));
  const header =
    g.kind === "project" ? (
      <>
        <ProjectMark host={host} projectId={g.projectId!} />
        <span className="truncate ui-text-14 font-semibold text-[#d6d6d6]">{g.label}</span>
      </>
    ) : g.kind === "status" ? (
      <span className="truncate ui-text-11.5 font-medium uppercase tracking-[0.1em] text-muted">{g.label}</span>
    ) : null;
  return (
    <div className="mb-1 rounded-md">
      {header && (
        <div
          className="group flex h-[38px] items-center gap-2.5 pl-4 pr-3"
          onContextMenu={(e) => {
            if (g.kind !== "project") return;
            e.preventDefault();
            onRowMenu({ projectId: g.projectId }, e);
          }}
        >
          <button onClick={toggle} className={cx("flex min-w-0 items-center gap-2.5 text-left", g.kind !== "project" && "flex-1")}>
            {header}
            {collapsed && <ChevronRight size={12} className="text-faint" />}
          </button>
          {g.kind === "project" && (
            <>
              <BasePullChip host={host} projectId={g.projectId!} />
              {/* The rest of the row still collapses the project. */}
              <div aria-hidden className="h-full min-w-0 flex-1" onClick={toggle} />
            </>
          )}
          {g.kind === "project" && (
            <IconButton title="Project settings" className="h-7 w-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => openProjectSettings({ host, project: g.projectId! })}>
              <Settings size={15} />
            </IconButton>
          )}
          {g.kind === "project" && (
            <IconButton title="New session" className="h-7 w-7" onClick={() => useStore.setState({ dialog: { kind: "new-session", host, project: g.projectId, workspace: workspaceId } })}>
              <Plus size={16} />
            </IconButton>
          )}
        </div>
      )}
      {!collapsed && g.sessions.map((s) => <SessionRow key={s.id} host={host} s={s} onMenu={(e) => onRowMenu({ session: s }, e)} />)}
    </div>
  );
}

function SectionBlock({ host, ws, sec, onRowMenu }: { host: string; ws: Workspace; sec: Section; onRowMenu: (m: RowMenuState) => void }) {
  // The X5 workspace's key: the section kept its id (X32).
  const key = `ws:${host}/${sec.id}`;
  const collapsed = useStore((s) => !!s.collapsed[key]);
  const projects = useStore((s) => s.projects[host] ?? []);
  const sessions = useStore((s) => s.sessions[host] ?? []);
  const terminals = useStore((s) => s.terminals[host]);
  const archiving = useStore((s) => s.archiving);
  // Select the stored array and filter outside: a selector returning a new
  // array on every call makes zustand re-render forever.
  const allWorkspaces = useStore((s) => s.workspaces[host]);
  const others = useMemo(() => (allWorkspaces ?? []).filter((w) => w.id !== ws.id), [allWorkspaces, ws.id]);
  const multiHost = useStore((s) => Object.keys(s.hosts).length > 1);
  const [renaming, setRenaming] = useState(false);
  const groups = useMemo(
    () => arrange(ws.id, sec, projects, sessions, (s) => sessionState(useStore.getState(), host, s.id), (s) => activeAt(host, s), (s) => !!archiving[sesKey(host, s.id)]),
    // `terminals` changes agent states and activity times.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws.id, sec, projects, sessions, terminals, archiving, host],
  );
  const v = sec.view;
  const setView = (patch: Partial<SectionView>) => void updateSection(host, sec.id, { view: { ...v, ...patch } });
  const secProjects = sec.project_ids.map((id) => projects.find((p) => p.id === id)).filter((p): p is Project => !!p);
  const toggleFilter = (id: string) => {
    const cur = v.filter.length ? v.filter : secProjects.map((p) => p.id);
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    setView({ filter: next.length === secProjects.length ? [] : next });
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
        ...secProjects.map((p) => ({ label: p.name, checked: v.filter.length === 0 || v.filter.includes(p.id), onSelect: () => toggleFilter(p.id) })),
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
    { label: "Add project…", icon: <FolderPlus size={15} className="text-muted" />, onSelect: () => useStore.setState({ dialog: { kind: "add-project", host, section: sec.id } }) },
    { kind: "divider" },
    { label: "Rename section…", onSelect: () => setRenaming(true) },
    ...(others.length
      ? [
          {
            kind: "submenu" as const,
            label: "Move to workspace",
            items: others.map((w) => ({
              label: w.name,
              onSelect: () => void rpc(host, M.sectionMove, { id: sec.id, workspace_id: w.id }).catch(errorToast),
            })),
          },
        ]
      : []),
    {
      label: "Delete section",
      danger: true,
      onSelect: async () => {
        try {
          await rpc(host, M.sectionDelete, { id: sec.id });
          toast(`Deleted ${sec.name}; its projects and sessions are kept`);
        } catch (e) {
          errorToast(e);
        }
      },
    },
  ];
  return (
    <div className="mb-3">
      <div className="group mx-2 flex h-[38px] items-center gap-1 rounded-lg bg-[#1e1e1e] pl-2.5 pr-1.5">
        {renaming ? (
          <InlineInput
            initial={sec.name}
            onDone={(name) => {
              setRenaming(false);
              if (name && name !== sec.name) void updateSection(host, sec.id, { name });
            }}
          />
        ) : (
          <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => useStore.setState((s) => ({ collapsed: { ...s.collapsed, [key]: !collapsed } }))}>
            <span className="truncate ui-text-14 font-semibold text-muted group-hover:text-fg">{sec.name}</span>
            {multiHost && host !== "local" && <span className="truncate font-mono ui-text-11 text-faint">@{host}</span>}
            {collapsed ? <ChevronRight size={13} className="text-faint" /> : <ChevronDown size={13} className="text-faint opacity-0 group-hover:opacity-100" />}
          </button>
        )}
        <Menu
          items={items}
          trigger={(open) => (
            <IconButton title="Section options" className="h-7 w-7" onClick={open}>
              <MoreHorizontal size={16} />
            </IconButton>
          )}
        />
      </div>
      {!collapsed && (
        <div className="pt-1">
          {groups.map((g) => (
            <GroupBlock key={g.key} host={host} workspaceId={ws.id} sec={sec} g={g} onRowMenu={(target, e) => onRowMenu({ x: e.clientX, y: e.clientY, host, section: sec, ...target })} />
          ))}
          {secProjects.length === 0 && (
            <button
              className="ml-4 mt-1 flex items-center gap-2 ui-text-13 text-faint hover:text-accent"
              onClick={() => useStore.setState({ dialog: { kind: "add-project", host, section: sec.id } })}
            >
              <FolderPlus size={14} /> Add a project to this section
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
  const { host, session: s, section: sec } = m;
  const items = s ? sessionItems(host, s) : m.projectId ? projectItems(host, m.projectId, sec) : [];
  return (
    <div
      className="fixed z-50 w-60 rounded-xl border border-border-strong bg-[#232323] p-1 shadow-2xl"
      style={{ left: Math.min(m.x, window.innerWidth - 250), top: Math.min(m.y, window.innerHeight - 220) }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <MenuItems items={items} onClose={onClose} />
      {s && <div className="px-3 pb-1 pt-1.5 ui-text-11.5 text-faint">Double-click a session to rename it</div>}
    </div>
  );
}

function projectItems(host: string, projectId: string, sec: Section): MenuItem[] {
  const { projects, sections } = useStore.getState();
  const project = (projects[host] ?? []).find((p) => p.id === projectId);
  if (!project) return [];
  const removal = projectRemoval(sections[host] ?? [], sec.id, project);
  return [
    { label: "Project settings…", icon: <Settings size={14} className="text-muted" />, onSelect: () => openProjectSettings({ host, project: projectId }) },
    { kind: "divider" },
    {
      label: removal.label,
      danger: true,
      onSelect: async () => {
        if (removal.confirm && !(await askConfirm({ title: "Remove project", message: removal.confirm, action: "Remove" }))) return;
        try {
          await rpc(host, M.sectionRemoveProject, { id: sec.id, project_id: projectId });
        } catch (e) {
          errorToast(e);
        }
      },
    },
  ];
}

function sessionItems(host: string, s: Session): MenuItem[] {
  return [
    { label: "Open", onSelect: () => selectSession(host, s.id) },
    { kind: "divider" },
    {
      label: "Archive",
      icon: <Archive size={14} className="text-muted" />,
      onSelect: () => {
        void archiveSession({ host, ws: s });
      },
    },
  ];
}

function HistoryList() {
  const hosts = useStore((s) => s.hosts);
  const sessions = useStore((s) => s.sessions);
  const archived = Object.keys(hosts).flatMap((h) => (sessions[h] ?? []).filter((w) => w.archived).map((w) => ({ host: h, w })));
  archived.sort((a, b) => b.w.created_at - a.w.created_at);
  return (
    <div>
      <div className="flex h-[34px] items-center pl-4 ui-text-12 font-medium uppercase tracking-[0.12em] text-muted">Archived sessions</div>
      {archived.length === 0 && <div className="px-[22px] py-1 ui-text-13 text-faint">Nothing archived yet.</div>}
      {archived.map(({ host, w }) => (
        <div key={host + w.id} className="group flex h-[38px] items-center gap-3 pl-[22px] pr-4 hover:bg-panel-2">
          <Archive size={13} className="text-faint" />
          <span className="min-w-0 flex-1 truncate ui-text-14 text-[#cfcfcf]">{w.name}</span>
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
    <div className="mx-3 mb-2 flex items-center gap-2 rounded-md bg-panel-2 px-2.5 py-1.5 ui-text-12">
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
        "no-drag flex h-[34px] w-full items-center gap-3 rounded-md px-3 text-left ui-text-14 transition-colors",
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
  const sections = useStore((s) => s.sections);
  const shown = useStore((s) => shownWorkspace(s));
  const showHistory = useStore((s) => s.showHistory);
  const [rowMenu, setRowMenu] = useState<RowMenuState | null>(null);
  const [creating, setCreating] = useState(false);
  const ordered = useMemo(() => Object.values(hosts).sort((a, b) => Number(a.remote) - Number(b.remote) || a.id.localeCompare(b.id)), [hosts]);

  return (
    <aside className="flex h-full flex-col bg-panel">
      {/* The traffic lights sit on the left of the title bar (X32). */}
      <div data-tauri-drag-region className="drag flex h-[52px] shrink-0 items-center pl-[78px] pr-2.5">
        <WorkspaceSwitcher />
      </div>
      <nav className="px-2 pb-3">
        <NavRow icon={<Plus size={15} strokeWidth={1.75} />} label="New session" hint="⇧⌘N" onClick={() => useStore.setState({ dialog: { kind: "new-session", host: shown?.host, workspace: shown?.id } })} />
        <NavRow icon={<Command size={15} strokeWidth={1.75} />} label="Run action" hint="⌘K" onClick={() => useStore.setState({ dialog: { kind: "palette" } })} />
        <NavRow icon={<History size={15} strokeWidth={1.75} />} label="History" active={showHistory} onClick={() => useStore.setState({ showHistory: !showHistory })} />
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {showHistory ? (
          <HistoryList />
        ) : (
          ordered.map((h) => (
            <div key={h.id}>
              <HostNotice host={h} />
              {hostSections(
                (workspaces[h.id] ?? []).filter((ws) => shown?.host === h.id && ws.id === shown.id),
                sections[h.id] ?? [],
              ).map(({ ws, sec }) => (
                <SectionBlock key={sec.id} host={h.id} ws={ws} sec={sec} onRowMenu={setRowMenu} />
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
                  placeholder="Section name"
                  onDone={async (name) => {
                    setCreating(false);
                    if (!name) return;
                    if (!shown) return;
                    try {
                      await rpc(shown.host, M.sectionCreate, { workspace_id: shown.id, name });
                    } catch (e) {
                      errorToast(e);
                    }
                  }}
                />
              </div>
            ) : (
              <button className="flex h-[34px] w-full items-center gap-3 rounded-md px-3 text-left ui-text-13.5 text-faint hover:bg-panel-2 hover:text-fg" onClick={() => setCreating(true)}>
                <Plus size={14} /> New section
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
