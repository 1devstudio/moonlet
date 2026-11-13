import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronDown, ExternalLink, Layers, MoreHorizontal, Play, Plus } from "lucide-react";
import { hostsApi, rpc } from "../lib/daemon";
import { M, type PrStack, type ProjectConfig, type Session } from "../lib/protocol";
import { errorToast, pollPr, projectOf, type RightTab, useStore, sesKey } from "../lib/store";
import { archiveSession, openProjectSettings, runScript } from "../lib/actions";
import { latestOnly, stackView, type StackView } from "../lib/prStack";
import { hasRunCommand } from "../lib/projectSettings";
import { workspaceOpenIn } from "../lib/openIn";
import { useSync } from "../lib/syncStore";
import { chatKey, chatSummary, loadChatSummaries, useChat, useChatOnScreen } from "../lib/chat";
import { planChat, planTabDot, planView, planWaits } from "../lib/plan";
import { agentRows, agentsTabClockRuns, agentsTabDot } from "../lib/subagents";
import { grantMenuLabel } from "../lib/terminalRead";
import { ChecksPanel } from "./ChecksPanel";
import { PlanPanel } from "./PlanPanel";
import { AgentsPanel } from "./AgentsPanel";
import { JobsPanel } from "./JobsPanel";
import { ProcessesPanel } from "./ProcessesPanel";
import { useSessionJobs } from "../lib/jobsStore";
import { jobsTabCount } from "../lib/jobs";
import { fitViews } from "../lib/viewOverflow";
import { FileLinks, useProjectFiles } from "./AgentView";
import { useNow } from "../lib/useNow";
import { FilesPanel } from "./FilesPanel";
import { cx, prTone } from "./ui";
import { TaskTab, useSessionTask } from "./tasks/SessionTask";
import { SessionDesignTab } from "./design/SessionDesign";
import { designTab } from "../lib/sessionDesign";
import { pickDesignTab, sessionDesignsOf, useDesign } from "../lib/designStore";
import { copyOffers } from "../lib/centralCopies";
import { ScrollArea } from "./ScrollArea";

const ChangesPanel = lazy(() => import("./ChangesPanel"));

const TABS: { id: RightTab; label: string }[] = [
  { id: "plan", label: "Plan" },
  { id: "agents", label: "Agents" },
  { id: "files", label: "Files" },
  { id: "changes", label: "Changes" },
  { id: "review", label: "Review" },
];

function MoreMenu({ host, ws }: { host: string; ws: Session }) {
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    if (open && !targets.length) void hostsApi.openTargets().then(setTargets);
  }, [open, targets.length]);
  const remote = host !== "local";
  const askAgain = useStore((s) => grantMenuLabel(s.readGrants, host, ws.id));
  const kind = useStore((s) => s.hosts[host]?.kind) ?? (remote ? "ssh" : "local");
  // A session kept in sync opens its copy on this Mac (X60).
  const copyPath = useSync((s) => s.copies[sesKey(host, ws.id)]?.path || null);
  const openIn = workspaceOpenIn(targets, { kind, host, path: ws.path }, copyPath);
  // A copy of another member's session offers only what it can ask it (X88).
  const offers = copyOffers(host);
  const item = (label: string, run: () => void, danger = false) => (
    <button
      key={label}
      className={cx("block w-full px-3 py-1.5 text-left ui-text-13 hover:bg-hover", danger && "text-error")}
      onClick={() => {
        setOpen(false);
        run();
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="no-drag relative">
      <button title="More" className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg" onClick={() => setOpen(!open)}>
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-40 mt-1 w-52 overflow-hidden rounded-lg border border-border-strong bg-panel-2 py-1 shadow-2xl">
            {offers.openIn && openIn.choices.map((t) => item(`Open in ${t.label}`, () => void hostsApi.openIn(t.id, openIn.path, openIn.host).catch(errorToast)))}
            {offers.openIn && <div className="my-1 border-t border-border" />}
            {item("Commit…", () => useStore.setState({ dialog: { kind: "commit" } }))}
            {offers.setup && item("Re-run setup script", () => void runScript("setup"))}
            {offers.processes && item("Processes…", () => useStore.setState({ rightTab: "processes", rightOpen: true }))}
            {offers.projectSettings && item("Project settings…", () => openProjectSettings({ host, project: ws.project_id }))}
            {item("Toggle sidebar  ⌘B", () => useStore.setState((s) => ({ sidebarOpen: !s.sidebarOpen })))}
            {askAgain && item(askAgain, () => void rpc(host, M.terminalReadGrantClear, { session_id: ws.id }).catch(errorToast))}
            <div className="my-1 border-t border-border" />
            {item("Archive session…", () => void archiveSession(), true)}
          </div>
        </>
      )}
    </div>
  );
}

function PrIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" className={className} fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="12.5" r="1.6" />
      <path d="M4 5.1v5.8M12 10.9V7a2.5 2.5 0 0 0-2.5-2.5H7m0 0 1.6-1.6M7 4.5l1.6 1.6" />
    </svg>
  );
}

/** Position in the GitHub stack and its PRs, top of the stack first (spec X11). */
function StackMenu({ view, current }: { view: StackView; current: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="no-drag relative">
      <button
        className="flex h-8 items-center gap-1.5 rounded-md px-2.5 ui-text-14 text-fg hover:bg-raised"
        title={`Stack of ${view.size} pull requests`}
        onClick={() => setOpen(!open)}
      >
        <Layers size={13} className="text-muted" />
        <span className="tabular-nums">
          {view.position}/{view.size}
        </span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-40 mt-1 max-h-[60vh] w-[360px] overflow-y-auto rounded-lg border border-border-strong bg-panel-2 py-1 shadow-2xl">
            {view.rows.map((p) => (
              <button
                key={p.number}
                title={`${p.title} · Open in browser`}
                className={cx("flex w-full items-start gap-2.5 px-3 py-1.5 text-left hover:bg-hover", p.number === current && "bg-raised")}
                onClick={() => {
                  setOpen(false);
                  void openUrl(p.url);
                }}
              >
                <PrIcon className={cx("mt-1 shrink-0", prTone(p.state))} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate ui-text-13 text-fg">{p.title}</span>
                  <span className="block truncate ui-text-12 text-muted">
                    #{p.number} · {p.branch}
                    {p.draft && " · draft"}
                  </span>
                </span>
                {p.number === current && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-fg" title="This session's pull request" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TopActions({ host, ws }: { host: string; ws: Session }) {
  const repo = useStore((s) => projectOf(s, host, ws));
  const [config, setConfig] = useState<ProjectConfig | null>(null);
  // Shared with the sidebar and Checks tab, so whichever poll sees a change first updates all three.
  const pr = useStore((s) => s.prs[sesKey(host, ws.id)] ?? null);
  const [stack, setStack] = useState<PrStack | null>(null);
  const view = useMemo(() => stackView(stack, pr?.number), [stack, pr?.number]);
  useEffect(() => {
    if (repo) void rpc<ProjectConfig>(host, M.projectConfig, { id: repo.id }).then(setConfig).catch(() => setConfig(null));
  }, [host, repo]);
  useEffect(() => {
    let live = true;
    const polls = latestOnly();
    const load = () => {
      const isLatest = polls.start();
      const latest = () => live && isLatest();
      void pollPr(host, ws.id, ws.path)
        .then((p) => {
          if (!latest()) return;
          if (!p) return setStack(null);
          void rpc<PrStack | null>(host, M.prStack, { path: ws.path, number: p.number })
            .then((st) => latest() && setStack(st))
            .catch(() => latest() && setStack(null));
        })
        .catch(() => {
          /* keeps the last known PR and stack, as the sidebar's poll does */
        });
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [host, ws.id, ws.path]);
  return (
    <div data-tauri-drag-region className="drag @container flex h-ui-44 shrink-0 items-center gap-1 px-4">
      <button
        className={cx(
          "no-drag flex h-8 items-center gap-2 rounded-md bg-raised px-2.5 ui-text-14 hover:bg-hover @max-[340px]:px-2",
          hasRunCommand(config) ? "text-fg" : "text-faint hover:text-fg",
        )}
        title={hasRunCommand(config) ? `Run: ${config?.run} (⌘R)` : "Set a run command…"}
        onClick={() => (hasRunCommand(config) ? void runScript("run") : openProjectSettings({ host, project: ws.project_id }, "run"))}
      >
        <Play size={13} fill="currentColor" strokeWidth={0} />
        <span className="@max-[340px]:hidden">Run</span>
      </button>
      {pr && view && <StackMenu view={view} current={pr.number} />}
      <button
        className="no-drag group flex h-8 min-w-0 items-center gap-2 whitespace-nowrap rounded-md px-2.5 ui-text-14 text-fg hover:bg-raised"
        title={pr ? `#${pr.number} ${pr.title} · Open in browser` : "Create pull request (⇧⌘P)"}
        onClick={() => (pr ? void openUrl(pr.url) : useStore.setState({ dialog: { kind: "create-pr" } }))}
      >
        <PrIcon className={pr ? prTone(pr.state) : "text-accent"} />
        {/* Narrow, the PR drops its word, then its state (X94). */}
        <span className={cx(pr && "@max-[400px]:hidden")}>PR</span>
        {pr && <span className="text-muted">#{pr.number}</span>}
        {pr && pr.state !== "open" && <span className={cx(prTone(pr.state), "@max-[340px]:hidden")}>· {pr.state}</span>}
        {pr ? (
          <ExternalLink size={11} className="text-faint opacity-0 group-hover:opacity-100" />
        ) : (
          <Plus size={12} className="text-faint opacity-0 group-hover:opacity-100" />
        )}
      </button>
      <span className="ml-auto" />
      <MoreMenu host={host} ws={ws} />
    </div>
  );
}

/** The latest plan of the session's chat the Plan tab follows (X24), read
 *  while the tab is `open`, and whether a plan waits. */
function useSessionPlan(host: string, ws: Session, open: boolean) {
  // A string, so the selector result compares by value.
  const ids = useStore((s) =>
    Object.values(s.terminals[host] ?? {})
      .filter((t) => t.session_id === ws.id && t.chat && !t.exit)
      .map((t) => t.id)
      .join(","),
  );
  const focused = useStore((s) => s.layouts[sesKey(host, ws.id)]?.focused ?? null);
  const chatId = useChat((s) =>
    planChat(
      focused,
      ids ? ids.split(",").map((id) => ({ id: Number(id), st: chatSummary(s, host, Number(id)) })) : [],
    ),
  );
  // The plan is read from the chat's items, which the open Plan tab shows;
  // closed, the tab's dot reads the chat's asks (X81).
  const st = useChat((s) => (chatId === null ? undefined : s.chats[chatKey(host, chatId)]));
  const waits = useChat((s) => chatId !== null && planWaits(chatSummary(s, host, chatId)));
  useChatOnScreen(host, chatId, open);
  const view = useMemo(() => (st ? planView(st) : null), [st]);
  return { view, waits };
}

/** The subagents of every chat in the session (X42), loading chats not yet
 *  loaded. Their clock ticks only while `tab`, the panel's tab shown, is
 *  Agents (X82). */
function useSessionAgents(host: string, ws: Session, tab: RightTab) {
  const ids = useStore((s) =>
    Object.values(s.terminals[host] ?? {})
      .filter((t) => t.session_id === ws.id && t.chat && !t.exit)
      .map((t) => t.id)
      .join(","),
  );
  const list = useMemo(() => (ids ? ids.split(",").map(Number) : []), [ids]);
  // Each chat's subagents and asks, which change only on `chat.state`, so
  // streaming text does not re-render the panel. Undefined until loaded,
  // read for every chat of the host at once, without items (X81).
  const subagents = useChat(useShallow((s) => list.map((id) => chatSummary(s, host, id)?.subagents)));
  const pending = useChat(useShallow((s) => list.map((id) => chatSummary(s, host, id)?.pending)));
  const unloaded = list.filter((_, i) => pending[i] === undefined).join(",");
  useEffect(() => {
    if (unloaded) void loadChatSummaries(host).catch(() => {});
  }, [host, unloaded]);
  const now = useNow(agentsTabClockRuns(tab, subagents));
  const rows = useMemo(
    () => agentRows(list.map((id, i) => ({ id, st: pending[i] && { subagents: subagents[i], pending: pending[i] } })), now),
    [list, subagents, pending, now],
  );
  return { rows, now };
}

/** The px between two views, and before More. */
const VIEW_GAP = 2;

/**
 * The right panel's views, 36 px, as tabs like the session's: 32 px, the one shown filled with the pane's tone (X94). Those that do not fit go into More,
 * the last first; the view shown always stays in the row, in its place.
 */
function ViewTabs({ tabs, shown, pick, extra }: { tabs: { id: RightTab; label: string }[]; shown: RightTab; pick: (id: RightTab) => void; extra: (id: RightTab) => ReactNode }) {
  const row = useRef<HTMLDivElement>(null);
  const sizer = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ shown: number[]; more: number[] } | null>(null);
  const [open, setOpen] = useState(false);
  const active = tabs.findIndex((t) => t.id === shown);
  const key = tabs.map((t) => t.id).join(",");
  const measure = useCallback(() => {
    const r = row.current;
    const m = sizer.current;
    if (!r || !m) return;
    const widths = [...m.querySelectorAll<HTMLElement>("[data-view]")].map((e) => e.offsetWidth);
    const more = m.querySelector<HTMLElement>("[data-more]")?.offsetWidth ?? 0;
    const next = fitViews(widths, active, r.clientWidth, more, VIEW_GAP);
    setFit((p) => (p && p.shown.join() === next.shown.join() && p.more.join() === next.more.join() ? p : next));
  }, [active]);
  useLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (row.current) ro.observe(row.current);
    if (sizer.current) ro.observe(sizer.current);
    return () => ro.disconnect();
  }, [measure, key]);
  const visible = fit ? fit.shown.filter((i) => i < tabs.length) : tabs.map((_, i) => i);
  const hidden = fit ? fit.more.filter((i) => i < tabs.length) : [];
  const view = (t: { id: RightTab; label: string }) => (
    <span className="flex items-center gap-1.5">
      {t.label}
      {extra(t.id)}
    </span>
  );
  return (
    <div className="relative flex h-ui-36 shrink-0 items-end px-2">
      <div ref={row} role="tablist" className="flex h-ui-32 min-w-0 flex-1 items-stretch overflow-hidden" style={{ gap: VIEW_GAP }}>
        {visible.map((i) => {
          const t = tabs[i];
          return (
            <button
              key={t.id}
              id={`right-tab-${t.id}`}
              role="tab"
              aria-selected={shown === t.id}
              aria-controls="right-tabpanel"
              onClick={() => pick(t.id)}
              className={cx(
                "relative flex shrink-0 items-center rounded-t-[8px] px-3 ui-text-13 transition-colors",
                shown === t.id ? "bg-bg font-medium text-fg" : "text-muted hover:bg-tab-hover hover:text-fg",
              )}
            >
              {view(t)}
            </button>
          );
        })}
        {hidden.length > 0 && (
          <div className="relative ml-auto flex shrink-0 items-center pr-0.5">
            <button
              aria-label={`More views, ${hidden.length}`}
              aria-expanded={open}
              className={cx("flex h-7 items-center gap-1 rounded-md pl-2 pr-1.5 ui-text-13 text-muted hover:bg-hover hover:text-fg", open && "bg-hover text-fg")}
              onClick={() => setOpen(!open)}
            >
              More
              <span className="rounded bg-border-strong px-[5px] font-mono ui-text-11 leading-4 text-fg">{hidden.length}</span>
              <ChevronDown size={12} />
            </button>
          </div>
        )}
      </div>
      {/* Every view and More at their own width, out of sight, to measure the row by; after the row, so its copies of the views' dots come second. */}
      <div ref={sizer} aria-hidden="true" className="invisible absolute flex h-0 overflow-hidden whitespace-nowrap">
        {tabs.map((t) => (
          <span key={t.id} data-view className="flex shrink-0 items-center gap-1.5 px-3 ui-text-13 font-medium">
            {view(t)}
          </span>
        ))}
        <span data-more className="flex shrink-0 items-center gap-1 pl-2 pr-1.5 ui-text-13">
          More <span className="px-[5px] font-mono ui-text-11">{tabs.length}</span> <ChevronDown size={12} />
        </span>
      </div>
      {open && hidden.length > 0 && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div role="menu" aria-label="More views" className="absolute right-1.5 top-full z-40 mt-1 flex w-[200px] flex-col gap-px rounded-[10px] border border-border-strong bg-panel-2 p-1.5 shadow-2xl">
            {hidden.map((i) => (
              <button
                key={tabs[i].id}
                role="menuitem"
                className="flex h-[30px] items-center rounded-md px-2 text-left ui-text-13 text-fg hover:bg-hover"
                onClick={() => {
                  setOpen(false);
                  pick(tabs[i].id);
                }}
              >
                {view(tabs[i])}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function RightPanel({ host, ws }: { host: string; ws: Session }) {
  // The Task tab is there for a session linked to a task (X46); otherwise Files stands in.
  const linked = !!useSessionTask(host, ws);
  const chosen = useStore((s) => s.rightTab);
  // The Jobs tab is there once the session has routed a command (X62).
  const jobs = useSessionJobs(host, ws.id);
  // The Design tab is there for a session with a design (X65), after the others.
  const designs = useDesign((d) => sessionDesignsOf(d, host, ws.id));
  const design = designTab(designs);
  // A copy of another member's session has no Files or Processes (X88).
  const offers = copyOffers(host);
  const fallback = offers.files ? "files" : "changes";
  const picked = (chosen === "task" && !linked) || (chosen === "jobs" && !jobs.length) || (chosen === "design" && !design) ? fallback : chosen;
  const tab = (picked === "files" && !offers.files) || (picked === "processes" && !offers.processes) ? "changes" : picked;
  const base = offers.files ? TABS : TABS.filter((t) => t.id !== "files");
  const withJobs = jobs.length ? base.flatMap((t) => (t.id === "agents" ? [t, { id: "jobs" as const, label: "Jobs" }] : [t])) : base;
  const withDesign = design ? [...withJobs, { id: "design" as const, label: "Design" }] : withJobs;
  // The Processes tab shows while it is the chosen one, picked from the ⋯ menu (X83).
  const shown = tab === "processes" ? [...withDesign, { id: "processes" as const, label: "Processes" }] : withDesign;
  const tabs = linked ? [{ id: "task" as const, label: "Task" }, ...shown] : shown;
  const { view: plan, waits: planWaiting } = useSessionPlan(host, ws, tab === "plan");
  const agents = useSessionAgents(host, ws, tab);
  // Plan file links (X30) check the worktree while the Plan tab shows, and again whenever the plan changes.
  const exists = useProjectFiles(host, tab === "plan" ? ws.path : "", plan?.plan);

  // Watch the worktree for live refresh of Files and Changes.
  useEffect(() => {
    void rpc(host, M.fsWatch, { path: ws.path }).catch(() => {});
    return () => void rpc(host, M.fsUnwatch, { path: ws.path }).catch(() => {});
  }, [host, ws.path]);

  return (
    <div className="flex h-full flex-col">
      <TopActions host={host} ws={ws} />
      <ViewTabs
        tabs={tabs}
        shown={tab}
        // The Agents tab always opens on its list (X42); the Design tab
        // is entered, its canvas's keys working at once (X65).
        pick={(id) =>
          id === "design"
            ? pickDesignTab(host, ws.id)
            : useStore.setState(id === "agents" ? { rightTab: id, agentDetail: null } : id === "jobs" ? { rightTab: id, jobDetail: null } : { rightTab: id })
        }
        extra={(id) =>
          id === "jobs" ? (
            <span className="ui-text-12 font-normal tabular-nums text-faint">{jobsTabCount(jobs)}</span>
          ) : id === "design" && !!design?.count ? (
            <span aria-label={`${design.count} open comments`} className="ui-text-12 font-normal tabular-nums text-faint">
              {design.count}
            </span>
          ) : id === "plan" && planTabDot(tab, planWaiting) ? (
            <span aria-label="plan waiting" className="h-1.5 w-1.5 rounded-full bg-blocked" />
          ) : id === "agents" && agentsTabDot(tab, agents.rows) ? (
            <span aria-label="agent waiting" className="h-1.5 w-1.5 rounded-full bg-blocked" />
          ) : null
        }
      />
      <ScrollArea
        id="right-tabpanel"
        role="tabpanel"
        aria-labelledby={`right-tab-${tab}`}
        frame="overflow-hidden rounded-[10px]"
        // The Design tab fills the pane with its own canvas and rail, unscrolled.
        className={cx("rounded-[10px] bg-bg", tab === "design" && "flex flex-col !overflow-hidden")}
      >
        <Suspense fallback={null}>
          {tab === "design" ? (
            <SessionDesignTab host={host} ws={ws} />
          ) : tab === "task" ? (
            <TaskTab host={host} ws={ws} />
          ) : tab === "plan" ? (
            <FileLinks.Provider value={{ host, wsId: ws.id, cwd: ws.path, exists }}>
              <PlanPanel view={plan} />
            </FileLinks.Provider>
          ) : tab === "agents" ? (
            <FileLinks.Provider value={{ host, wsId: ws.id, cwd: ws.path, exists }}>
              <AgentsPanel host={host} cwd={ws.path} rows={agents.rows} now={agents.now} />
            </FileLinks.Provider>
          ) : tab === "processes" ? (
            <ProcessesPanel host={host} ws={ws} />
          ) : tab === "jobs" ? (
            <JobsPanel host={host} ws={ws} jobs={jobs} />
          ) : tab === "files" ? (
            <FilesPanel host={host} ws={ws} />
          ) : tab === "changes" ? (
            <ChangesPanel host={host} ws={ws} />
          ) : (
            <ChecksPanel host={host} ws={ws} />
          )}
        </Suspense>
      </ScrollArea>
    </div>
  );
}
