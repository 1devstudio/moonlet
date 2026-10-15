// A session's task (X46): the task bar above the conversation, the right
// panel's Task tab and the link dialog.

import { ChevronLeft, ChevronRight, ExternalLink, GitBranch, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { hostsApi } from "../../lib/daemon";
import type { Session } from "../../lib/protocol";
import { selectSession, useStore } from "../../lib/store";
import { acceptanceCriteria, findPasted, linkChoices } from "../../lib/taskLinking";
import { type Task, trackerName } from "../../lib/tasks";
import type { Card } from "../../lib/tasksBoard";
import { ensureTasks, linkTask, lookUpPasted, openInTasksMode, setKeepInStep, useTasks } from "../../lib/tasksStore";
import { wsKey } from "../../lib/workspaces";
import { Button, cx, Dialog, IconButton, inputCls, StateGlyph } from "../ui";
import { StateMenu, startSession, TaskGlyph, useWorkspaceBoard } from "./TasksMode";

const COLUMN_LABEL: Record<Card["column"], string> = { todo: "Todo", in_progress: "In Progress", in_review: "In Review", done: "Done" };

/** The card of the task a session works on, loading its workspace's tasks when needed. */
export function useSessionTask(host: string, ws: Session): Card | null {
  const ref = useMemo(() => (ws.workspace_id ? { host, id: ws.workspace_id } : null), [host, ws.workspace_id]);
  useEffect(() => {
    if (ref && (ws.task || !ws.task_unlinked)) ensureTasks(ref.host, ref.id);
  }, [ref, ws.task, ws.task_unlinked]);
  const { board } = useWorkspaceBoard(ref);
  return useMemo(() => (board ? (Object.values(board).flat().find((c) => c.rows.some((r) => r.session.id === ws.id)) ?? null) : null), [board, ws.id]);
}

/** Above the conversation: the way back to Tasks, the task, its state and its other sessions. */
export function TaskBar({ host, ws }: { host: string; ws: Session }) {
  const card = useSessionTask(host, ws);
  if (!card) return null;
  const at = card.rows.findIndex((r) => r.session.id === ws.id);
  const go = (d: number) => selectSession(host, card.rows[(at + d + card.rows.length) % card.rows.length].session.id);
  return (
    <div role="region" aria-label="Task" className="flex h-[34px] shrink-0 items-center gap-2 border-b border-border bg-panel px-4 ui-text-12.5">
      <button className="flex items-center gap-1.5 text-muted hover:text-fg" title="Show this task in Tasks mode" onClick={() => openInTasksMode(card.task)}>
        Tasks
      </button>
      <span className="text-faint">/</span>
      <TaskGlyph column={card.column} size={13} />
      <span className="font-mono text-muted">{card.task.key}</span>
      <span className="min-w-0 truncate text-fg">{card.task.title}</span>
      {ws.workspace_id ? <StateMenu host={host} workspaceId={ws.workspace_id} task={card.task} /> : <span className="shrink-0 text-faint">{COLUMN_LABEL[card.column]}</span>}
      {card.rows.length > 1 && (
        <div role="group" aria-label="Sessions on this task" className="ml-2 flex items-center gap-0.5 text-muted">
          <IconButton title="Previous session on this task" onClick={() => go(-1)}>
            <ChevronLeft size={14} />
          </IconButton>
          Session {at + 1} of {card.rows.length}
          <IconButton title="Next session on this task" onClick={() => go(1)}>
            <ChevronRight size={14} />
          </IconButton>
        </div>
      )}
      <a href={card.task.url} target="_blank" rel="noreferrer" className="ml-auto flex shrink-0 items-center gap-1 text-muted hover:text-fg">
        {trackerName(card.task.connection)} <ExternalLink size={12} />
      </a>
    </div>
  );
}

/** The right panel's Task tab (X46). */
export function TaskTab({ host, ws }: { host: string; ws: Session }) {
  const card = useSessionTask(host, ws);
  if (!card) return <p className="p-4 ui-text-12.5 text-muted">Not linked to a task.</p>;
  const criteria = acceptanceCriteria(card.task.description);
  const done = criteria.filter((c) => c.done).length;
  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <div className="flex items-center gap-2 font-mono ui-text-12 text-muted">
          <TaskGlyph column={card.column} size={13} />
          {card.task.key}
        </div>
        <h2 className="mt-1 ui-text-15 font-medium text-fg">{card.task.title}</h2>
        <div className="mt-1 ui-text-12 text-faint">
          {["No priority", "Low priority", "Medium priority", "High priority"][card.task.priority] ?? "No priority"}
          {card.task.cycle !== undefined && ` · Cycle ${card.task.cycle}`}
          {card.task.assignees.length > 0 && ` · ${card.task.assignees.join(", ")}`}
        </div>
        {card.task.description && <p className="selectable mt-2 line-clamp-6 whitespace-pre-wrap ui-text-12.5 text-muted">{card.task.description}</p>}
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
              <button className="text-muted hover:text-fg" onClick={() => selectSession(host, r.session.id)}>
                Open
              </button>
            )}
          </div>
        ))}
        {card.orphans.map((w) => (
          <div key={w.path} className="mt-1.5 flex items-center gap-2 ui-text-12.5 text-muted">
            <GitBranch size={13} />
            <span className="min-w-0 flex-1 truncate font-mono">{w.branch}</span>
            <button className="hover:text-fg" onClick={() => ws.workspace_id && startSession(host, ws.workspace_id, card, w)}>
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
    </div>
  );
}

/** Link "<session>" to a task: suggestions, the workspace's tasks, or a pasted key or URL (X46). */
export function LinkTaskDialog({ host, sessionId }: { host: string; sessionId: string }) {
  const ws = useStore((s) => s.sessions[host]?.find((x) => x.id === sessionId));
  const data = useTasks((t) => (ws?.workspace_id ? t.data[wsKey(host, ws.workspace_id)] : undefined));
  const [query, setQuery] = useState("");
  const [pasted, setPasted] = useState<Task | null>(null);
  const close = () => useStore.setState({ dialog: null });
  const tasks = useMemo(() => data?.tasks ?? [], [data]);
  const originRepo = ws ? (data?.repos[ws.project_id] ?? null) : null;
  useEffect(() => {
    if (ws?.workspace_id) ensureTasks(host, ws.workspace_id);
  }, [host, ws?.workspace_id]);
  useEffect(() => {
    let live = true;
    void hostsApi.parsePasted(query).then(
      async (p) => {
        // A task outside the loaded ones is asked of its tracker.
        const found = p ? (findPasted(p, tasks, originRepo) ?? (ws ? await lookUpPasted(host, ws.path, p, originRepo) : null)) : null;
        if (live) setPasted(found);
      },
      () => live && setPasted(null),
    );
    return () => {
      live = false;
    };
  }, [query, tasks, originRepo, host, ws?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ws) return null;
  const choices = linkChoices(ws, tasks, pasted ? "" : query);
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
        <input autoFocus className={inputCls} placeholder="Search tasks, or paste a key or URL" value={query} onChange={(e) => setQuery(e.target.value)} />
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
            {choices.recent.slice(0, 20).map((t) => row(t))}
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
