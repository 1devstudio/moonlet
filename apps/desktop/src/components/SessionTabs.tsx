// A session's tab row (X94): 36 px under its header, tabs that shrink to
// 112 px and then scroll with no scrollbar, a fade and a chevron on each side
// with tabs out of view, and All tabs, the list of every tab.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, FileDiff, LoaderCircle, Plus, X } from "lucide-react";
import { rpc } from "../lib/daemon";
import { diffModeLabel } from "../lib/changes";
import { leaves, type DiffMode, type Tab as LayoutTab } from "../lib/layout";
import { M, type ProjectConfig, type Session } from "../lib/protocol";
import { getLayout, projectOf, setLayout, sesKey, termKey, useStore } from "../lib/store";
import { closeDiffTab, closeFileTab, closeJobTab, closeTab, newAgentTab, newSessionAgentTab, newTab, split } from "../lib/actions";
import { filterTabs, hiddenTabs, revealScroll, scrollStep, tabEdges, tabStatus, type TabState, type TabTone, wheelScroll } from "../lib/tabOverflow";
import { chipFromJob, going } from "../lib/jobs";
import { useSessionJob, useSessionJobs } from "../lib/jobsStore";
import { agentLabel } from "../lib/agents";
import { copyOffers } from "../lib/centralCopies";
import { FileIcon } from "./FileIcon";
import { WorkerIcon } from "./JobsPanel";
import { AgentIcon, Kbd, cx } from "./ui";

/** Shows a tab, focusing its first terminal when it has one. */
const show = (host: string, ws: string, id: string, focused: number | null) => setLayout(host, ws, { ...getLayout(host, ws), active: id, focused });

