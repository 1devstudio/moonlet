// Tasks mode (X45, X50): the sidebar's boards and the shown board of the workspace's tasks.

import { Bot, ChevronDown, Copy, ExternalLink, GitBranch, LayoutGrid, List, MoreHorizontal, Plus, RotateCw, Search, SquareTerminal, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { errorToast, selectSession, shownWorkspace, toast, useStore } from "../../lib/store";
import { rpc } from "../../lib/daemon";
import { M } from "../../lib/protocol";
import { askConfirm } from "../../lib/confirm";
import { createLockOn, createsIn, createTarget } from "../../lib/newIssue";
import { type Column, type Task, taskId, taskStart, trackerName } from "../../lib/tasks";
import { enterOpensFirst, findsTask, glyphShape, sessionCard, stateOptions } from "../../lib/taskDetails";
import { type BoardWorktree, type Card, type CardRow, isDimmed, sessionsWithoutTask, outOfSync } from "../../lib/tasksBoard";
import {
  activityOf,
  boardInput,
  failureOf,
  fixDrift,
  forgetGhScopes,
  isTasksMode,
  leaveTasksMode,
  loadTrackersConfig,
  moveTask,
  openBoard,
  pollTasks,
  putOffDrift,
  refreshTasks,
  retryTask,
  rulesFor,
  runAutoFixes,
  setColumnShow,
  setExpanded,
  setAssignee,
  setFilters,
  setLayout,
  openAddBoard,
  showBoard,
  syncTasks,
  taskColumns,
  toggleExpanded,
  toggleTasksMode,
  trackersConfig,
  trackerSettings,
  useTasks,
} from "../../lib/tasksStore";
import { boardListGroups, cleanUps, listRow } from "../../lib/tasksList";
import { removeWorktreeAsk, startAction, withoutPutOffCard, withRules } from "../../lib/keepInStep";
import { effectiveKeys, keyLabel } from "../../lib/runActions";
import { keepCard, modeSwitch } from "../../lib/tasksView";
import { useNow } from "../../lib/useNow";
import { parseWsKey, wsKey } from "../../lib/workspaces";
import { assigneeOf, type BoardColumn, type BoardConfig, CATEGORY_BAR, CATEGORY_LABEL, type CardField, cardFields, footerTracker, NO_STATUS, projectMoveLock, syncedColumns, workspaceBoards } from "../../lib/boards";
import { type ColumnView, switcherGroups } from "../../lib/boardColumns";
import { asBoard, boardHeader, boardProblem, boardStats, footerLine, cardFace, columnsSummary, mapCards, shownBoardOf, sidebarBoards, stateChoices, workspaceViews } from "../../lib/boardScreen";
import { BoardMark, Button, cx, Empty, IconButton, inputCls, Kbd, StateGlyph } from "../ui";
import { Menu, type MenuItem } from "../Menu";
import { goSettings } from "../../lib/settingsNavigation";
import { ago } from "../../lib/mobile";
import { NewIssue } from "./NewIssue";


const TONE: Record<CardRow["meta"]["tone"], string> = {
  blocked: "text-blocked",
  open: "text-done",
  merged: "text-merged",
  error: "text-error",
  muted: "text-muted",
  faint: "text-faint",
};

/** Task state by shape: ring Todo, half In Progress, three quarters In Review, filled check Done. */
export function TaskGlyph({ column, size = 14 }: { column: Column; size?: number }) {
  const shape = glyphShape(column);
  const done = shape === "check";
  const pie = shape === "half" ? "M7 7 L7 4 A3 3 0 0 1 7 10 Z" : shape === "three-quarters" ? "M7 7 L7 4 A3 3 0 1 1 4 7 Z" : "";
  return (
    <svg viewBox="0 0 14 14" width={size} height={size} className={cx("shrink-0", done ? "text-merged" : column === "todo" ? "text-muted" : "text-fg")} aria-hidden="true">
      <circle cx="7" cy="7" r="5.5" fill={done ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" />
      {pie && <path d={pie} fill="currentColor" />}
      {done && <path d="M4.6 7.1 L6.3 8.8 L9.4 5.4" fill="none" stroke="var(--color-bg)" strokeWidth="1.5" />}
    </svg>
  );
}

/** Keeps the shown workspace's tasks fresh while Tasks mode is open: now,
 *  every minute, and when the window comes to the front (at most every 15 s). */
function useTaskSync() {
  const ws = useStore((s) => shownWorkspace(s));
  // Settings › Task trackers › Sync; 0 is "manual" (X44).
  const interval = useTasks((t) => trackersConfig(t).sync.interval);
  useEffect(() => void loadTrackersConfig(), []);
  useEffect(() => (ws ? syncTasks(ws.host, ws.id, interval) : undefined), [ws, interval]);
  // "Every session's PR is merged" at Automatically closes the issue, once (X46).
  const { board } = useWorkspaceBoard(ws);
  const config = useTasks((t) => trackersConfig(t));
  const paused = useTasks((t) => t.paused);
  useEffect(() => {
    if (!ws || !board) return;
    void runAutoFixes(ws.host, ws.id, board, (c: Card) => rulesFor(config, c.task));
  }, [ws, board, config, paused]);
}

/** The shown workspace's tasks and their board. */
function useWorkspaceTasks() {
  const ws = useStore((s) => shownWorkspace(s));
  return useWorkspaceBoard(ws);
}

/**
 * A workspace's boards laid out (X50), for Tasks mode and a session's task
 * (X46): `board` gathers every board's cards by category, with each board's
 * out of sync, for the Tasks button, Keep in step and session rows; `shown`
 * is the board the workspace shows, column by column.
 */
export function useWorkspaceBoard(ws: { host: string; id: string } | null) {
  const data = useTasks((t) => (ws ? t.data[wsKey(ws.host, ws.id)] : undefined));
  const notNow = useTasks((t) => t.notNow);
  const config = useTasks((t) => trackersConfig(t));
  const paused = useTasks((t) => t.paused);
  const shownId = useTasks((t) => (ws ? (t.shownBoard[wsKey(ws.host, ws.id)] ?? null) : null));
  // What the board reads of the main store; other changes (terminal output) don't rebuild it.
  const deps = useStore(useShallow((s) => [s.sessions, s.prs, s.git, s.terminals, s.reads]));
  return useMemo(() => {
    if (!ws || !data) return { ws, data, board: null, unlinked: [], shown: null, all: [] };
    const key = wsKey(ws.host, ws.id);
    const input = boardInput(useStore.getState(), ws.host, ws.id, data, config);
    // A chip whose rule is Off, or that the user put off with Not now, is not shown.
    const clean = (c: Card) => withoutPutOffCard(withRules(c, (x) => rulesFor(config, x.task)), notNow);
    const all = workspaceViews(workspaceBoards(config.boards, key, shownId), data, input).map((b) => ({ ...b, views: mapCards(b.views, clean) }));
    const shownBoard = shownBoardOf(config.boards, key, shownId);
    const shown = shownBoard ? { board: shownBoard, views: all.find((b) => b.board.id === shownBoard.id)?.views ?? [] } : null;
    return { ws, data, board: asBoard(all), unlinked: sessionsWithoutTask(input.sessions, data.tasks, input.link), shown, all };
  }, [ws, data, notNow, config, paused, shownId, ...deps]);
}

/** The sidebar body in Tasks mode (X50): Find a task, the workspace's pinned boards, then the sync line. */
export function TasksSidebar() {
  const { ws, data, shown } = useWorkspaceTasks();
  const query = useTasks((t) => t.query);
  const config = useTasks((t) => trackersConfig(t));
  const attention = useTasks((t) => t.attention);
  const now = useNow(true);
  const rows = useMemo(() => (ws ? sidebarBoards(config.boards, wsKey(ws.host, ws.id), shown?.board.id ?? null, data) : []), [ws, config, shown, data]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <label className="mx-2 mb-1 flex items-center gap-2 rounded-md px-3 py-1.5 text-muted focus-within:bg-panel-2">
        <Search size={14} />
        <span className="sr-only">Find a task</span>
        <input
          className="min-w-0 flex-1 bg-transparent ui-text-14 text-fg outline-none placeholder:text-muted"
          placeholder="Find a task"
          value={query}
          onChange={(e) => useTasks.setState({ query: e.target.value })}
        />
      </label>
      <div className="flex items-center px-4 pb-1 pt-2">
        <span className="flex-1 ui-text-11 font-medium uppercase tracking-[0.08em] text-faint">Boards</span>
        <IconButton title="Add a board" onClick={() => ws && openAddBoard(ws.host, ws.id)}>
          <Plus size={13} />
        </IconButton>
      </div>
      <nav aria-label="Boards" className="px-2">
        {rows.map((r) => {
          const b = config.boards?.find((x) => x.id === r.id);
          return (
            <button
              key={r.id}
              aria-current={r.current ? "page" : undefined}
              onClick={() => ws && showBoard(ws.host, ws.id, r.id)}
              className={cx(
                "relative flex h-[34px] w-full items-center gap-2.5 rounded-md px-3 text-left ui-text-14",
                r.current ? "bg-selected text-fg" : "text-muted hover:bg-panel-2 hover:text-fg",
              )}
            >
              {r.current && <span className="absolute inset-y-0 left-0 w-[2px] bg-accent" />}
              {b && <BoardMark connection={b.connection} />}
              <span className="min-w-0 flex-1 truncate">{r.label}</span>
              {b && attention[b.connection] && <span title={attention[b.connection]} className="h-1.5 w-1.5 rounded-full bg-error" />}
              <span className="font-mono ui-text-12 tabular-nums text-faint">{r.count}</span>
            </button>
          );
        })}
      </nav>
      <div className="flex-1" />
      {ws && data && data.sources.length > 0 && (
        <div className="flex items-center gap-2 px-4 py-2 ui-text-12 text-faint">
          <RotateCw size={12} className="shrink-0" />
          <span className={cx("min-w-0 flex-1 truncate", data.error && "text-error")} title={data.error ?? undefined}>
            {footerLine(data, shown?.board.id ?? null, footerTracker(shown?.board ?? null), now)}
          </span>
          <span aria-hidden="true" className={cx("h-1.5 w-1.5 rounded-full", data.error ? "bg-error" : "bg-done")} />
        </div>
      )}
    </div>
  );
}

/** Leaves Tasks mode for one of its sessions (X45 journey step 4). */
function openSession(host: string, sessionId: string) {
  leaveTasksMode();
  selectSession(host, sessionId);
}

/** Opens the new-session composer for a task, or for one of its worktrees without a session (X46). */
export function startSession(host: string, workspaceId: string, card: Card, worktree?: BoardWorktree) {
  const data = useTasks.getState().data[wsKey(host, workspaceId)];
  const settings = trackerSettings(trackersConfig(useTasks.getState()), card.task.connection);
  const start = {
    ...taskStart(card.task, data?.repos ?? {}, data?.sourceProjects ?? {}),
    assign: startAction(card.task, rulesFor(trackersConfig(useTasks.getState()), card.task).session_starts),
    template: settings.branch_template || undefined,
    maxLen: settings.max_length,
  };
  useStore.setState({
    dialog: {
      kind: "new-session",
      host,
      // An adopted worktree stays in its project; otherwise the composer
      // offers the projects that link the issue's source (X44).
      project: worktree?.project,
      workspace: workspaceId,
      task: start,
      worktree: worktree?.branch ? { path: worktree.path, branch: worktree.branch } : undefined,
    },
  });
}

function TaskCard({ host, workspaceId, card, fields, estimate, selected }: { host: string; workspaceId: string; card: Card; fields: CardField[]; estimate: string | null; selected: boolean }) {
  const pick = () => useTasks.setState({ selected: `${card.task.connection} ${card.task.key}` });
  const face = cardFace(card.task, fields, estimate);
  return (
    <article
      aria-label={`${card.task.key} ${card.task.title}`}
      className={cx(
        "rounded-lg border px-3 py-2.5",
        selected ? "border-accent/60 bg-selected" : card.needsYou ? "border-blocked/35 bg-panel" : "border-border bg-panel",
        // Someone else's issue, shown under Assignee: anyone (X50).
        isDimmed(card) && !selected && "opacity-60",
      )}
    >
      <div className="flex items-center gap-2 font-mono ui-text-11.5 text-faint">
        {card.task.key}
        {face.type && <span className="font-sans text-faint">{face.type}</span>}
        <PriorityBars n={card.task.priority} />
        {face.points && <span className="ml-auto">{face.points}</span>}
        {face.assignee && (
          <span title={`Assigned to ${face.assignee.name}`} className={cx("rounded-full bg-panel-2 px-1.5 font-sans ui-text-10.5 text-muted", !face.points && "ml-auto")}>
            {face.assignee.initials}
          </span>
        )}
      </div>
      <button className="mt-1 block w-full text-left ui-text-13.5 text-fg hover:underline" onClick={pick}>
        {card.task.title}
      </button>
      {face.line && <div className="mt-0.5 truncate ui-text-12 text-faint">{face.line}</div>}
      {card.rows.length > 0 ? (
        <div className="mt-2 flex flex-col gap-1">
          {card.rows.map((r) => (
            <button key={r.session.id} onClick={() => openSession(host, r.session.id)} className="flex items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-panel-2">
              <StateGlyph state={r.session.state} size={12} />
              <span className="min-w-0 flex-1 truncate ui-text-12.5 text-[#cfcfcf]">{r.session.name}</span>
              <span className={cx("font-mono ui-text-11.5 tabular-nums", TONE[r.meta.tone])}>{r.meta.text}</span>
            </button>
          ))}
          {card.note && <div className="px-1 ui-text-12 text-faint">{card.note}</div>}
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-1.5 ui-text-12 text-faint">
          {card.orphans.length > 0 && <GitBranch size={12} />}
          {/* A note (X50) says more than "No sessions": whose issue it is. */}
          <span>{card.note ?? card.empty}</span>
          <button className="ml-auto font-medium text-accent hover:underline" onClick={() => startSession(host, workspaceId, card, card.orphans[0])}>
            {card.orphans.length ? "Start session" : "Start"}
          </button>
        </div>
      )}
      {card.drift && (
        <div className="mt-2 flex items-center gap-2 rounded-md bg-accent/[0.08] px-2 py-1 ui-text-12 text-accent">
          <span className="min-w-0 flex-1 truncate">{card.drift.text}</span>
          {card.drift.fix && (
            <button className="font-medium hover:underline" onClick={() => void fixDrift(host, workspaceId, card)}>
              {card.drift.fix}
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function TaskDetail({ host, workspaceId, card }: { host: string; workspaceId: string; card: Card }) {
  const failure = useTasks(() => failureOf(card.task));
  const now = useNow(true);
  // ↵ opens the first session (X45).
  const first = card.rows[0]?.session.id;
  useEffect(() => {
    if (!first) return;
    const onKey = (e: KeyboardEvent) => {
      const t = (e.target as HTMLElement | null) ?? document.body;
      const st = useStore.getState();
      const covered = !!st.dialog || !!st.settingsPage || !!t.closest?.('[role="dialog"]') || !!document.querySelector('[role="dialog"]');
      const modifier = e.metaKey || e.ctrlKey || e.altKey || e.shiftKey;
      if (enterOpensFirst({ key: e.key, tagName: t.tagName, isContentEditable: t.isContentEditable, modifier, defaultPrevented: e.defaultPrevented, covered: covered || e.isComposing }))
        openSession(host, first);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [host, first]);
  return (
    <aside aria-label="Task detail" className="flex w-[360px] shrink-0 flex-col overflow-y-auto border-l border-border bg-panel">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="font-mono ui-text-12 text-muted">{card.task.key}</span>
        <IconButton title="Copy issue key" onClick={() => void navigator.clipboard.writeText(card.task.key).then(() => toast(`Copied ${card.task.key}`))}>
          <Copy size={13} />
        </IconButton>
        <a href={card.task.url} target="_blank" rel="noreferrer" className="ml-auto flex items-center gap-1 ui-text-12 text-muted hover:text-fg">
          Open in {trackerName(card.task.connection)} <ExternalLink size={12} />
        </a>
        <IconButton title="Close detail" onClick={() => useTasks.setState({ selected: null })}>
          <X size={14} />
        </IconButton>
      </div>
      <div className="px-4 py-3">
        <h2 className="ui-text-16 font-medium text-fg">{card.task.title}</h2>
        <dl className="mt-3 grid grid-cols-[80px_1fr] gap-y-1.5 ui-text-12.5">
          <dt className="text-faint">State</dt>
          <dd className="flex items-center gap-2">
            <TaskGlyph column={card.column} size={13} />
            <StateMenu host={host} workspaceId={workspaceId} task={card.task} />
          </dd>
          <dt className="text-faint">Assignee</dt>
          <dd className="text-muted">{card.task.assignees.join(", ") || "No one"}</dd>
          <dt className="text-faint">Priority</dt>
          <dd className="flex items-center gap-2 text-muted">
            <PriorityBars n={card.task.priority} /> {PRIORITY[card.task.priority] ?? "No priority"}
            {card.task.cycle !== undefined && <span className="text-faint">· Cycle {card.task.cycle}</span>}
          </dd>
          {card.task.labels.length > 0 && (
            <>
              <dt className="text-faint">Labels</dt>
              <dd className="text-muted">{card.task.labels.join(", ")}</dd>
            </>
          )}
        </dl>
        {card.task.description && <p className="selectable mt-3 line-clamp-4 whitespace-pre-wrap ui-text-12.5 text-muted">{card.task.description}</p>}
        {failure && (
          <div role="alert" className="mt-3 flex items-start gap-2 rounded-md border border-error/30 bg-error/[0.06] px-3 py-2 ui-text-12.5 text-error">
            <span className="min-w-0 flex-1">{failure}</span>
            <Button size="sm" variant="ghost" onClick={() => void retryTask(card.task)}>
              Retry
            </Button>
          </div>
        )}
        {card.drift && (
          <div className="mt-3 rounded-md border border-accent/30 bg-accent/[0.06] px-3 py-2 ui-text-12.5 text-accent">
            {card.drift.text}
            <div className="mt-2 flex gap-1.5">
              {card.drift.fix && (
                <Button size="sm" variant="primary" onClick={() => void fixDrift(host, workspaceId, card)}>
                  {card.drift.fix}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => putOffDrift(card)}>
                Not now
              </Button>
            </div>
          </div>
        )}
        <div className="mt-4 flex items-center ui-text-11.5 font-medium text-faint">
          Sessions {card.rows.length}
          <button className="ml-auto text-muted hover:text-fg" onClick={() => startSession(host, workspaceId, card)}>
            + New session
          </button>
        </div>
        {card.rows.length === 0 && <p className="mt-1 ui-text-12.5 text-muted">No sessions yet. Starting one names the branch after the issue.</p>}
        {card.rows.map((r, i) => {
          const c = sessionCard(r.session, r.session.project ?? "", now);
          return (
            <div key={r.session.id} role="group" aria-label={`Session ${r.session.name}`} className="mt-2 rounded-lg border border-border px-3 py-2">
              <div className="flex items-center gap-2">
                <StateGlyph state={r.session.state} size={13} />
                <span className="min-w-0 flex-1 truncate ui-text-13 text-fg">{r.session.name}</span>
                <button className="rounded-md border border-border-strong px-2 py-0.5 ui-text-12 text-fg hover:bg-panel-2" onClick={() => openSession(host, r.session.id)}>
                  Open{i === 0 && <> <Kbd>↵</Kbd></>}
                </button>
              </div>
              <div className="mt-1 flex gap-2 font-mono ui-text-11.5 text-faint">
                <span className="min-w-0 truncate">{c.where}</span>
                {c.diff && <span>{c.diff}</span>}
              </div>
              {c.agents.map((a) => (
                <div key={a} className="mt-0.5 flex items-center gap-1.5 ui-text-12 text-muted">
                  <Bot size={12} /> {a}
                </div>
              ))}
              <div className={cx("mt-0.5 ui-text-12", r.session.pr ? PR_TONE[listRow({ ...card, rows: [r] }).prTone] : "text-faint")}>{c.pr}</div>
            </div>
          );
        })}
        {card.orphans.length > 0 && <div className="mt-4 ui-text-11.5 font-medium text-faint">Worktrees without a session {card.orphans.length}</div>}
        {card.orphans.map((w) => (
          <div key={w.path} className="mt-2 flex items-center gap-2 ui-text-12.5 text-muted">
            <GitBranch size={13} />
            <span className="min-w-0 flex-1 truncate font-mono">{w.branch}</span>
            <button className="rounded-md border border-border-strong px-2 py-0.5 ui-text-12 text-fg hover:bg-panel-2" onClick={() => startSession(host, workspaceId, card, w)}>
              Start session
            </button>
            <IconButton title="Remove worktree" onClick={() => void removeWorktree(host, w)}>
              <Trash2 size={13} />
            </IconButton>
          </div>
        ))}
        <Activity task={card.task} />
      </div>
    </aside>
  );
}

/** The centre in Tasks mode (X50): the shown board's header and columns or list, and the selected task's detail. */
export function TasksMode() {
  useTaskSync();
  const { ws, data, board, unlinked, shown, all } = useWorkspaceTasks();
  const connections = useTasks((t) => t.config?.connections);
  const layout = useTasks((t) => t.layout);
  const query = useTasks((t) => t.query);
  const filters = useTasks((t) => t.filters);
  const assignee = useTasks((t) => t.assignee);
  const selected = useTasks((t) => t.selected);
  const attention = useTasks((t) => t.attention);
  const hosts = useStore((s) => s.hosts);
  const ghScopes = useTasks((t) => t.ghScopes);
  // The column whose + opened New issue (X52).
  const [creating, setCreating] = useState<BoardColumn | null>(null);
  if (!ws) return null;
  if (!data) return <Empty title="Loading tasks…" />;
  if (!shown) {
    const connected = (connections ?? []).length > 0;
    return (
      <div className="flex h-full items-start justify-center pt-[12vh]">
        <section role="dialog" aria-labelledby="connect-tracker" className="w-[440px] rounded-xl border border-border-strong bg-panel p-5">
          <h2 id="connect-tracker" className="ui-text-15 font-medium text-fg">
            {connected ? "Add a board" : "Connect a task tracker"}
          </h2>
          <p className="mt-1 ui-text-12.5 text-muted">
            {connected ? "This workspace has no board yet. Pick one of your trackers' boards, teams or lists, or a GitHub repository." : "Tasks mode shows your issues with the sessions, worktrees and PRs working on them. This workspace has no board yet."}
          </p>
          <div className="mt-3 flex flex-col divide-y divide-border rounded-lg border border-border">
            <div className="px-3 py-2">
              <div className="ui-text-13 text-fg">GitHub Issues</div>
              <div className="ui-text-12 text-muted">Uses your gh login · add a project with a GitHub origin to this workspace</div>
            </div>
            {[
              ["Linear", "API key"],
              ["Jira Cloud", "Site, email and API token"],
              ["ClickUp", "Personal API token"],
            ].map(([t, how]) => (
              <button key={t} className="block w-full px-3 py-2 text-left hover:bg-panel-2" onClick={() => void goSettings({ page: "trackers" })}>
                <div className="ui-text-13 text-fg">{t}</div>
                <div className="ui-text-12 text-muted">{how} · then pick what this workspace shows</div>
              </button>
            ))}
          </div>
          <div className="mt-4 flex justify-between">
            {connected ? (
              <Button size="sm" variant="primary" onClick={() => openAddBoard(ws.host, ws.id)}>
                Add a board
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => void goSettings({ page: "trackers" })}>
                Open Settings › Task trackers
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => leaveTasksMode()}>
              Not now
            </Button>
          </div>
        </section>
      </div>
    );
  }
  // The header's filters and Find a task (X45), column by column.
  // Assignee is the shown board's own (X50).
  const views = mapCards(shown.views, (c) => (keepCard(c, { ...filters, mine: assigneeOf(shown.board, assignee) === "me" }) && findsTask(c.task, query) ? c : null));
  const cards = board ? Object.values(board).flat() : [];
  const detail = cards.find((c) => taskId(c.task) === selected);
  const site = connections?.find((c) => c.id === shown.board.connection)?.site ?? "";
  const header = boardHeader(shown.board, data.boards?.[shown.board.id]?.sprint, site, views.flatMap((v) => v.cards));
  const problem = boardProblem(shown.board, data.boards?.[shown.board.id]);
  const fields = cardFields(shown.board);
  // The + on a column (X52): where it creates, and why it can't.
  const savedColumns = syncedColumns(shown.board, null);
  const createLocked = createLockOn(shown.board, ws.host, { attention, hosts, scopes: ghScopes });
  const plusFor = (name: string) => {
    const column = savedColumns.find((c) => c.name === name);
    return column && createsIn(shown.board) && createTarget(shown.board, column) ? column : null;
  };
  // A GitHub Project's estimate is named after its number field (X50).
  const estimate = data.boards?.[shown.board.id]?.project?.numberField ?? null;
  const stats = Object.fromEntries(all.map((b) => [b.board.id, boardStats(b.board, b.views, data.boards?.[b.board.id])]));
  const listCards = views.flatMap((v) => (v.folded ? [] : v.cards));
  return (
    <div className="flex h-full min-w-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header data-tauri-drag-region className="drag flex h-[56px] shrink-0 items-center gap-3 px-5">
          <BoardSwitcher host={ws.host} workspaceId={ws.id} shown={shown.board} title={header.title} subtitle={header.subtitle} stats={stats} />
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {layout === "list" && <ExpandAll cards={listCards} />}
            <Filters board={shown.board} columns={syncedColumns(shown.board, null)} />
            <LayoutSwitch />
            <IconButton
              title="Refresh tasks"
              onClick={() => {
                forgetGhScopes(ws.host);
                void refreshTasks(ws.host, ws.id);
              }}
            >
              <RotateCw size={13} />
            </IconButton>
          </div>
        </header>
        {problem && (
          // A board whose origin is gone (a Jira board deleted, a team archived) says why, with its settings (X50).
          <div role="alert" className="mx-5 mb-3 flex items-center gap-3 rounded-lg border border-error/40 bg-error/[0.06] px-3 py-2 ui-text-12.5 text-error">
            <span className="min-w-0 flex-1">{problem}</span>
            <Button size="sm" variant="ghost" onClick={() => openAddBoard(ws.host, ws.id, shown.board.id)}>
              Board settings
            </Button>
          </div>
        )}
        {layout === "list" ? (
          <TasksList host={ws.host} workspaceId={ws.id} views={views} unlinked={unlinked} />
        ) : (
          <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-5 pb-4">
            {views.map((v) =>
              v.folded ? (
                <FoldedColumn key={v.name} boardId={shown.board.id} view={v} />
              ) : (
                <section key={v.name} aria-label={v.name} className="group/column flex w-[280px] shrink-0 flex-col">
                  <div className="mb-2 border-b border-border pb-1.5">
                    <div className="flex items-center gap-2 ui-text-13 font-medium text-fg">
                      <span className="min-w-0 truncate">{v.name}</span>
                      <span className="font-mono ui-text-12 font-normal text-faint">{v.cards.length}</span>
                      {plusFor(v.name) && (
                        // Shown on hover, keyboard focus, and always on a touch screen.
                        // A locked + stays in the tab order, so its reason can be reached.
                        <IconButton
                          title={createLocked ?? `New issue in ${v.name}`}
                          aria-disabled={!!createLocked || undefined}
                          onClick={() => !createLocked && setCreating(plusFor(v.name))}
                          className="opacity-0 focus-visible:opacity-100 group-hover/column:opacity-100 aria-disabled:cursor-default aria-disabled:text-faint [@media(hover:none)]:opacity-100"
                        >
                          <Plus size={14} />
                        </IconButton>
                      )}
                      <div className="ml-auto">
                        <Menu
                          align="right"
                          width={190}
                          items={[
                            { label: "Fold", onSelect: () => setColumnShow(shown.board.id, v.name, "fold") },
                            { label: "Hide", onSelect: () => setColumnShow(shown.board.id, v.name, "hide") },
                            { kind: "divider" },
                            { label: "Board settings…", onSelect: () => openAddBoard(ws.host, ws.id, shown.board.id) },
                          ]}
                          trigger={(open) => (
                            <IconButton title={`${v.name} options`} onClick={open}>
                              <MoreHorizontal size={14} />
                            </IconButton>
                          )}
                        />
                      </div>
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 ui-text-11.5 text-faint">
                      <TaskGlyph column={v.category} size={11} />
                      {CATEGORY_LABEL[v.category]}
                      {v.wip && (
                        <span className={cx(v.wip.full && "text-blocked")}>
                          · {v.wip.count} of {v.wip.max}
                          {v.wip.full && " · full"}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
                    {v.cards.map((c) => (
                      <TaskCard key={taskId(c.task)} host={ws.host} workspaceId={ws.id} card={c} fields={fields} estimate={estimate} selected={taskId(c.task) === selected} />
                    ))}
                  </div>
                </section>
              ),
            )}
          </div>
        )}
      </div>
      {detail && <TaskDetail host={ws.host} workspaceId={ws.id} card={detail} />}
      {creating && <NewIssue host={ws.host} workspaceId={ws.id} board={shown.board} column={creating} onClose={() => setCreating(null)} />}
    </div>
  );
}

/** A folded column (X50): a narrow strip with its name written down, its count and its clean-ups; clicking unfolds it. */
function FoldedColumn({ boardId, view }: { boardId: string; view: ColumnView }) {
  const cleanUp = cleanUps(view.cards);
  const n = view.cards.length;
  return (
    <button
      aria-label={`${view.name}: ${n} ${n === 1 ? "task" : "tasks"}${cleanUp ? `, ${cleanUp} needs clean-up` : ""}`}
      title={`Unfold ${view.name}`}
      onClick={() => setColumnShow(boardId, view.name, "show")}
      className="flex w-[40px] shrink-0 flex-col items-center gap-2 self-stretch rounded-lg border border-border bg-panel py-2.5 text-muted hover:text-fg"
    >
      <TaskGlyph column={view.category} size={13} />
      <span className="ui-text-12.5 font-medium text-fg [writing-mode:vertical-rl]">{view.name}</span>
      <span className="font-mono ui-text-11.5 text-faint">{n}</span>
      {cleanUp > 0 && <span className="rounded-full bg-error/20 px-1.5 font-mono ui-text-10.5 text-error">{cleanUp}</span>}
    </button>
  );
}

/** The header's title (X50): the board's name and sprint, which opens the board switcher, over its subtitle. */
function BoardSwitcher({ host, workspaceId, shown, title, subtitle, stats }: { host: string; workspaceId: string; shown: BoardConfig; title: string; subtitle: string; stats: Parameters<typeof switcherGroups>[4] }) {
  const boards = useTasks((t) => trackersConfig(t).boards);
  const workspaces = useStore((s) => s.workspaces);
  const [query, setQuery] = useState("");
  const names = Object.fromEntries(Object.entries(workspaces).flatMap(([h, list]) => list.map((w) => [wsKey(h, w.id), w.name])));
  const items: MenuItem[] = switcherGroups(boards ?? [], wsKey(host, workspaceId), query, names, stats).flatMap((g) => [
    { kind: "label" as const, label: `${g.name} · ${g.hint}` },
    ...g.rows.map((r) => ({
      label: r.board.name,
      description: (
        <>
          {[r.kind, r.meta].filter(Boolean).join(" · ")}
          {r.sessions && (
            <>
              {" · "}
              {r.sessions.state && (
                <span className="inline-block align-[-1px]">
                  <StateGlyph state={r.sessions.state} size={10} />
                </span>
              )}{" "}
              {r.sessions.text}
            </>
          )}
        </>
      ),
      aside: (
        <span aria-label={`${r.bars.length} columns`} className="flex items-end gap-[2px]">
          {r.bars.map((c, i) => (
            <span key={i} className={cx("h-[10px] w-[3px] rounded-[1px]", CATEGORY_BAR[c])} />
          ))}
        </span>
      ),
      checked: r.board.id === shown.id,
      icon: <BoardMark connection={r.board.connection} />,
      onSelect: () => {
        const to = parseWsKey(r.board.workspace);
        openBoard(to.host, to.id, r.board.id);
      },
    })),
  ]);
  const footer: MenuItem[] = [
    { label: "New board", icon: <Plus size={13} />, onSelect: () => openAddBoard(host, workspaceId) },
    { label: "Manage", onSelect: () => void goSettings({ page: "trackers", focus: "boards" }) },
  ];
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <BoardMark connection={shown.connection} />
      <div className="min-w-0">
        <Menu
          width={360}
          search={{ placeholder: "Find a board, team or project", query, onQuery: setQuery }}
          items={items}
          footer={footer}
          trigger={(open) => (
            <button aria-label={`Switch board, current: ${shown.name}`} onClick={open} className="no-drag flex items-center gap-1 ui-text-15 font-medium text-fg">
              <span className="truncate">{title}</span>
              <ChevronDown size={14} className="text-muted" />
            </button>
          )}
        />
        <div className="truncate ui-text-12 text-faint">{subtitle}</div>
      </div>
    </div>
  );
}

/** Sessions | Tasks beside the workspace switcher (X45), with a dot when tasks are out of sync. */
export function ModeSwitch() {
  const tasks = useStore((s) => isTasksMode(s));
  const { ws, board } = useWorkspaceTasks();
  useEffect(() => (ws ? pollTasks(ws.host, ws.id) : undefined), [ws]);
  // The switch's shortcut as the user has it (Settings › Shortcuts).
  const key = keyLabel(effectiveKeys(useStore((s) => s.settings.shortcuts)).tasks ?? "");
  const m = modeSwitch(key, board ? outOfSync(board).length : 0);
  const item = "no-drag relative flex h-[26px] w-[30px] items-center justify-center rounded-[5px]";
  return (
    <div role="group" aria-label="Mode" className="ml-auto flex shrink-0 items-center gap-0.5 rounded-md bg-panel-2 p-0.5">
      <button aria-label="Sessions" aria-pressed={!tasks} title={m.sessions} onClick={() => tasks && toggleTasksMode()} className={cx(item, !tasks ? "bg-raised text-fg" : "text-muted hover:text-fg")}>
        <SquareTerminal size={14} />
      </button>
      <button
        aria-label={m.label}
        aria-pressed={tasks}
        title={m.tasks}
        onClick={() => !tasks && toggleTasksMode()}
        className={cx(item, tasks ? "bg-raised text-fg" : "text-muted hover:text-fg")}
      >
        <TaskGlyph column="in_progress" size={14} />
        {m.dot && <span aria-hidden="true" className="absolute right-[3px] top-[3px] h-[6px] w-[6px] rounded-full bg-accent" />}
      </button>
    </div>
  );
}

/** Assignee: me, the Columns menu and Hide empty Done in the header (X45, X50). */
function Filters({ board, columns }: { board: BoardConfig; columns: BoardColumn[] }) {
  const filters = useTasks((t) => t.filters);
  const who = useTasks((t) => assigneeOf(board, t.assignee));
  const chip = "no-drag whitespace-nowrap rounded-md border px-2 py-1 ui-text-12";
  const show = (c: { show?: "fold" | "hide" }) => c.show ?? "show";
  return (
    <div role="group" aria-label="Filters" className="flex items-center gap-1">
      <Menu
        width={200}
        items={(["me", "anyone"] as const).map((v) => ({ label: v === "me" ? "Me" : "Anyone", description: v === "me" ? "Issues assigned to you" : "Others' issues dimmed", checked: who === v, onSelect: () => setAssignee(board, v) }))}
        trigger={(open) => (
          <button aria-label={`Assignee: ${who}`} onClick={open} className={cx(chip, "flex items-center gap-1 border-border-strong bg-raised text-fg")}>
            Assignee: {who}
            <ChevronDown size={12} className="text-muted" />
          </button>
        )}
      />
      <Menu
        align="right"
        width={220}
        items={columns.map((c) => ({
          kind: "submenu" as const,
          label: c.name,
          items: (["show", "fold", "hide"] as const).map((v) => ({ label: v === "show" ? "Show" : v === "fold" ? "Fold" : "Hide", checked: show(c) === v, onSelect: () => setColumnShow(board.id, c.name, v) })),
        }))}
        trigger={(open) => (
          <button onClick={open} className={cx(chip, "border-border text-muted hover:text-fg")}>
            {columnsSummary(columns)}
          </button>
        )}
      />
      <button
        aria-pressed={filters.hideEmptyDone}
        onClick={() => setFilters({ ...filters, hideEmptyDone: !filters.hideEmptyDone })}
        className={cx(chip, filters.hideEmptyDone ? "border-border-strong bg-raised text-fg" : "border-border text-muted hover:text-fg")}
      >
        Hide empty Done
      </button>
    </div>
  );
}

/** Expand all or Collapse all, in the header of the List (X45, X50). */
function ExpandAll({ cards }: { cards: Card[] }) {
  const expanded = useTasks((t) => t.expanded);
  const allOpen = cards.length > 0 && cards.every((c) => expanded[taskId(c.task)]);
  return (
    <button className="no-drag whitespace-nowrap rounded-md border border-border px-2 py-1 ui-text-12 text-muted hover:text-fg" onClick={() => setExpanded(allOpen ? {} : Object.fromEntries(cards.map((c) => [taskId(c.task), true])))}>
      {allOpen ? "Collapse all" : "Expand all"}
    </button>
  );
}

/** Board | List in the header (X45). */
function LayoutSwitch() {
  const layout = useTasks((t) => t.layout);
  const item = (id: "board" | "list", label: string, icon: React.ReactNode) => (
    <button
      aria-pressed={layout === id}
      onClick={() => setLayout(id)}
      className={cx("no-drag flex h-6 items-center gap-1.5 whitespace-nowrap rounded-[5px] px-2.5 ui-text-12.5", layout === id ? "bg-raised text-fg" : "text-muted hover:text-fg")}
    >
      {icon}
      {label}
    </button>
  );
  return (
    <div role="group" aria-label="Layout" className="flex gap-0.5 rounded-md bg-panel-2 p-0.5">
      {item("board", "Board", <LayoutGrid size={12} />)}
      {item("list", "List", <List size={12} />)}
    </div>
  );
}

const SUM_TONE = { blocked: "text-blocked", faint: "text-faint" } as const;
const PR_TONE = { open: "text-done", merged: "text-merged", error: "text-error", faint: "text-faint" } as const;
const NOTE_TONE = { blocked: "text-blocked", accent: "text-accent", faint: "text-faint" } as const;

/** The List layout (X45, X50): a group per board column, rows that open into their sessions and worktrees, then sessions without a task. */
function TasksList({ host, workspaceId, views, unlinked }: { host: string; workspaceId: string; views: ColumnView[]; unlinked: { session: Card["rows"][number]["session"]; hint: string }[] }) {
  const expanded = useTasks((t) => t.expanded);
  const now = useNow(true);
  const groups = boardListGroups(views);
  const keyOf = (c: Card) => taskId(c.task);
  const toggle = (c: Card) => toggleExpanded(keyOf(c));
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
      {groups.map((g) => (
        <section key={g.name} aria-label={g.name} className="mb-4">
          <div className="flex items-center gap-2 border-b border-border pb-1.5 ui-text-13 text-fg">
            <TaskGlyph column={g.column} />
            {g.name}
            <span className="font-mono ui-text-12 text-faint">{g.cards.length}</span>
            {g.note && <span className={cx("ml-auto ui-text-12", NOTE_TONE[g.noteTone])}>{g.note}</span>}
          </div>
          {!g.folded &&
            g.cards.map((c) => {
              const r = listRow(c, now);
              const open = !!expanded[keyOf(c)];
              return (
                <div key={keyOf(c)} role="row" aria-label={`${c.task.key} ${c.task.title}`} className={cx("border-b border-border", r.needsYou && "bg-blocked/[0.04]")}>
                  <div className="flex items-center gap-3 py-2">
                    <button aria-label={`${open ? "Collapse" : "Expand"} ${c.task.key}`} aria-expanded={open} onClick={() => toggle(c)} className="text-muted hover:text-fg">
                      {open ? "▾" : "▸"}
                    </button>
                    <span className="font-mono ui-text-12 text-faint">{c.task.key}</span>
                    <button className="min-w-0 flex-1 truncate text-left ui-text-13.5 text-fg hover:underline" onClick={() => useTasks.setState({ selected: keyOf(c) })}>
                      {c.task.title}
                    </button>
                    {r.chip &&
                      (c.drift?.fix ? (
                        <button className="ui-text-12 text-accent hover:underline" onClick={() => void fixDrift(host, workspaceId, c)}>
                          {r.chip}
                        </button>
                      ) : (
                        <span className="ui-text-12 text-accent">{r.chip}</span>
                      ))}
                    <span title="Sessions" className="flex items-center gap-1">
                      {r.glyphs.map((st, i) => (
                        <StateGlyph key={i} state={st} size={11} />
                      ))}
                      <span className={cx("ui-text-12", SUM_TONE[r.sumTone])}>{r.sum}</span>
                    </span>
                    <span className={cx("w-[120px] truncate font-mono ui-text-12", PR_TONE[r.prTone])}>{r.pr}</span>
                    <span title="Worktrees" className="flex w-[36px] items-center gap-1 ui-text-12 text-faint">
                      <GitBranch size={12} />
                      {r.worktrees}
                    </span>
                    <span title="Updated" className="w-[80px] text-right ui-text-12 text-faint">
                      {r.updated}
                    </span>
                  </div>
                  {open && (
                    <div className="flex flex-col gap-1 pb-2 pl-7">
                      {c.rows.map((row) => (
                        <div key={row.session.id} className="flex items-center gap-2 ui-text-12.5">
                          <StateGlyph state={row.session.state} size={12} />
                          <button className="text-fg hover:underline" onClick={() => openSession(host, row.session.id)}>
                            {row.session.name}
                          </button>
                          <span className="font-mono ui-text-11.5 text-faint">{row.session.branch}</span>
                          <span className={cx("ml-auto font-mono ui-text-11.5", TONE[row.meta.tone])}>{row.meta.text}</span>
                        </div>
                      ))}
                      {c.orphans.map((w) => (
                        <div key={w.path} className="flex items-center gap-2 ui-text-12.5 text-muted">
                          <GitBranch size={12} />
                          <span className="font-mono">{w.branch}</span> worktree, no session
                          <button className="ml-auto text-accent hover:underline" onClick={() => startSession(host, workspaceId, c, w)}>
                            Start session
                          </button>
                        </div>
                      ))}
                      {c.rows.length === 0 && c.orphans.length === 0 && (
                        <button className="self-start text-accent hover:underline ui-text-12.5" onClick={() => startSession(host, workspaceId, c)}>
                          Start a session for {c.task.key}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
        </section>
      ))}
      <section aria-label="Sessions without a task" className="mb-4">
        <div className="flex items-center gap-2 border-b border-border pb-1.5 ui-text-13 text-fg">
          Sessions without a task
          <span className="font-mono ui-text-12 text-faint">{unlinked.length}</span>
        </div>
        {unlinked.map((u) => (
          <div key={u.session.id} className="flex w-full items-center gap-3 border-b border-border py-2">
            <button onClick={() => openSession(host, u.session.id)} className="flex min-w-0 items-center gap-3 text-left hover:underline">
              <StateGlyph state={u.session.state} size={13} />
              <span className="ui-text-13.5 text-fg">{u.session.name}</span>
            </button>
            <span className="font-mono ui-text-12 text-faint">{u.session.branch}</span>
            <span className="ml-auto ui-text-12 text-faint">{u.hint}</span>
            <button className="ui-text-12 text-accent hover:underline" onClick={() => useStore.setState({ dialog: { kind: "link-task", host, session: u.session.id } })}>
              Link to task
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}

const PRIORITY = ["No priority", "Low", "Medium", "High"];

/** Priority as 0–3 bars (X44). */
function PriorityBars({ n }: { n: number }) {
  return (
    <span title={PRIORITY[n] ?? "No priority"} className="inline-flex items-end gap-[2px]">
      {[0, 1, 2].map((j) => (
        <span key={j} style={{ height: 4 + j * 3 }} className={cx("w-[3px] rounded-[1px]", j < n ? "bg-muted" : "bg-border-strong")} />
      ))}
    </span>
  );
}

/**
 * The task's state, as a menu that moves it (X45 detail, X46 task bar): on a
 * tracker board, the board's columns by name, each moving to its first
 * status (X50); otherwise the four columns, or Open and Closed on GitHub.
 */
export function StateMenu({ host, workspaceId, task }: { host: string; workspaceId: string; task: Task }) {
  // The board's columns as saved, and the task's board after each sync.
  const boards = useTasks((t) => t.config?.boards);
  const data = useTasks((t) => t.data[wsKey(host, workspaceId)]);
  // A GitHub Project's item moves through its board's columns, like a tracker's (X50).
  const columns = useMemo(() => (task.github && !task.github.project ? [] : taskColumns(host, workspaceId, task)), [boards, data, task, host, workspaceId]);
  const scopes = useTasks((t) => t.ghScopes[host]);
  // Setting a Project item's Status needs gh's project scope: without it the menu says what to run.
  const lock = projectMoveLock(task, scopes);
  const locked = lock !== null;
  if (columns.length) {
    const { choices, current } = stateChoices(columns, task);
    const select = (
      <select
        aria-label={`State of ${task.key}`}
        disabled={locked}
        title={lock ?? undefined}
        className={cx(inputCls, "menu-select field-height")}
        value={current}
        onChange={(e) => {
          const c = choices[Number(e.target.value)];
          void moveTask(host, workspaceId, task, c.category, Date.now(), c.status);
        }}
      >
        {current < 0 && <option value={-1}>Not shown</option>}
        {choices.map((c, i) => (
          <option key={c.label} value={i}>
            {c.label}
          </option>
        ))}
      </select>
    );
    if (!locked) return select;
    return (
      <span className="flex flex-col gap-1">
        {select}
        <span className="ui-text-11.5 text-faint">{lock}</span>
      </span>
    );
  }
  // A Project's item before its board's columns are known: no Open/Closed to fall back on.
  if (task.github?.project) return <span className="ui-text-12.5 text-muted">{task.github.project.status ?? NO_STATUS}</span>;
  const options = stateOptions(task);
  const current = options.findIndex((o) => o.current);
  return (
    <select
      aria-label={`State of ${task.key}`}
      className="rounded-md border border-border-strong bg-panel-2 px-1.5 py-0.5 ui-text-12.5 text-fg"
      value={current}
      onChange={(e) => void moveTask(host, workspaceId, task, options[Number(e.target.value)].column)}
    >
      {current < 0 && <option value={-1}>Not shown</option>}
      {options.map((o, i) => (
        <option key={o.label} value={i}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** What moonlet did about the task (X45 Activity). */
function Activity({ task }: { task: Task }) {
  useTasks((t) => t.activity[`${task.connection} ${task.key}`]);
  const list = activityOf(task);
  if (!list.length) return null;
  return (
    <section aria-label="Activity" className="mt-4">
      <div className="ui-text-11.5 font-medium text-faint">Activity</div>
      <ol className="mt-1 flex flex-col gap-1">
        {list.map((e) => (
          <li key={`${e.at} ${e.text}`} className="flex gap-2 ui-text-12">
            <span className="w-[70px] shrink-0 text-faint">{ago(Date.now() - e.at)}</span>
            <span className="text-muted">{e.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}


/** Removes a worktree without a session, after a confirm that names lost changes (X45 detail). */
async function removeWorktree(host: string, w: BoardWorktree) {
  if (!w.project) return;
  const st = await rpc<{ files: unknown[] }>(host, M.gitStatus, { path: w.path }).catch(() => null);
  const dirty = !!st?.files.length;
  const ok = await askConfirm(removeWorktreeAsk(w.path, w.branch ?? w.path, dirty));
  if (!ok) return;
  try {
    await rpc(host, M.projectWorktreeRemove, { id: w.project, path: w.path });
    const ws = shownWorkspace(useStore.getState());
    if (ws) void refreshTasks(ws.host, ws.id);
  } catch (e) {
    errorToast(e);
  }
}
