// Tasks mode (X45): the sidebar's views and the board of the shown workspace's tasks.

import { ExternalLink, GitBranch, RotateCw, SquareTerminal, X } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { focusThrottle } from "../../lib/prPoll";
import { selectSession, shownWorkspace, useStore } from "../../lib/store";
import { type Column, taskStart } from "../../lib/tasks";
import { type BoardWorktree, type Card, type CardRow, outOfSync, sessionsWithoutTask, tasksBoard } from "../../lib/tasksBoard";
import { boardInput, fixDrift, isTasksMode, leaveTasksMode, putOffDrift, refreshTasks, toggleTasksMode, useTasks } from "../../lib/tasksStore";
import { startAction, withoutPutOff } from "../../lib/keepInStep";
import { boardSummary, syncedLabel, TASK_VIEWS, type TaskView, viewBoard, viewCounts } from "../../lib/tasksView";
import { useNow } from "../../lib/useNow";
import { wsKey } from "../../lib/workspaces";
import { Button, cx, Empty, IconButton, StateGlyph } from "../ui";

const COLUMNS: { id: Exclude<Column, "hidden" | "done">; label: string }[] = [
  { id: "todo", label: "Todo" },
  { id: "in_progress", label: "In Progress" },
  { id: "in_review", label: "In Review" },
];

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
  const done = column === "done";
  const pie = column === "in_progress" ? "M7 7 L7 4 A3 3 0 0 1 7 10 Z" : column === "in_review" ? "M7 7 L7 4 A3 3 0 1 1 4 7 Z" : "";
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
  useEffect(() => {
    if (!ws) return;
    const sync = () => void refreshTasks(ws.host, ws.id);
    sync();
    const due = focusThrottle(15_000);
    const onFocus = () => due(Date.now()) && sync();
    window.addEventListener("focus", onFocus);
    const timer = setInterval(sync, 60_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(timer);
    };
  }, [ws]);
}

/** The shown workspace's tasks and their board. */
function useWorkspaceTasks() {
  const ws = useStore((s) => shownWorkspace(s));
  const data = useTasks((t) => (ws ? t.data[wsKey(ws.host, ws.id)] : undefined));
  const notNow = useTasks((t) => t.notNow);
  // What the board reads of the main store; other changes (terminal output) don't rebuild it.
  const deps = useStore(useShallow((s) => [s.sessions, s.prs, s.git, s.terminals, s.reads]));
  return useMemo(() => {
    if (!ws || !data) return { ws, data, board: null, unlinked: [] };
    const input = boardInput(useStore.getState(), ws.host, ws.id, data);
    return { ws, data, board: withoutPutOff(tasksBoard(input), notNow), unlinked: sessionsWithoutTask(input.sessions, data.tasks) };
  }, [ws, data, notNow, ...deps]);
}