/** One tab: 32 px high, up to 184 px wide, down to 112; the one shown is filled with the pane's tone and joins it, its close button showing (X94). */
function TabFrame({
  id,
  active,
  title,
  icon,
  children,
  onShow,
  onClose,
}: {
  id: string;
  active: boolean;
  title?: string;
  icon: ReactNode;
  children: ReactNode;
  onShow: () => void;
  onClose: () => void;
}) {
  return (
    <div
      data-tab={id}
      role="tab"
      aria-selected={active}
      aria-current={active || undefined}
      title={title}
      className={cx(
        "session-tab group relative flex h-full cursor-default items-center rounded-t-[8px]",
        active ? "bg-bg font-medium text-fg" : "text-muted hover:bg-tab-hover hover:text-fg",
      )}
      onMouseDown={onShow}
    >
      <span className="flex h-full min-w-0 flex-1 items-center gap-2 pl-3 pr-1 ui-text-13">
        {icon}
        {children}
      </span>
      <button
        className={cx(
          "mr-1.5 flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg focus-visible:opacity-100",
          active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
        title="Close tab"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={onClose}
      >
        <X size={12} />
      </button>
    </div>
  );
}

function TerminalTab({ host, ws, id, ids, active }: { host: string; ws: Session; id: string; ids: number[]; active: boolean }) {
  const info = useStore((s) => s.terminals[host]?.[ids[0]]);
  const unread = useStore((s) => ids.some((x) => s.unread[termKey(host, x)]));
  const state = info?.kind === "agent" && !info.exit ? info.agent_state : null;
  const name = info ? (info.agent ?? info.title) : "…";
  return (
    <TabFrame
      id={id}
      active={active}
      icon={<AgentIcon agent={info?.kind === "agent" ? info.agent : null} size={14} />}
      onShow={() => show(host, ws.id, id, ids[0])}
      onClose={() => void closeTab(host, ids)}
    >
      <span className={cx("truncate", unread && "font-semibold text-fg")}>{name}</span>
      {ids.length > 1 && <span className="shrink-0 font-mono ui-text-11 font-normal text-faint">+{ids.length - 1}</span>}
      {state === "blocked" && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blocked" title="needs input" />}
      {state === "working" && (
        <span className="moonlet-dots shrink-0" title="working">
          <i />
          <i />
          <i />
        </span>
      )}
      {info?.exit && <span className="min-w-0 shrink-[100] truncate font-mono ui-text-11 font-normal text-faint">exited</span>}
    </TabFrame>
  );
}

/** A file's editor tab (X26): a dot while it has unsaved edits. */
function FileTab({ host, ws, id, path, active }: { host: string; ws: Session; id: string; path: string; active: boolean }) {
  const dirty = useStore((s) => !!s.dirtyFiles[`${host}|${path}`]);
  const name = path.split("/").pop() ?? path;
  return (
    <TabFrame id={id} active={active} title={path} icon={<FileIcon name={name} />} onShow={() => show(host, ws.id, id, null)} onClose={() => void closeFileTab(host, ws.id, path)}>
      <span className="truncate">{name}</span>
      {dirty && <span aria-label="unsaved" className="h-1.5 w-1.5 shrink-0 rounded-full bg-fg" />}
    </TabFrame>
  );
}

/** A changed file's diff tab (X77): the name, and which changes it compares. */
function DiffTab({ host, ws, id, path, mode, active }: { host: string; ws: Session; id: string; path: string; mode: DiffMode; active: boolean }) {
  const name = path.split("/").pop() ?? path;
  return (
    <TabFrame
      id={id}
      active={active}
      title={`${path} — ${diffModeLabel(mode, ws.base)}`}
      icon={<FileDiff size={14} strokeWidth={1.5} className="shrink-0" />}
      onShow={() => show(host, ws.id, id, null)}
      onClose={() => closeDiffTab(host, ws.id, path, mode)}
    >
      <span className="truncate">{name}</span>
      {mode === "head" && <span className="min-w-0 shrink-[100] truncate ui-text-11 font-normal text-faint">uncommitted</span>}
    </TabFrame>
  );
}

/** A job's tab (X62): where it runs, its command and how it is going. */
function JobTab({ host, ws, id, job, active }: { host: string; ws: Session; id: string; job: string; active: boolean }) {
  const j = useSessionJob(host, ws.id, job);
  const s = j?.state;
  return (
    <TabFrame
      id={id}
      active={active}
      title={j?.command}
      icon={j ? <WorkerIcon icon={chipFromJob(j).icon} size={14} /> : null}
      onShow={() => show(host, ws.id, id, null)}
      onClose={() => closeJobTab(host, ws.id, job)}
    >
      <span className="truncate font-mono ui-text-12.5">{j?.command ?? "Job"}</span>
      {j && going(j) ? (
        <LoaderCircle aria-label="running" size={12} className="shrink-0 animate-spin text-accent" />
      ) : s?.kind === "done" && s.exit === 0 ? (
        <Check aria-label="done" size={13} className="shrink-0 text-done" />
      ) : s ? (
        <X aria-label="failed" size={13} className="shrink-0 text-error" />
      ) : null}
    </TabFrame>
  );
}

function SessionTab({ host, ws, tab, active }: { host: string; ws: Session; tab: LayoutTab; active: boolean }) {
  const r = tab.root;
  if (r.type === "file") return <FileTab host={host} ws={ws} id={tab.id} path={r.path} active={active} />;
  if (r.type === "diff") return <DiffTab host={host} ws={ws} id={tab.id} path={r.path} mode={r.mode} active={active} />;
  if (r.type === "job") return <JobTab host={host} ws={ws} id={tab.id} job={r.job} active={active} />;
  return <TerminalTab host={host} ws={ws} id={tab.id} ids={leaves(r)} active={active} />;
}

const TONE: Record<TabTone, string> = {
  working: "bg-working border-working",
  blocked: "bg-blocked border-blocked",
  done: "bg-done border-done",
  error: "bg-error border-error",
  unsaved: "bg-fg border-fg",
  idle: "border-idle",
};

/** Every tab of the session, filterable, with its status; and what a new tab can be (X94). */
function AllTabs({ host, ws, onClose }: { host: string; ws: Session; onClose: () => void }) {
  const layout = useStore((s) => s.layouts[sesKey(host, ws.id)]);
  const terminals = useStore((s) => s.terminals[host]);
  const dirty = useStore((s) => s.dirtyFiles);
  const jobs = useSessionJobs(host, ws.id);
  const repo = useStore((s) => projectOf(s, host, ws));
  const [agents, setAgents] = useState<string[]>(["claude", "codex"]);
  const [q, setQ] = useState("");
  const newTabs = copyOffers(host).newTabs;
  useEffect(() => {
    if (!newTabs || !repo) return;
    void rpc<ProjectConfig>(host, M.projectConfig, { id: repo.id })
      .then((c) => setAgents(["claude", "codex", ...Object.keys(c.agents ?? {}).filter((a) => a !== "claude" && a !== "codex")]))
      .catch(() => {});
  }, [newTabs, host, repo]);

  const rows = (layout?.tabs ?? []).map((t) => {
    const r = t.root;
    let name: string;
    let state: TabState;
    let focused: number | null = null;
    if (r.type === "file") {
      name = r.path.split("/").pop() ?? r.path;
      state = { kind: "file", dirty: !!dirty[`${host}|${r.path}`] };
    } else if (r.type === "diff") {
      name = r.path.split("/").pop() ?? r.path;
      state = { kind: "diff" };
    } else if (r.type === "job") {
      const j = jobs.find((x) => x.id === r.job);
      name = j?.command ?? "Job";
      state = { kind: "job", state: j?.state };
    } else {
      focused = leaves(r)[0];
      const info = terminals?.[focused];
      name = info ? (info.agent ?? info.title) : "…";
      state = { kind: "terminal", agentState: info?.kind === "agent" ? info.agent_state : null, exited: !!info?.exit };
    }
    return { id: t.id, name, focused, status: tabStatus(state) };
  });
  const shown = filterTabs(rows, q);
  const item = (key: string, content: ReactNode, run: () => void, kbd?: string) => (
    <button
      key={key}
      className="flex h-[30px] w-full shrink-0 items-center gap-2.5 rounded-md px-2 text-left ui-text-13 text-fg hover:bg-hover"
      onClick={() => {
        onClose();
        run();
      }}
    >
      {content}
      {kbd && (
        <span className="ml-auto">
          <Kbd>{kbd}</Kbd>
        </span>
      )}
    </button>
  );
  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div
        role="dialog"
        aria-label="All tabs"
        className="absolute right-1.5 top-full z-40 mt-1 flex w-[280px] flex-col gap-px rounded-[10px] border border-border-strong bg-panel-2 p-1.5 shadow-2xl"
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <input
          autoFocus
          aria-label="Filter tabs"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Filter ${rows.length} tab${rows.length === 1 ? "" : "s"}`}
          className="mb-1 h-[30px] rounded-md border border-border-strong bg-bg px-2.5 ui-text-12.5 text-fg outline-none placeholder:text-faint focus:border-accent"
        />
        <div role="listbox" aria-label="Tabs" className="flex max-h-[252px] flex-col gap-px overflow-y-auto">
          {shown.map((t) => (
            <button
              key={t.id}
              role="option"
              aria-selected={t.id === layout?.active}
              className={cx("flex h-[30px] shrink-0 items-center gap-2 rounded-md px-2 text-left ui-text-13", t.id === layout?.active ? "bg-hover text-fg" : "text-fg/85 hover:bg-hover")}
              onClick={() => {
                onClose();
                show(host, ws.id, t.id, t.focused);
              }}
            >
              <span aria-hidden="true" className={cx("h-[7px] w-[7px] shrink-0 rounded-full border", TONE[t.status.tone])} />
              <span className="min-w-0 flex-1 truncate">{t.name}</span>
              {t.status.label && <span className="shrink-0 ui-text-11.5 text-faint">{t.status.label}</span>}
            </button>
          ))}
          {!shown.length && <div className="px-2.5 py-2 ui-text-12.5 text-faint">No tabs match</div>}
        </div>
        {newTabs && (
          <>
            <div className="my-1 border-t border-border" />
            {agents.map((a) =>
              item(
                a,
                <>
                  <AgentIcon agent={a} size={13} /> {agentLabel(a)}
                </>,
                () => void newAgentTab(a),
              ),
            )}
            {item("term", <>Terminal</>, () => void newTab(), "⇧⌘T")}
            {item("split-r", <>Split right</>, () => void split("row"), "⌘D")}
            {item("split-d", <>Split down</>, () => void split("col"), "⌥⌘D")}
          </>
        )}
      </div>
    </>
  );
}

/** The session's tab row, under its header (X94). */
export function TabStrip({ host, ws }: { host: string; ws: Session }) {
  const layout = useStore((s) => s.layouts[sesKey(host, ws.id)]);
  const row = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const [hidden, setHidden] = useState(0);
  const [open, setOpen] = useState(false);

  const measure = useCallback(() => {
    const el = row.current;
    if (!el) return;
    const e = tabEdges(el);
    setEdges((p) => (p.left === e.left && p.right === e.right ? p : e));
    setHidden(hiddenTabs(el.getBoundingClientRect(), [...el.querySelectorAll<HTMLElement>("[data-tab]")].map((t) => t.getBoundingClientRect())));
  }, []);

  const ids = layout?.tabs.map((t) => t.id).join(",") ?? "";
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // A smooth scroll's last scroll event can be skipped (WebKit, the window in the background): measure where it ends too.
    el.addEventListener("scrollend", measure);
    return () => {
      ro.disconnect();
      el.removeEventListener("scrollend", measure);
    };
  }, [measure, ids]);

  /** Scrolls the row smoothly, measuring again while it settles: WebKit has no scrollend, and a window in the background scrolls slowly. */
  const scroll = (el: HTMLElement, to: ScrollToOptions, by = false) => {
    if (by) el.scrollBy(to);
    else el.scrollTo(to);
    for (const ms of [150, 400, 800, 1200]) window.setTimeout(measure, ms);
  };

  // The tab shown scrolls into view when it changes or a tab opens.
  useEffect(() => {
    const el = row.current;
    const t = el?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(layout?.active ?? "")}"]`);
    if (!el || !t) return;
    const to = revealScroll(t, el);
    if (to !== null) scroll(el, { left: to, behavior: "auto" });
  }, [layout?.active, ids]); // eslint-disable-line react-hooks/exhaustive-deps

  const by = (d: number) => {
    const el = row.current;
    if (el) scroll(el, { left: d * scrollStep(el.clientWidth), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }, true);
  };

  return (
    <div className="relative flex h-ui-36 shrink-0 items-end pl-[10px]">
      <div className="relative flex h-ui-32 min-w-0 flex-1">
        <div
          ref={row}
          role="tablist"
          aria-label="Session tabs"
          className="no-scrollbar flex min-w-0 flex-1 items-stretch gap-[2px] overflow-x-auto overflow-y-hidden"
          onScroll={measure}
          onWheel={(e) => {
            const d = wheelScroll(e.deltaX, e.deltaY);
            if (d && row.current) row.current.scrollLeft += d;
          }}
        >
          {layout?.tabs.map((t) => <SessionTab key={t.id} host={host} ws={ws} tab={t} active={t.id === layout.active} />)}
        </div>
        {edges.left && (
          <>
            <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-14 bg-gradient-to-r from-window from-40% to-transparent" />
            <button aria-label="Scroll tabs left" className="absolute left-1 top-[4px] flex h-[24px] w-[24px] items-center justify-center rounded-md bg-window text-muted hover:bg-raised hover:text-fg" onClick={() => by(-1)}>
              <ChevronLeft size={14} />
            </button>
          </>
        )}
        {edges.right && (
          <>
            <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-14 bg-gradient-to-l from-window from-40% to-transparent" />
            <button aria-label="Scroll tabs right" className="absolute right-1 top-[4px] flex h-[24px] w-[24px] items-center justify-center rounded-md bg-window text-muted hover:bg-raised hover:text-fg" onClick={() => by(1)}>
              <ChevronRight size={14} />
            </button>
          </>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 self-center px-1.5">
        {copyOffers(host).newTabs && (
          <button title="New agent (⌘T)" className="flex h-[28px] w-[28px] items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg" onClick={() => void newSessionAgentTab()}>
            <Plus size={14} strokeWidth={2} />
          </button>
        )}
        <button
          title="All tabs"
          aria-label="All tabs"
          aria-expanded={open}
          className={cx("flex h-[28px] min-w-[28px] items-center justify-center gap-1 rounded-md px-1.5 text-muted hover:bg-hover hover:text-fg", open && "bg-hover text-fg")}
          onClick={() => setOpen(!open)}
        >
          {hidden > 0 && (
            <span aria-label={`${hidden} out of view`} className="rounded bg-border-strong px-[5px] font-mono ui-text-11 leading-4 text-fg">
              {hidden}
            </span>
          )}
          <ChevronDown size={14} />
        </button>
      </div>
      {open && <AllTabs host={host} ws={ws} onClose={() => setOpen(false)} />}
    </div>
  );
}
