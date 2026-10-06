import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowRight, ChevronDown, ChevronRight, ExternalLink, Layers, MoreHorizontal, Play, Plus, SquareDot, SquareMinus, SquarePlus } from "lucide-react";
import { hostsApi, rpc } from "../lib/daemon";
import { M, type FileChange, type PrStack, type ProjectConfig, type Session } from "../lib/protocol";
import { errorToast, pollPr, projectOf, type RightTab, useStore, sesKey } from "../lib/store";
import { archiveSession, openProjectSettings, runScript } from "../lib/actions";
import { latestOnly, stackView, type StackView } from "../lib/prStack";
import { hasRunCommand } from "../lib/projectSettings";
import { chatKey, loadChat, useChat } from "../lib/chat";
import { planChat, planTabDot, planView } from "../lib/plan";
import { ChecksPanel } from "./ChecksPanel";
import { PlanPanel } from "./PlanPanel";
import { FilesPanel } from "./FilesPanel";
import { PreviewPanel } from "./PreviewPanel";
import { Empty, cx, prTone } from "./ui";

const ChangesPanel = lazy(() => import("./ChangesPanel"));

const TABS: { id: RightTab; label: string }[] = [
  { id: "plan", label: "Plan" },
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
  const usable = targets.filter((t) => !remote || t.id === "vscode" || t.id === "cursor");
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
            {usable.map((t) => item(`Open in ${t.label}`, () => void hostsApi.openIn(t.id, ws.path, host).catch(errorToast)))}
            <div className="my-1 border-t border-border" />
            {item("Commit…", () => useStore.setState({ dialog: { kind: "commit" } }))}
            {item("Re-run setup script", () => void runScript("setup"))}
            {item("Project settings…", () => openProjectSettings({ host, project: ws.project_id }))}
            {item("Toggle sidebar  ⌘B", () => useStore.setState((s) => ({ sidebarOpen: !s.sidebarOpen })))}
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

function StatusBox({ status }: { status: FileChange["status"] }) {
  const p = { size: 14, strokeWidth: 1.5, className: "shrink-0 text-muted" };
  if (status === "added" || status === "untracked") return <SquarePlus {...p} />;
  if (status === "deleted") return <SquareMinus {...p} />;
  return <SquareDot {...p} />;
}

/** Changed files grouped by directory, as in the reference design. */
function ChangedFiles({ host, ws }: { host: string; ws: Session }) {
  const git = useStore((s) => s.git[sesKey(host, ws.id)]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => {
    const m = new Map<string, FileChange[]>();
    for (const f of git?.files ?? []) {
      const i = f.path.lastIndexOf("/");
      const dir = i < 0 ? "" : f.path.slice(0, i);
      m.set(dir, [...(m.get(dir) ?? []), f]);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [git]);
  if (!git) return null;
  if (git.files.length === 0) return <Empty title="No changes yet">{`Nothing differs from ${ws.base}.`}</Empty>;
  return (
    <div className="pb-4">
      {groups.map(([dir, files]) => (
        <div key={dir} className="mt-3">
          <button
            className="flex w-full items-center gap-2 px-5 py-1.5 text-left font-mono ui-text-12 tracking-[0.06em] text-muted hover:text-fg"
            onClick={() => setCollapsed((c) => ({ ...c, [dir]: !c[dir] }))}
          >
            {collapsed[dir] ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            <span className="truncate">{dir || "/"}</span>
          </button>
          {!collapsed[dir] &&
            files.map((f) => {
              const name = f.path.slice(dir ? dir.length + 1 : 0);
              const count = f.binary ? "bin" : f.additions && f.deletions ? `+${f.additions} −${f.deletions}` : f.deletions ? `−${f.deletions}` : `+${f.additions}`;
              return (
                <button
                  key={f.path}
                  title={f.old_path ? `${f.old_path} → ${f.path}` : f.path}
                  className="flex h-[38px] w-full items-center gap-3 pl-[34px] pr-5 text-left hover:bg-panel-2"
                  onClick={() => {
                    if (/\.(md|markdown)$/i.test(f.path) && f.status !== "deleted") {
                      useStore.setState({ preview: { host, path: `${ws.path}/${f.path}` } });
                    } else {
                      useStore.setState({ diffFile: f.path, rightTab: "changes" });
                    }
                  }}
                >
                  <StatusBox status={f.status} />
                  <span className={cx("min-w-0 flex-1 truncate ui-text-14", f.status === "deleted" ? "text-muted line-through" : "text-fg")}>{name}</span>
                  <span className="shrink-0 font-mono ui-text-12 tabular-nums text-muted">{count}</span>
                </button>
              );
            })}
        </div>
      ))}
    </div>
  );
}

function SummaryLine({ host, ws }: { host: string; ws: Session }) {
  const git = useStore((s) => s.git[sesKey(host, ws.id)]);
  return (
    <div className="flex items-center gap-2 px-5 pb-1 pt-4 font-mono ui-text-12.5 text-muted">
      {git ? (
        <>
          <span className="text-add">+{git.additions}</span>
          <span className="text-del">−{git.deletions}</span>
          <span className="text-faint">·</span>
          <span>
            {git.files.length} file{git.files.length === 1 ? "" : "s"}
          </span>
          <span className="text-faint">·</span>
          <ArrowRight size={12} />
          <span className="rounded bg-raised px-1.5 py-0.5 text-fg">{ws.base}</span>
          {git.base_missing && (
            <span className="text-blocked" title={`"${git.base_missing}" was not found (not fetched?), so only uncommitted changes against HEAD are shown.`}>
              base not found · showing HEAD
            </span>
          )}
        </>
      ) : (
        <span className="text-faint">loading…</span>
      )}
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

export function RightPanel({ host, ws }: { host: string; ws: Session }) {
  const tab = useStore((s) => s.rightTab);
  const preview = useStore((s) => s.preview);
  const [allFiles, setAllFiles] = useState(false);
  const plan = useSessionPlan(host, ws);

  // Watch the worktree for live refresh of Files, Changes and Preview.
  useEffect(() => {
    void rpc(host, M.fsWatch, { path: ws.path }).catch(() => {});
    return () => void rpc(host, M.fsUnwatch, { path: ws.path }).catch(() => {});
  }, [host, ws.path]);

  return (
    <div className="flex h-full flex-col bg-panel">
      <TopActions host={host} ws={ws} />
      <div role="tablist" className="flex h-[38px] shrink-0 items-stretch border-b border-border px-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id && !preview}
            onClick={() => useStore.setState({ rightTab: t.id, preview: null })}
            className={cx(
              "flex items-center gap-1.5 px-3 ui-text-13 transition-colors",
              tab === t.id && !preview ? "text-fg shadow-[inset_0_-2px_0_var(--color-accent)]" : "text-muted hover:text-fg",
            )}
          >
            {t.label}
            {t.id === "plan" && planTabDot(tab, !!preview, plan?.status === "pending") && <span aria-label="plan waiting" className="h-1.5 w-1.5 rounded-full bg-blocked" />}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto bg-bg">
        <Suspense fallback={null}>
          {preview ? (
            <PreviewPanel />
          ) : tab === "plan" ? (
            <PlanPanel view={plan} />
          ) : tab === "files" ? (
            <div className="flex h-full flex-col">
              <div className="flex items-center">
                <SummaryLine host={host} ws={ws} />
                <button
                  className="ml-auto mr-4 mt-3 rounded px-2 py-0.5 font-mono ui-text-11.5 text-faint hover:bg-raised hover:text-fg"
                  onClick={() => setAllFiles(!allFiles)}
                  title={allFiles ? "Show changed files" : "Browse all files"}
                >
                  {allFiles ? "changed" : "all files"}
                </button>
              </div>
              <div className="min-h-0 flex-1">{allFiles ? <FilesPanel host={host} ws={ws} /> : <ChangedFiles host={host} ws={ws} />}</div>
            </div>
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