/** The sidebar body in Tasks mode: views with counts, then the sync line. */
export function TasksSidebar() {
  const { ws, data, board, unlinked } = useWorkspaceTasks();
  const view = useTasks((t) => t.view);
  const now = useNow(true);
  const counts = board ? viewCounts(board, unlinked.length) : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-4 pb-1 pt-2 ui-text-11.5 font-medium text-faint">Views</div>
      <nav aria-label="Views" className="px-2">
        {TASK_VIEWS.map((v) => (
          <button
            key={v.id}
            aria-current={view === v.id ? "page" : undefined}
            onClick={() => useTasks.setState({ view: v.id })}
            className={cx(
              "relative flex h-[34px] w-full items-center gap-3 rounded-md px-3 text-left ui-text-14",
              view === v.id ? "bg-selected text-fg" : "text-muted hover:bg-panel-2 hover:text-fg",
            )}
          >
            {view === v.id && <span className="absolute inset-y-0 left-0 w-[2px] bg-accent" />}
            <span className="flex-1">{v.label}</span>
            {counts && <span className={cx("font-mono ui-text-12 tabular-nums", v.id === "drift" && counts.drift ? "text-accent" : "text-faint")}>{counts[v.id]}</span>}
          </button>
        ))}
      </nav>
      <div className="flex-1" />
      {ws && data && data.sources.length > 0 && (
        <div className="flex items-center gap-2 px-4 py-2 ui-text-12 text-faint">
          <span className={cx("min-w-0 flex-1 truncate", data.error && "text-error")} title={data.error ?? undefined}>
            {data.error ? `GitHub sync failed · ${data.error}` : syncedLabel("GitHub", data.syncedAt, now)}
          </span>
          <IconButton title="Refresh from GitHub" onClick={() => void refreshTasks(ws.host, ws.id)}>
            <RotateCw size={13} />
          </IconButton>
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
function startSession(host: string, workspaceId: string, card: Card, worktree?: BoardWorktree) {
  const data = useTasks.getState().data[wsKey(host, workspaceId)];
  // The "session starts" rule at its default, Automatically, until X44's connection page sets it.
  const start = { ...taskStart(card.task, data?.repos ?? {}), assign: startAction(card.task, "auto") };
  useStore.setState({
    dialog: {
      kind: "new-session",
      host,
      project: start.project ?? undefined,
      workspace: workspaceId,
      task: start,
      worktree: worktree?.branch ? { path: worktree.path, branch: worktree.branch } : undefined,
    },
  });
}

function TaskCard({ host, workspaceId, card, selected }: { host: string; workspaceId: string; card: Card; selected: boolean }) {
  const pick = () => useTasks.setState({ selected: `${card.task.connection} ${card.task.key}` });
  return (
    <article
      aria-label={`${card.task.key} ${card.task.title}`}
      className={cx(
        "rounded-lg border px-3 py-2.5",
        selected ? "border-accent/60 bg-selected" : card.needsYou ? "border-blocked/35 bg-panel" : "border-border bg-panel",
      )}
    >
      <div className="flex items-center gap-2 font-mono ui-text-11.5 text-faint">{card.task.key}</div>
      <button className="mt-1 block w-full text-left ui-text-13.5 text-fg hover:underline" onClick={pick}>
        {card.task.title}
      </button>
      {card.rows.length > 0 ? (
        <div className="mt-2 flex flex-col gap-1">
          {card.rows.map((r) => (
            <button key={r.session.id} onClick={() => openSession(host, r.session.id)} className="flex items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-panel-2">
              <StateGlyph state={r.session.state} size={12} />
              <span className="min-w-0 flex-1 truncate ui-text-12.5 text-[#cfcfcf]">{r.session.name}</span>
              <span className={cx("font-mono ui-text-11.5 tabular-nums", TONE[r.meta.tone])}>{r.meta.text}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-1.5 ui-text-12 text-faint">
          {card.orphans.length > 0 && <GitBranch size={12} />}
          <span>{card.empty}</span>
          <button className="ml-auto font-medium text-accent hover:underline" onClick={() => startSession(host, workspaceId, card, card.orphans[0])}>
            {card.orphans.length ? "Start session" : "Start"}
          </button>
        </div>
      )}
      {card.drift && (
        <div className="mt-2 flex items-center gap-2 rounded-md bg-accent/[0.08] px-2 py-1 ui-text-12 text-accent">
          <span className="min-w-0 flex-1 truncate">{card.drift.text}</span>
          <button className="font-medium hover:underline" onClick={() => void fixDrift(host, workspaceId, card)}>
            {card.drift.fix}
          </button>
        </div>
      )}
    </article>
  );
}

function TaskDetail({ host, workspaceId, card }: { host: string; workspaceId: string; card: Card }) {
  return (
    <aside aria-label="Task detail" className="flex w-[360px] shrink-0 flex-col overflow-y-auto border-l border-border bg-panel">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="font-mono ui-text-12 text-muted">{card.task.key}</span>
        <a href={card.task.url} target="_blank" rel="noreferrer" className="ml-auto flex items-center gap-1 ui-text-12 text-muted hover:text-fg">
          Open in GitHub <ExternalLink size={12} />
        </a>
        <IconButton title="Close detail" onClick={() => useTasks.setState({ selected: null })}>
          <X size={14} />
        </IconButton>
      </div>
      <div className="px-4 py-3">
        <h2 className="ui-text-16 font-medium text-fg">{card.task.title}</h2>
        <div className="mt-2 flex items-center gap-2 ui-text-12.5 text-muted">
          <TaskGlyph column={card.column} size={13} />
          {COLUMNS.find((c) => c.id === card.column)?.label ?? "Done"}
          {card.task.labels.length > 0 && <span className="text-faint">· {card.task.labels.join(", ")}</span>}
        </div>
        {card.task.description && <p className="selectable mt-3 line-clamp-4 whitespace-pre-wrap ui-text-12.5 text-muted">{card.task.description}</p>}
        {card.drift && (
          <div className="mt-3 rounded-md border border-accent/30 bg-accent/[0.06] px-3 py-2 ui-text-12.5 text-accent">
            {card.drift.text}
            <div className="mt-2 flex gap-1.5">
              <Button size="sm" variant="primary" onClick={() => void fixDrift(host, workspaceId, card)}>
                {card.drift.fix}
              </Button>
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
        {card.rows.map((r) => (
          <div key={r.session.id} className="mt-2 flex items-center gap-2 rounded-lg border border-border px-3 py-2">
            <StateGlyph state={r.session.state} size={13} />
            <span className="min-w-0 flex-1 truncate ui-text-13 text-fg">{r.session.name}</span>
            <button className="rounded-md border border-border-strong px-2 py-0.5 ui-text-12 text-fg hover:bg-panel-2" onClick={() => openSession(host, r.session.id)}>
              Open
            </button>
          </div>
        ))}
        {card.orphans.length > 0 && <div className="mt-4 ui-text-11.5 font-medium text-faint">Worktrees without a session {card.orphans.length}</div>}
        {card.orphans.map((w) => (
          <div key={w.path} className="mt-2 flex items-center gap-2 ui-text-12.5 text-muted">
            <GitBranch size={13} />
            <span className="min-w-0 flex-1 truncate font-mono">{w.branch}</span>
            <button className="rounded-md border border-border-strong px-2 py-0.5 ui-text-12 text-fg hover:bg-panel-2" onClick={() => startSession(host, workspaceId, card, w)}>
              Start session
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}

const TITLE: Record<TaskView, string> = { mine: "My issues", review: "In review", drift: "Out of sync", unlinked: "Sessions without a task" };

/** The centre in Tasks mode: the view's board and the selected task's detail. */
export function TasksMode() {
  useTaskSync();
  const { ws, data, board, unlinked } = useWorkspaceTasks();
  const view = useTasks((t) => t.view);
  const selected = useTasks((t) => t.selected);
  if (!ws) return null;
  if (!data) return <Empty title="Loading tasks…" />;
  if (data.sources.length === 0) {
    return (
      <Empty title="No task tracker in this workspace">
        Tasks mode shows the issues of this workspace's projects. Projects with a GitHub origin show their GitHub issues here.
      </Empty>
    );
  }
  if (!board) return null;
  const shown = viewBoard(board, view);
  const cards = Object.values(board).flat();
  const detail = cards.find((c) => `${c.task.connection} ${c.task.key}` === selected);
  return (
    <div className="flex h-full min-w-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header data-tauri-drag-region className="drag flex h-[52px] shrink-0 items-center gap-3 px-5">
          <h1 className="ui-text-15 font-medium text-fg">{TITLE[view]}</h1>
          <span className="ui-text-12.5 text-faint">{boardSummary(board)}</span>
        </header>
        {view === "unlinked" ? (
          <section aria-label="Sessions without a task" className="overflow-y-auto px-5">
            {unlinked.length === 0 && <p className="ui-text-13 text-muted">Every session is linked to a task.</p>}
            {unlinked.map((u) => (
              <button key={u.session.id} onClick={() => openSession(ws.host, u.session.id)} className="flex w-full items-center gap-3 border-b border-border py-2 text-left hover:bg-panel-2">
                <StateGlyph state={u.session.state} size={13} />
                <span className="ui-text-13.5 text-fg">{u.session.name}</span>
                <span className="font-mono ui-text-12 text-faint">{u.session.branch}</span>
                <span className="ml-auto ui-text-12 text-faint">{u.hint}</span>
              </button>
            ))}
          </section>
        ) : (
          <div className="flex min-h-0 flex-1 gap-4 overflow-x-auto px-5 pb-4">
            {COLUMNS.map((col) => (
              <section key={col.id} aria-label={col.label} className="flex w-[280px] shrink-0 flex-col">
                <div className="mb-2 flex items-center gap-2 ui-text-13 text-fg">
                  <TaskGlyph column={col.id} />
                  {col.label}
                  <span className="font-mono ui-text-12 text-faint">{shown[col.id].length}</span>
                </div>
                <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
                  {shown[col.id].map((c) => (
                    <TaskCard key={c.task.key} host={ws.host} workspaceId={ws.id} card={c} selected={c === detail} />
                  ))}
                </div>
              </section>
            ))}
            <section aria-label={`Done: ${shown.done.length} tasks`} className="flex w-[64px] shrink-0 flex-col items-center gap-2 pt-0.5 ui-text-13 text-muted">
              <TaskGlyph column="done" />
              Done
              <span className="font-mono ui-text-12 text-faint">{shown.done.length}</span>
            </section>
          </div>
        )}
      </div>
      {detail && <TaskDetail host={ws.host} workspaceId={ws.id} card={detail} />}
    </div>
  );
}

/** Sessions | Tasks beside the workspace switcher (X45), with a dot when tasks are out of sync. */
export function ModeSwitch() {
  const tasks = useStore((s) => isTasksMode(s));
  const { board } = useWorkspaceTasks();
  const drift = board ? outOfSync(board).length : 0;
  const item = "no-drag relative flex h-[26px] w-[30px] items-center justify-center rounded-[5px]";
  return (
    <div role="group" aria-label="Mode" className="ml-auto flex shrink-0 items-center gap-0.5 rounded-md bg-panel-2 p-0.5">
      <button aria-label="Sessions" aria-pressed={!tasks} title="Sessions  ⌃⌘T" onClick={() => tasks && toggleTasksMode()} className={cx(item, !tasks ? "bg-raised text-fg" : "text-muted hover:text-fg")}>
        <SquareTerminal size={14} />
      </button>
      <button
        aria-label={drift ? `Tasks, ${drift} out of sync` : "Tasks"}
        aria-pressed={tasks}
        title="Tasks  ⌃⌘T"
        onClick={() => !tasks && toggleTasksMode()}
        className={cx(item, tasks ? "bg-raised text-fg" : "text-muted hover:text-fg")}
      >
        <TaskGlyph column="in_progress" size={14} />
        {drift > 0 && <span aria-hidden="true" className="absolute right-[3px] top-[3px] h-[6px] w-[6px] rounded-full bg-accent" />}
      </button>
    </div>
  );
}
