// A session's task (X46): the task bar above the conversation, the right
// panel's Task tab and the link dialog.

import { ChevronLeft, ChevronRight, ExternalLink, GitBranch, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { taskWorkspace } from "../../lib/boards";
import { hostsApi } from "../../lib/daemon";
import type { Session } from "../../lib/protocol";
import { hostWorkspaces, selectSession, useStore } from "../../lib/store";
import { acceptanceCriteria, findPasted, linkChoices, pasteLookup } from "../../lib/taskLinking";
import { type Task, trackerName } from "../../lib/tasks";
import type { Card } from "../../lib/tasksBoard";
import { ensureTasks, linkTask, lookUpPasted, originRepoOf, placedTasks, setKeepInStep, trackersConfig, useTasks } from "../../lib/tasksStore";
import { type WorkspaceRef, wsKey } from "../../lib/workspaces";
import { Markdown } from "../AgentView";
import { Button, cx, Dialog, IconButton, inputCls, StateGlyph } from "../ui";
import { StateMenu, startSession, TaskGlyph, useWorkspaceBoard } from "./TasksMode";
import { TaskComments } from "./TaskComments";

/** The workspace whose boards hold a session's task: on another member of its account when the boards are there (X68). */
function useTaskWorkspace(host: string, workspaceId: string | null | undefined): WorkspaceRef | null {
  const boards = useTasks((t) => trackersConfig(t).boards);
  // What the members of the workspace's account read of the store; other changes (terminal output) don't recompute it.
  const deps = useStore(useShallow((s) => [s.hosts, s.accounts, s.workspaces]));
  return useMemo(() => (workspaceId ? taskWorkspace(host, workspaceId, hostWorkspaces(useStore.getState()), boards) : null), [host, workspaceId, boards, ...deps]);
}

/** The task a session works on, and the workspace whose boards it is on: its
 * state menu, comments and worktrees act there (X68). */
export interface SessionTask {
  card: Card;
  board: WorkspaceRef;
}

/** The card of the task a session works on, loading its workspace's tasks when needed. */
export function useSessionTask(host: string, ws: Session): SessionTask | null {
  const ref = useTaskWorkspace(host, ws.workspace_id);
  useEffect(() => {
    if (ref && (ws.task || !ws.task_unlinked)) ensureTasks(ref.host, ref.id);
  }, [ref, ws.task, ws.task_unlinked]);
  const { board } = useWorkspaceBoard(ref);
  return useMemo(() => {
    const card = board ? Object.values(board).flat().find((c) => c.rows.some((r) => r.session.id === ws.id)) : undefined;
    return card && ref ? { card, board: ref } : null;
  }, [board, ref, ws.id]);
}

/** Above the conversation: the task, its state and its other sessions. */
export function TaskBar({ host, ws }: { host: string; ws: Session }) {
  const linked = useSessionTask(host, ws);
  if (!linked) return null;
  const { card, board } = linked;
  const at = card.rows.findIndex((r) => r.session.id === ws.id);
  const go = (d: number) => selectSession(card.rows[(at + d + card.rows.length) % card.rows.length].session.host ?? host, card.rows[(at + d + card.rows.length) % card.rows.length].session.id);
  return (
    <div role="region" aria-label="Task" className="flex min-h-[40px] shrink-0 items-center gap-2.5 border-b border-border bg-panel py-1.5 pr-3 pl-4 ui-text-12.5">
      <TaskGlyph column={card.column} size={14} />
      <span className="shrink-0 whitespace-nowrap font-mono ui-text-12 text-muted">{card.task.key}</span>
      <span className="min-w-0 truncate font-medium text-fg">{card.task.title}</span>
      <StateMenu host={board.host} workspaceId={board.id} task={card.task} chip />
      <span className="flex-1" />
      {card.rows.length > 1 && (
        <div role="group" aria-label="Sessions on this task" className="flex shrink-0 items-center gap-0.5 whitespace-nowrap ui-text-12 text-muted">
          <IconButton title="Previous session on this task" onClick={() => go(-1)}>
            <ChevronLeft size={14} />
          </IconButton>
          <span>
            Session <span className="text-fg">{at + 1}</span> of {card.rows.length}
          </span>
          <IconButton title="Next session on this task" onClick={() => go(1)}>
            <ChevronRight size={14} />
          </IconButton>
        </div>
      )}
      <a href={card.task.url} target="_blank" rel="noreferrer" className="flex shrink-0 items-center gap-1 ui-text-12 text-accent-2 hover:text-accent">
        {trackerName(card.task.connection)} <ExternalLink size={12} />
      </a>
    </div>
  );
}

/** The right panel's Task tab (X46). */
export function TaskTab({ host, ws }: { host: string; ws: Session }) {
  const linked = useSessionTask(host, ws);
  if (!linked) return <p className="p-4 ui-text-12.5 text-muted">Not linked to a task.</p>;
  const { card, board } = linked;
  const criteria = acceptanceCriteria(card.task.description);
  const done = criteria.filter((c) => c.done).length;
  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <div className="flex items-center gap-2 font-mono ui-text-12 text-muted">
          <TaskGlyph column={card.column} size={13} />
          {card.task.key}
          <span className="ml-auto font-sans">
            <StateMenu host={board.host} workspaceId={board.id} task={card.task} />
          </span>
        </div>
        <h2 className="mt-1 ui-text-15 font-medium text-fg">{card.task.title}</h2>
        <div className="mt-1 ui-text-12 text-faint">
          {["No priority", "Low priority", "Medium priority", "High priority"][card.task.priority] ?? "No priority"}
          {card.task.cycle !== undefined && ` · Cycle ${card.task.cycle}`}
          {card.task.assignees.length > 0 && ` · ${card.task.assignees.join(", ")}`}
        </div>
        {card.task.description && (
          <div className="mt-2">
            <Markdown text={card.task.description} task />
          </div>
        )}
      </div>
      {criteria.length > 0 && (
        <section aria-label="Acceptance criteria">
          <div className="ui-text-11.5 font-medium text-faint">
            Acceptance criteria · {done} of {criteria.length}
          </div>
          <ul className="mt-1.5 flex flex-col gap-1">
            {criteria.map((c) => (
              <li key={c.text} className={cx("flex items-start gap-2 ui-text-12.5", c.done ? "text-muted line-through" : "text-fg")}>
                <input type="checkbox" checked={c.done} readOnly className="mt-0.5" aria-label={c.text} />
                {c.text}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-label="Sessions on this task">
        <div className="ui-text-11.5 font-medium text-faint">Sessions on this task {card.rows.length}</div>
        {card.rows.map((r) => (
          <div key={r.session.id} className="mt-1.5 flex items-center gap-2 ui-text-12.5">
            <StateGlyph state={r.session.state} size={12} />
            <span className="min-w-0 flex-1 truncate text-fg">{r.session.name}</span>
            {r.session.id === ws.id ? (
              <span className="text-faint">this session</span>
            ) : (
              <button className="text-muted hover:text-fg" onClick={() => selectSession(r.session.host ?? host, r.session.id)}>
                Open
              </button>
            )}
          </div>
        ))}
        {card.orphans.map((w) => (
          <div key={w.path} className="mt-1.5 flex items-center gap-2 ui-text-12.5 text-muted">
            <GitBranch size={13} />
            <span className="min-w-0 flex-1 truncate font-mono">{w.branch}</span>
            <button className="hover:text-fg" onClick={() => startSession(board.host, board.id, card, w)}>
              Start session
            </button>
          </div>
        ))}
      </section>
      <KeepInStep task={card.task} />
      <div className="flex gap-2">
        <Button size="sm" variant="ghost" onClick={() => useStore.setState({ dialog: { kind: "link-task", host, session: ws.id } })}>
          Link to another task
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void linkTask(host, ws.id, null)}>
          Unlink
        </Button>
      </div>
      <TaskComments host={board.host} workspaceId={board.id} task={card.task} />
    </div>
  );
}

/** Link "<session>" to a task: suggestions, the workspace's tasks, or a pasted key or URL (X46). */
export function LinkTaskDialog({ host, sessionId }: { host: string; sessionId: string }) {
  const ws = useStore((s) => s.sessions[host]?.find((x) => x.id === sessionId));
  // The tasks of the boards the session's task is on, whichever member holds them (X68).
  const boardRef = useTaskWorkspace(host, ws?.workspace_id);
  const data = useTasks((t) => (boardRef ? t.data[wsKey(boardRef.host, boardRef.id)] : undefined));
  const [query, setQuery] = useState("");
  const [pasted, setPasted] = useState<Task | null>(null);
  const close = () => useStore.setState({ dialog: null });
  const config = useTasks((t) => t.config);
  const tasks = useMemo(() => placedTasks(data ?? { tasks: [] }), [data, config]); // eslint-disable-line react-hooks/exhaustive-deps
  // The repository of the session's project, which on another member has another id (X68).
  const originRepo = useStore((s) => (ws && data && boardRef ? originRepoOf(s, boardRef.host, data, host, ws.project_id) : null));
  const { board } = useWorkspaceBoard(boardRef);
  const sessionsOf = useMemo(() => {
    const n = new Map(Object.values(board ?? {}).flat().map((c) => [`${c.task.connection} ${c.task.key}`, c.rows.length]));
    return (t: Task) => n.get(`${t.connection} ${t.key}`) ?? 0;
  }, [board]);
  useEffect(() => {
    if (boardRef) ensureTasks(boardRef.host, boardRef.id);
  }, [boardRef]);
  // The latest tasks, read when a lookup runs, so a background sync does not
  // throw away what was pasted.
  const latest = useRef(tasks);
  latest.current = tasks;
  const [lookup] = useState(() => pasteLookup());
  const latestChoices = useRef<ReturnType<typeof linkChoices>>({ suggested: [], recent: [] });
  const loaded = !!data;
  // What the last lookup was asked with, so new tasks or a repository force a new one.
  const askedWith = useRef("");
  useEffect(() => {
    const context = `${loaded} ${originRepo}`;
    const force = askedWith.current !== "" && askedWith.current !== context;
    askedWith.current = context;
    setPasted(null);
    void lookup
      .query(
        query,
        async () => {
          const p = await hostsApi.parsePasted(query);
          // A task outside the loaded ones is asked of its tracker.
          return p ? (findPasted(p, latest.current, originRepo) ?? (ws ? await lookUpPasted(host, ws.path, p, originRepo) : null)) : null;
        },
        force,
      )
      .then((found) => found !== undefined && setPasted(found));
    // Once the workspace's tasks and repository arrive, `#12` is looked up again.
  }, [query, host, ws?.path, originRepo, loaded]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => lookup.cancel(), [lookup]);
  if (!ws) return null;
  const choices = linkChoices(ws, tasks, pasted ? "" : query, sessionsOf);
  latestChoices.current = choices;
  const pick = (t: Task) => {
    close();
    void linkTask(host, ws.id, t);
  };
  const row = (t: Task, reason?: string) => (
    <button key={t.key} onClick={() => pick(t)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-panel-2">
      <span className="shrink-0 font-mono ui-text-12 text-muted">{t.key}</span>
      <span className="min-w-0 flex-1 truncate ui-text-13 text-fg">{t.title}</span>
      {reason && <span className="shrink-0 ui-text-11.5 text-faint">{reason}</span>}
    </button>
  );
  return (
    <Dialog title={`Link “${ws.name}” to a task`} onClose={close} width={560}>
      <label className="flex items-center gap-2">
        <Search size={14} className="text-muted" />
        <span className="sr-only">Search tasks</span>
        <input
          autoFocus
          className={inputCls}
          placeholder="Search tasks, or paste a key or URL"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            // A paste still being looked up decides what ↵ links, from the
            // lists as they are when it ends, once.
            void lookup.enter(() => latestChoices.current, pick);
          }}
        />
      </label>
      <div className="mt-3 flex max-h-[360px] flex-col gap-3 overflow-y-auto">
        {pasted && <section aria-label="Pasted">{row(pasted, "Pasted")}</section>}
        {!pasted && choices.suggested.length > 0 && (
          <section aria-label="Suggested">
            <div className="px-2 ui-text-11.5 font-medium text-faint">Suggested</div>
            {choices.suggested.map((s) => row(s.task, s.reason))}
          </section>
        )}
        {!pasted && choices.recent.length > 0 && (
          <section aria-label="Recent">
            <div className="px-2 ui-text-11.5 font-medium text-faint">Recent</div>
            {choices.recent.map((t) => row(t))}
          </section>
        )}
        {!pasted && !choices.suggested.length && !choices.recent.length && <p className="px-2 ui-text-12.5 text-muted">No tasks match.</p>}
      </div>
      <p className="mt-3 ui-text-11.5 text-faint">Links live in moonlet; the tracker hears of a PR only through Keep in step.</p>
    </Dialog>
  );
}

/** "Keep <tracker> in step" for this one task: off stops every rule for it (X46). */
function KeepInStep({ task }: { task: Task }) {
  const on = useTasks((t) => !t.paused[`${task.connection} ${task.key}`]);
  return (
    <label className="flex items-start gap-2 rounded-lg border border-border px-3 py-2 ui-text-12.5">
      <input type="checkbox" role="switch" aria-label={`Keep ${trackerName(task.connection)} in step`} checked={on} onChange={(e) => setKeepInStep(task, e.target.checked)} className="mt-0.5" />
      <span>
        <span className="text-fg">Keep {trackerName(task.connection)} in step</span>
        <span className="block text-muted">
          {on ? "Starting sessions, opening and merging their PRs move this issue as Settings › Task trackers says." : "moonlet leaves this issue alone, and shows no out-of-sync chips for it."}
        </span>
      </span>
    </label>
  );
}
