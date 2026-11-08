// Search the board (X93): Find a task in the board header, its dropdown, and
// the preview of a task the board doesn't show.

import { ExternalLink, Play, Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { type BoardSearch as Result, type Found, type Hit, type OffRow, type OtherBoard, previewOf, searchBoard, searchFooter } from "../../lib/boardSearch";
import type { ColumnView } from "../../lib/boardColumns";
import { moveHighlight } from "../../lib/addProject";
import { claimKeys } from "../../lib/keys";
import { fromOtherDialog } from "../../lib/modal";
import { useStore } from "../../lib/store";
import { taskId, trackerName, trackerOf } from "../../lib/tasks";
import { composerTask, findTask, moveTask, searchOf, searchTrackers, setTaskQuery, showBoard, trackerSearchOf, useTasks } from "../../lib/tasksStore";
import { Markdown } from "../AgentView";
import { BoardTile, Button, cx, IconButton, Kbd, StateGlyph } from "../ui";
import { TaskGlyph } from "./TasksMode";

const MARK = "rounded-[2px] bg-accent/[0.28] text-fg";
const NONE_FOUND: Found[] = [];

/** Text with its match marked. */
function Marked({ hit }: { hit: Hit }) {
  return (
    <>
      {hit.pre}
      {hit.mid && <mark className={MARK}>{hit.mid}</mark>}
      {hit.post}
    </>
  );
}

/** Scrolls the found card or List row into view, once the board has drawn it (its column may have just opened). */
export function scrollToTask(id: string) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => document.querySelector(`[data-task-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" })),
  );
}

/**
 * The header's Find a task (X93): a combobox whose dropdown lists the tasks
 * on the board (picking one marks it found) and off it (picking one opens
 * its preview). The board itself is never filtered.
 */
export function FindTask({ host, workspaceId, views, others, shownLabel, footer }: {
  host: string;
  workspaceId: string;
  /** The shown board's columns as drawn, after the header's filters. */
  views: ColumnView[];
  others: OtherBoard[];
  shownLabel: string;
  /** Shown under the results when nothing matched: Create “…” in a tracker. */
  footer?: (query: string) => React.ReactNode;
}) {
  const { query } = useTasks((t) => searchOf(t, host, workspaceId));
  // What the trackers' search found for this query (X93); before it answers, nothing.
  const ts = useTasks((t) => trackerSearchOf(t, host, workspaceId));
  const current = ts.query === query.trim();
  const found = current ? ts.found : NONE_FOUND;
  const searching = current ? ts.searching : [];
  const failed = current ? ts.failed : [];
  useEffect(() => void searchTrackers(host, workspaceId, query), [host, workspaceId, query]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [preview, setPreview] = useState<OffRow | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const list = useId();
  const result: Result = useMemo(() => searchBoard(query, views, others, found), [query, views, others, found]);
  const rows = [...result.on.map((r) => ({ id: r.id, on: true as const })), ...result.off.map((r) => ({ id: r.id, on: false as const }))];
  const shown = open && !!query.trim();
  const { count, none } = searchFooter(result, ts.trackers);
  // No match is only said once every search answered.
  const pending = !current || searching.length > 0;

  // ⌘F in Tasks mode is Find a task (X93), not the terminal's find.
  useEffect(
    () =>
      claimKeys((id) => {
        if (id !== "cmd+f") return false;
        input.current?.focus();
        input.current?.select();
        setOpen(true);
        return true;
      }),
    [],
  );
  // A click outside closes the dropdown.
  useEffect(() => {
    if (!shown) return;
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [shown]);
  useEffect(() => setActive(0), [query]);

  const pickOn = (id: string) => {
    findTask(host, workspaceId, id);
    setOpen(false);
    scrollToTask(id);
  };
  const pick = (i: number) => {
    const row = rows[i];
    if (!row) return;
    if (row.on) return pickOn(row.id);
    setOpen(false);
    setPreview(result.off.find((r) => r.id === row.id) ?? null);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!shown) return setOpen(true);
      if (rows.length) setActive((a) => moveHighlight(a, e.key as "ArrowUp" | "ArrowDown", rows.length));
    } else if (e.key === "Enter" && shown) {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (shown) setOpen(false);
      else setTaskQuery(host, workspaceId, "");
    }
  };
  const optionId = (i: number) => `${list}-${i}`;

  return (
    <div ref={box} className="no-drag relative min-w-[130px] max-w-[440px] flex-[1_1_220px]">
      <label className={cx("flex h-8 items-center gap-2 rounded-lg border bg-raised pl-2.5 pr-1.5", shown ? "border-accent" : "border-border-strong")}>
        <Search size={14} className="shrink-0 text-muted" />
        <input
          ref={input}
          aria-label="Find a task"
          role="combobox"
          aria-expanded={shown}
          aria-controls={list}
          aria-activedescendant={shown && rows.length ? optionId(active) : undefined}
          placeholder="Find a task: key, title, session or branch"
          value={query}
          onChange={(e) => {
            setTaskQuery(host, workspaceId, e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onKeyDown={onKey}
          className="min-w-0 flex-1 bg-transparent ui-text-13 text-fg outline-none placeholder:text-muted"
        />
        {query ? (
          <IconButton
            title="Clear search"
            onClick={() => {
              setTaskQuery(host, workspaceId, "");
              input.current?.focus();
            }}
            className="h-[22px] w-[22px]"
          >
            <X size={12} />
          </IconButton>
        ) : (
          <Kbd>⌘F</Kbd>
        )}
      </label>
      {shown && (
        <section id={list} role="listbox" aria-label="Tasks found" className="absolute left-0 top-[38px] z-30 flex w-[520px] flex-col overflow-hidden rounded-xl border border-border-strong bg-raised shadow-[0_20px_50px_rgba(0,0,0,0.6)]">
          {result.on.length > 0 && (
            <>
              <GroupHead name={`On this board · ${result.on.length}`} hint="selects it on the board" />
              <div className="flex flex-col px-1.5 pb-1.5 pt-0.5">
                {result.on.map((r, i) => (
                  <button
                    key={r.id}
                    id={optionId(i)}
                    type="button"
                    role="option"
                    aria-selected={active === i}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseMove={() => setActive(i)}
                    onClick={() => pick(i)}
                    className={cx("flex items-start gap-2.5 rounded-lg px-2 py-[7px] text-left", active === i && "bg-hover")}
                  >
                    <span className="mt-0.5">
                      <TaskGlyph column={r.category} />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="shrink-0 font-mono ui-text-12 text-muted">
                          <Marked hit={r.key} />
                        </span>
                        <span className="min-w-0 truncate ui-text-13.5 text-fg">
                          <Marked hit={r.title} />
                        </span>
                      </span>
                      {r.via && (
                        <span className="flex min-w-0 items-center gap-1.5 ui-text-12 text-faint">
                          <StateGlyph state={r.via.state} size={11} />
                          <span className="truncate">
                            {r.via.what} <Marked hit={r.via.text} />
                          </span>
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-1 pt-px">
                      {r.sessions.map((st, j) => (
                        <StateGlyph key={j} state={st} size={12} />
                      ))}
                    </span>
                    <span className="w-[84px] shrink-0 truncate pt-px text-right ui-text-12 text-faint">{r.column}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {result.off.length > 0 && (
            <>
              <GroupHead name={`Not on this board · ${result.off.length}`} hint="opens a preview" divided={result.on.length > 0} />
              <div className="flex flex-col px-1.5 pb-1.5 pt-0.5">
                {result.off.map((r, j) => {
                  const i = result.on.length + j;
                  return (
                    <button
                      key={r.id}
                      id={optionId(i)}
                      type="button"
                      role="option"
                      aria-selected={active === i}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseMove={() => setActive(i)}
                      onClick={() => pick(i)}
                      className={cx("flex items-center gap-2.5 rounded-lg px-2 py-[7px] text-left", active === i && "bg-hover")}
                    >
                      <TaskGlyph column={r.glyph} dashed={r.backlog} />
                      <span className="shrink-0 font-mono ui-text-12 text-muted">
                        <Marked hit={r.key} />
                      </span>
                      <span className="min-w-0 flex-1 truncate ui-text-13.5 text-fg">
                        <Marked hit={r.title} />
                      </span>
                      <span className="shrink-0 ui-text-12 text-faint">{r.where}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
          {searching.length > 0 && <div className="px-3.5 py-2 ui-text-12 text-faint">Searching {searching.join(" and ")}…</div>}
          {failed.map((f) => (
            <div key={f.tracker} className="px-3.5 py-2 ui-text-12 text-error">
              Couldn’t search {f.tracker}: {f.error}
            </div>
          ))}
          {none && !pending && (
            <div className="flex flex-col gap-1.5 px-3.5 py-4">
              <span className="ui-text-13.5 text-fg">No task matches “{query.trim()}”</span>
              <span className="ui-text-12 text-muted">{none}</span>
              {footer?.(query.trim())}
            </div>
          )}
          <div className="flex h-[34px] items-center gap-3 border-t border-border px-3.5 ui-text-11.5 text-faint">
            <span className="flex items-center gap-1.5">
              <Kbd>↑↓</Kbd>move
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>↵</Kbd>open
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>esc</Kbd>close
            </span>
            <span className="flex-1" />
            <span>{count}</span>
          </div>
        </section>
      )}
      {preview && <TaskPreview host={host} workspaceId={workspaceId} row={preview} shownLabel={shownLabel} sessions={sessionsOn(others, preview.id)} onClose={() => setPreview(null)} />}
    </div>
  );
}

function GroupHead({ name, hint, divided }: { name: string; hint: string; divided?: boolean }) {
  return (
    <div className={cx("flex h-7 items-center px-3.5 pt-1.5 ui-text-11 uppercase tracking-[0.08em] text-faint", divided && "border-t border-border")}>
      <span className="flex-1">{name}</span>
      <span className="normal-case tracking-normal">{hint}</span>
    </div>
  );
}

/** The names of the sessions on task `id`'s card on another board, if any. */
function sessionsOn(others: OtherBoard[], id: string): string[] {
  for (const b of others) for (const v of b.views) for (const c of v.cards) if (taskId(c.task) === id) return c.rows.map((r) => r.session.name);
  return [];
}

/** The preview of a task the board doesn't show (X93), over the board. */
function TaskPreview({ host, workspaceId, row, shownLabel, sessions, onClose }: { host: string; workspaceId: string; row: OffRow; shownLabel: string; sessions: string[]; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const title = useId();
  const { task } = row;
  const { why, action } = previewOf(row, shownLabel);
  const tracker = trackerName(task.connection);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !fromOtherDialog(e, panel.current)) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const act = () => {
    if (!action) return;
    onClose();
    if (action.kind === "switch") {
      showBoard(host, workspaceId, action.board);
      findTask(host, workspaceId, row.id);
      scrollToTask(row.id);
    } else void moveTask(host, workspaceId, task, "todo");
  };
  const start = () => {
    onClose();
    useStore.setState({ dialog: { kind: "new-session", host, workspace: workspaceId, task: composerTask(host, workspaceId, task) } });
  };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 pt-[110px]" onMouseDown={onClose}>
      <section ref={panel} role="dialog" aria-labelledby={title} onMouseDown={(e) => e.stopPropagation()} className="flex max-h-[76vh] w-[600px] flex-col overflow-hidden rounded-[14px] border border-border-strong bg-panel shadow-[0_24px_60px_rgba(0,0,0,0.6)]">
        <div className="flex h-[50px] shrink-0 items-center gap-2 border-b border-border pl-[18px] pr-2.5">
          <BoardTile tracker={trackerOf(task.connection)} />
          <span className="font-mono ui-text-12.5 text-muted">{task.key}</span>
          <span className="min-w-0 flex-1 truncate ui-text-12 text-faint">· {row.where}</span>
          {task.url && (
            <a href={task.url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 ui-text-12 text-accent hover:underline">
              Open in {tracker}
              <ExternalLink size={12} />
            </a>
          )}
          <IconButton title="Close" onClick={onClose}>
            <X size={14} />
          </IconButton>
        </div>
        <div className="flex min-h-0 flex-col gap-3.5 overflow-y-auto p-[18px]">
          <h2 id={title} className="ui-text-17 font-semibold leading-[1.35] text-fg">
            {task.title}
          </h2>
          <div className="grid grid-cols-[80px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 ui-text-12.5">
            <span className="text-muted">State</span>
            <span className="flex items-center gap-[7px] text-fg">
              <TaskGlyph column={row.glyph} dashed={row.backlog} />
              {row.state}
            </span>
            <span className="text-muted">Assignee</span>
            <span className="text-fg">{task.assignees.join(", ") || "Unassigned"}</span>
            <span className="text-muted">Sessions</span>
            <span className={sessions.length ? "text-fg" : "text-faint"}>{sessions.join(", ") || "None yet"}</span>
          </div>
          {task.description.trim() && (
            <div className="ui-text-13 leading-[1.55] text-muted">
              <Markdown text={task.description} task />
            </div>
          )}
          <div className="flex items-start gap-2 rounded-lg bg-panel-2 px-3 py-2.5 ui-text-12 leading-[1.5] text-muted">
            <Search size={13} className="mt-0.5 shrink-0 text-faint" />
            <span>{why}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t border-border px-[18px] py-3">
          {action && (
            <Button variant="ghost" size="sm" onClick={act}>
              {action.label}
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="subtle" size="sm" onClick={onClose}>
            Back to the board
          </Button>
          <Button variant="primary" size="sm" onClick={start}>
            <Play size={12} /> New session
          </Button>
        </div>
      </section>
    </div>
  );
}
