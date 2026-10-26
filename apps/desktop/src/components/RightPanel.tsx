import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Layers, MoreHorizontal, Play, Plus } from "lucide-react";
import { hostsApi, rpc } from "../lib/daemon";
import { M, type PrStack, type ProjectConfig, type Session } from "../lib/protocol";
import { errorToast, pollPr, projectOf, type RightTab, useStore, sesKey } from "../lib/store";
import { archiveSession, openProjectSettings, runScript } from "../lib/actions";
import { latestOnly, stackView, type StackView } from "../lib/prStack";
import { hasRunCommand } from "../lib/projectSettings";
import { workspaceOpenIn } from "../lib/openIn";
import { useSync } from "../lib/syncStore";
import { chatKey, loadChat, useChat } from "../lib/chat";
import { planChat, planTabDot, planView } from "../lib/plan";
import { agentRows, agentsTabDot } from "../lib/subagents";
import { grantMenuLabel } from "../lib/terminalRead";
import { ChecksPanel } from "./ChecksPanel";
import { PlanPanel } from "./PlanPanel";
import { AgentsPanel } from "./AgentsPanel";
import { JobsPanel } from "./JobsPanel";
import { useSessionJobs } from "../lib/jobsStore";
import { jobsTabCount } from "../lib/jobs";
import { FileLinks, useProjectFiles } from "./AgentView";
import { useNow } from "../lib/useNow";
import { FilesPanel } from "./FilesPanel";
import { cx, prTone } from "./ui";
import { TaskTab, useSessionTask } from "./tasks/SessionTask";
import { SessionDesignTab } from "./design/SessionDesign";
import { designTab } from "../lib/sessionDesign";
import { sessionDesignsOf, useDesign } from "../lib/designStore";

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
            {openIn.choices.map((t) => item(`Open in ${t.label}`, () => void hostsApi.openIn(t.id, openIn.path, openIn.host).catch(errorToast)))}
            <div className="my-1 border-t border-border" />
            {item("Commit…", () => useStore.setState({ dialog: { kind: "commit" } }))}
            {item("Re-run setup script", () => void runScript("setup"))}
            {item("Project settings…", () => openProjectSettings({ host, project: ws.project_id }))}
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
    <div data-tauri-drag-region className="drag flex h-[52px] shrink-0 items-center gap-1 px-4">
      <button
        className={cx("no-drag flex h-8 items-center gap-2 rounded-md px-2.5 ui-text-14 hover:bg-raised", hasRunCommand(config) ? "text-fg" : "text-faint hover:text-fg")}
        title={hasRunCommand(config) ? `Run: ${config?.run} (⌘R)` : "Set a run command…"}
        onClick={() => (hasRunCommand(config) ? void runScript("run") : openProjectSettings({ host, project: ws.project_id }, "run"))}
      >
        <Play size={13} fill="currentColor" strokeWidth={0} /> Run
      </button>
      {pr && view && <StackMenu view={view} current={pr.number} />}
      <button
        className="no-drag group flex h-8 items-center gap-2 rounded-md px-2.5 ui-text-14 text-fg hover:bg-raised"
        title={pr ? `#${pr.number} ${pr.title} · Open in browser` : "Create pull request (⇧⌘P)"}
        onClick={() => (pr ? void openUrl(pr.url) : useStore.setState({ dialog: { kind: "create-pr" } }))}
      >
        <PrIcon className={pr ? prTone(pr.state) : "text-accent"} />
        PR {pr && <span className="text-muted">#{pr.number}</span>}
        {pr && pr.state !== "open" && <span className={prTone(pr.state)}>· {pr.state}</span>}
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

/** The latest plan of the session's chat the Plan tab follows (X24). */
function useSessionPlan(host: string, ws: Session) {
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
      ids ? ids.split(",").map((id) => ({ id: Number(id), st: s.chats[chatKey(host, Number(id))] })) : [],
    ),
  );
  const st = useChat((s) => (chatId === null ? undefined : s.chats[chatKey(host, chatId)]));
  useEffect(() => {
    if (chatId !== null && !st) void loadChat(host, chatId).catch(() => {});
  }, [host, chatId, st]);
  return useMemo(() => (st ? planView(st) : null), [st]);
}

/** The subagents of every chat in the session (X42), loading chats not yet loaded. */
function useSessionAgents(host: string, ws: Session) {
  const ids = useStore((s) =>
    Object.values(s.terminals[host] ?? {})
      .filter((t) => t.session_id === ws.id && t.chat && !t.exit)
      .map((t) => t.id)
      .join(","),
  );
  const list = useMemo(() => (ids ? ids.split(",").map(Number) : []), [ids]);
  // Each chat's subagents and asks, which change only on `chat.state`, so
  // streaming text does not re-render the panel. Undefined until loaded.
  const subagents = useChat(useShallow((s) => list.map((id) => s.chats[chatKey(host, id)]?.subagents)));
  const pending = useChat(useShallow((s) => list.map((id) => s.chats[chatKey(host, id)]?.pending)));
  const unloaded = list.filter((_, i) => pending[i] === undefined).join(",");
  useEffect(() => {
    for (const id of unloaded ? unloaded.split(",") : []) void loadChat(host, Number(id)).catch(() => {});
  }, [host, unloaded]);
  const now = useNow(subagents.some((agents) => agents?.some((a) => a.status === "running")));
  const rows = useMemo(
    () => agentRows(list.map((id, i) => ({ id, st: pending[i] && { subagents: subagents[i], pending: pending[i] } })), now),
    [list, subagents, pending, now],
  );
  return { rows, now };
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
  const tab = (chosen === "task" && !linked) || (chosen === "jobs" && !jobs.length) || (chosen === "design" && !design) ? "files" : chosen;
  const withJobs = jobs.length ? TABS.flatMap((t) => (t.id === "agents" ? [t, { id: "jobs" as const, label: "Jobs" }] : [t])) : TABS;
  const shown = design ? [...withJobs, { id: "design" as const, label: "Design" }] : withJobs;
  const tabs = linked ? [{ id: "task" as const, label: "Task" }, ...shown] : shown;
  const plan = useSessionPlan(host, ws);
  const agents = useSessionAgents(host, ws);
  // Plan file links (X30) check the worktree while the Plan tab shows, and again whenever the plan changes.
  const exists = useProjectFiles(host, tab === "plan" ? ws.path : "", plan?.plan);

  // Watch the worktree for live refresh of Files and Changes.
  useEffect(() => {
    void rpc(host, M.fsWatch, { path: ws.path }).catch(() => {});
    return () => void rpc(host, M.fsUnwatch, { path: ws.path }).catch(() => {});
  }, [host, ws.path]);

  return (
    <div className="flex h-full flex-col bg-panel">
      <TopActions host={host} ws={ws} />
      <div role="tablist" className="flex h-[38px] shrink-0 items-stretch border-b border-border px-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            id={`right-tab-${t.id}`}
            role="tab"
            aria-selected={tab === t.id}
            aria-controls="right-tabpanel"
            // The Agents tab always opens on its list (X42).
            onClick={() =>
              useStore.setState(t.id === "agents" ? { rightTab: t.id, agentDetail: null } : t.id === "jobs" ? { rightTab: t.id, jobDetail: null } : { rightTab: t.id })
            }
            className={cx(
              "flex items-center gap-1.5 px-3 ui-text-13 transition-colors",
              tab === t.id ? "text-fg shadow-[inset_0_-2px_0_var(--color-accent)]" : "text-muted hover:text-fg",
            )}
          >
            {t.label}
            {t.id === "jobs" && <span className="ui-text-12 tabular-nums text-faint">{jobsTabCount(jobs)}</span>}
            {t.id === "design" && !!design?.count && <span aria-label={`${design.count} open comments`} className="ui-text-12 tabular-nums text-faint">{design.count}</span>}
            {t.id === "plan" && planTabDot(tab, plan?.status === "pending") && <span aria-label="plan waiting" className="h-1.5 w-1.5 rounded-full bg-blocked" />}
            {t.id === "agents" && agentsTabDot(tab, agents.rows) && <span aria-label="agent waiting" className="h-1.5 w-1.5 rounded-full bg-blocked" />}
          </button>
        ))}
      </div>
      <div
        id="right-tabpanel"
        role="tabpanel"
        aria-labelledby={`right-tab-${tab}`}
        className={cx("min-h-0 flex-1 bg-bg", tab === "design" ? "flex flex-col" : "overflow-y-auto")}
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
      </div>
    </div>
  );
}
