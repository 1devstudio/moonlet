// A task (X76): its state, fields, out-of-sync fix, sessions, description,
// acceptance criteria, comments and activity, as the design lays them out.

import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronLeft, Copy, ExternalLink, GitBranch, GitPullRequest, History, Plus, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { syncedColumns } from "@desktop/lib/boards";
import { commentsView } from "@desktop/lib/commentsView";
import { initials } from "@desktop/lib/taskDetails";
import { trackerName } from "@desktop/lib/tasks";
import { showScreen, startFromTask, updateSettings, useApp } from "../lib/app";
import { type PhoneBoard, phoneBoards } from "../lib/board";
import { useNow } from "../lib/now";
import { useSessionsDetails } from "../lib/rowDetails";
import { loadComments, moveOnMac, postComment, setCommentDraft, useComments, useTaskFailures, useTaskMoves } from "../lib/taskActions";
import { moveSheet, taskDetail } from "../lib/taskView";
import { Markdown } from "../components/Markdown";
import { Sheet } from "../components/Sheet";
import { AgentIcon, Btn, DiffStat, StateGlyph, cx } from "../components/ui";
import { CategoryGlyph, CleanUpSheet, PriorityBars, TrackerMark, fixCard } from "./Tasks";

type Detail = NonNullable<ReturnType<typeof taskDetail>>;

const PR_TONE = { open: "text-done", merged: "text-merged", muted: "text-muted" } as const;

/** The Move sheet (X76): the board's columns, the suggested one picked, and what the Mac does. */
function MoveSheet({ b, t, onClose }: { b: PhoneBoard; t: Detail; onClose: () => void }) {
  const m = moveSheet(b, t);
  const [picked, setPicked] = useState(m.picked);
  const row = m.rows.find((r) => r.name === picked);
  const current = t.choices.find((c) => c.current)?.label;
  const move = () => {
    if (row && row.name !== current) void moveOnMac(b, t.task, { label: row.name, status: row.status }).catch(() => {});
    onClose();
  };
  return (
    <Sheet label={m.title} onClose={onClose}>
      <div className="flex items-start gap-3 px-[18px] pt-1 pb-1">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="m-0 text-[19px] font-semibold">
            Move <span className="font-mono">{t.key}</span>
          </h2>
          <span className="text-[13px] text-muted">{m.sub}</span>
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-raised text-muted">
          <X size={17} />
        </button>
      </div>
      <div className="scroll flex flex-col px-2 pt-2 pb-2">
        {m.rows.map((r) => (
          <button key={r.name} type="button" aria-pressed={r.name === picked} onClick={() => setPicked(r.name)} className={cx("flex min-h-14 items-center gap-3 rounded-[12px] px-2.5 text-left", r.name === picked && "bg-raised")}>
            <CategoryGlyph category={r.category} size={16} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[15px]">{r.name}</span>
              <span className={cx("text-[12.5px]", r.tone === "accent" ? "text-accent-2" : "text-muted")}>{r.line}</span>
            </span>
            {r.name === picked && <Check size={18} />}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-3 border-t border-border px-4 pt-3">
        <p className="m-0 text-[12.5px] leading-[1.45] text-faint">{m.note}</p>
        <Btn tone="primary" className="h-12 rounded-[12px] text-[15px]" disabled={!row || row.name === current} onClick={move}>
          Move to {picked}
        </Btn>
      </div>
    </Sheet>
  );
}

function Comments({ b, t }: { b: PhoneBoard; t: Detail }) {
  const e = useComments((s) => s.byTask[t.id]);
  const now = useNow();
  useEffect(() => {
    void loadComments(b, t.task);
    // Again when the task changes on the tracker.
  }, [b.key, t.id, t.task.updatedMs]);
  const v = commentsView(e, t.task, now);
  const draft = e?.draft ?? "";
  return (
    <section aria-labelledby="task-comments" className="flex flex-col gap-3">
      <h2 id="task-comments" className="eyebrow m-0">
        {v.heading}
      </h2>
      {v.status === "loading" && <p className="m-0 text-[13.5px] text-faint">Loading comments…</p>}
      {v.status === "empty" && <p className="m-0 text-[13.5px] text-faint">No comments yet.</p>}
      {e?.error && !e.comments && (
        <p className="m-0 flex items-center gap-2 text-[13.5px] text-error">
          Couldn't load comments: {e.error}
          <button type="button" onClick={() => void loadComments(b, t.task)} className="text-accent-2">
            Retry
          </button>
        </p>
      )}
      {v.rows.map((c) => (
        <div key={c.id} className="flex gap-2.5">
          <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-raised text-[11px] font-semibold text-muted">{initials(c.author)}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[13.5px]">
              <span className="font-semibold">{c.author}</span> <span className="text-faint">{c.ago}</span>
            </span>
            <div className="text-[14px] leading-[1.45]">{c.markdown ? <Markdown text={c.body} /> : <p className="m-0 whitespace-pre-wrap">{c.body}</p>}</div>
          </div>
        </div>
      ))}
      {v.more && (
        <button type="button" onClick={() => void openUrl(t.url).catch(console.error)} className="self-start text-[13px] text-accent-2">
          {v.more}
        </button>
      )}
      <div className="flex items-end gap-2">
        <textarea
          aria-label="Leave a comment"
          value={draft}
          disabled={e?.posting}
          onChange={(ev) => setCommentDraft(t.task, ev.target.value)}
          placeholder="Leave a comment"
          rows={2}
          className="min-h-16 min-w-0 flex-1 resize-none rounded-[12px] border border-border-strong bg-panel px-3 py-2.5 text-[15px] outline-none"
        />
        <Btn tone="primary" className="h-11 px-4" disabled={!draft.trim() || e?.posting} onClick={() => void postComment(b, t.task)}>
          {e?.posting ? "Posting…" : "Comment"}
        </Btn>
      </div>
      {e?.postError && <p className="m-0 text-[13px] text-error">{e.postError}</p>}
    </section>
  );
}

export function TaskScreen({ board, task, created }: { board: string; task: string; created?: boolean }) {
  const hosts = useApp((s) => s.hosts);
  const data = useApp((s) => s.data);
  const notNow = useApp((s) => s.settings.notNow);
  const moving = useTaskMoves();
  const failures = useTaskFailures();
  const now = useNow();
  const [moveOpen, setMoveOpen] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [activity, setActivity] = useState(false);
  const [copied, setCopied] = useState(false);
  const b = phoneBoards(hosts, data, null).find((x) => x.key === board) ?? null;
  const d = b ? data[b.host] : undefined;
  const sessions = b && d ? d.sessions.filter((s) => s.workspace_id === b.workspace) : [];
  const details = useSessionsDetails(b?.host ?? null, sessions);
  const t = b && d ? taskDetail(b, task, d, details, moving, now) : null;
  const back = () => showScreen(null);

  if (!b || !t) {
    return (
      <div className="p-6 text-muted" style={{ paddingTop: "calc(var(--safe-top) + 20px)" }}>
        <button type="button" onClick={back} className="mb-4 flex items-center gap-1 text-fg">
          <ChevronLeft size={22} /> Board
        </button>
        <p>{created ? `Created ${task.slice(task.indexOf(" ") + 1)}. It shows here once moonlet on the Mac shares the board.` : "This task is not on the board any more, or its host is offline."}</p>
      </div>
    );
  }
  const category = syncedColumns(b.board, null).find((c) => c.name === t.state)?.category;
  const sync = t.outOfSync && !notNow?.[t.outOfSync.key] ? t.outOfSync : null;
  const copy = () => {
    void navigator.clipboard?.writeText(t.key).then(() => setCopied(true), () => {});
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-none items-center gap-2 px-3 pb-2" style={{ paddingTop: "calc(var(--safe-top) + 10px)" }}>
        <button type="button" aria-label="Back to the board" onClick={back} className="flex h-10 w-9 items-center justify-center text-fg">
          <ChevronLeft size={22} />
        </button>
        <TrackerMark mark={t.mark} />
        <span className="font-mono text-[15px] font-semibold">{t.key}</span>
        <button type="button" aria-label={copied ? "Copied" : `Copy ${t.key}`} onClick={copy} className="flex h-9 w-9 items-center justify-center text-muted">
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </button>
        <span className="flex-1" />
        <button type="button" onClick={() => void openUrl(t.url).catch(console.error)} className="flex h-10 items-center gap-1.5 text-[13.5px] text-muted">
          Open in {trackerName(t.task.connection)} <ExternalLink size={13} />
        </button>
      </header>
      <main className="scroll flex min-h-0 flex-1 flex-col gap-5 px-4 pb-8">
        <div className="flex flex-col gap-3">
          <h1 className="m-0 text-[22px] leading-tight font-semibold">{t.title}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setMoveOpen(true)} className="flex h-9 items-center gap-2 rounded-[18px] border border-border-strong px-3 text-[14px]">
              {category && <CategoryGlyph category={category} size={13} />}
              {t.state ?? "State"}
              <ChevronDown size={14} className="text-muted" />
            </button>
            {t.kind && <span className="flex h-9 items-center rounded-[18px] bg-raised px-3 text-[13.5px] text-muted">{t.kind}</span>}
            {t.priority && (
              <span className="flex h-9 items-center gap-1.5 rounded-[18px] bg-raised px-3 text-[13.5px] text-muted">
                <PriorityBars priority={t.task.priority} />
                {t.priority}
              </span>
            )}
          </div>
          {failures[t.id] && <span className="text-[12.5px] text-error">{failures[t.id]}</span>}
          {moving[t.id]?.waiting && <span className="text-[12.5px] text-faint">Waits for moonlet on {b.snapshot.from}</span>}
          <dl className="m-0 grid grid-cols-[88px_1fr] items-center gap-x-3 gap-y-2.5 text-[14px]">
            {t.assignee && (
              <>
                <dt className="text-muted">Assignee</dt>
                <dd className="m-0 flex items-center gap-2">
                  <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-raised text-[10px] font-semibold text-muted">{t.assignee.initials}</span>
                  {t.assignee.name}
                </dd>
              </>
            )}
            {t.sprint && (
              <>
                <dt className="text-muted">Sprint</dt>
                <dd className="m-0">{t.sprint}</dd>
              </>
            )}
            {t.labels.length > 0 && (
              <>
                <dt className="text-muted">Labels</dt>
                <dd className="m-0 flex flex-wrap gap-1.5">
                  {t.labels.map((l) => (
                    <span key={l} className="rounded-full border border-border-strong px-2.5 py-0.5 text-[12.5px] text-muted">
                      {l}
                    </span>
                  ))}
                </dd>
              </>
            )}
          </dl>
        </div>

        {sync && t.card && (
          <section aria-label="Out of sync" className="flex flex-col gap-3 rounded-[12px] border border-[rgba(217,119,87,0.35)] bg-[rgba(217,119,87,0.06)] p-3.5">
            <span className="flex items-center gap-2 text-[14px] font-semibold text-accent-2">
              <span className="h-2 w-2 rounded-full bg-accent" /> Out of sync
            </span>
            <p className="m-0 text-[14px] leading-[1.45]">{sync.why}</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => fixCard(b, t.card!, () => setCleaning(true))} className="h-11 flex-1 rounded-[10px] bg-accent text-[14.5px] font-semibold text-bg">
                {sync.fix}
              </button>
              <button type="button" onClick={() => updateSettings({ notNow: { ...notNow, [sync.key]: true } })} className="h-11 px-5 text-[14.5px] text-muted">
                Not now
              </button>
            </div>
          </section>
        )}

        <section aria-labelledby="task-sessions" className="flex flex-col gap-2.5">
          <div className="flex items-center">
            <h2 id="task-sessions" className="eyebrow m-0 flex-1">
              Sessions {t.sessions.length}
            </h2>
            <button type="button" onClick={() => startFromTask({ board, task })} className="flex h-9 items-center gap-1.5 rounded-[10px] border border-border-strong px-3 text-[13.5px]">
              <Plus size={14} /> New session
            </button>
          </div>
          {!t.sessions.length && !t.worktrees.length && <p className="m-0 text-[13.5px] text-faint">No sessions yet.</p>}
          {t.sessions.map((s) => (
            <div key={s.id} className={cx("flex flex-col gap-1.5 rounded-[12px] border bg-panel p-3", s.waiting ? "border-[rgba(242,201,76,0.45)]" : "border-[#242424]")}>
              <div className="flex items-center gap-2">
                <StateGlyph state={s.state} />
                <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{s.name}</span>
                <button type="button" onClick={() => showScreen({ kind: "session", host: b.host, id: s.id, tab: "chat" })} className="h-8 rounded-[8px] bg-fg px-3 text-[13.5px] font-semibold text-bg">
                  Open
                </button>
              </div>
              <span className="flex items-center gap-2 font-mono text-[12px] text-faint">
                <span className="min-w-0 truncate">{s.where}</span>
                <DiffStat add={s.add} del={s.del} />
              </span>
              <span className="flex items-center gap-1.5 text-[12.5px] text-muted">
                <AgentIcon agent={s.agent} size={13} />
                <span className={cx(s.state === "blocked" && "text-blocked")}>{[s.word, s.ask].filter(Boolean).join(" · ")}</span>
              </span>
              {s.pr && (
                <span className="flex items-center gap-1.5 text-[12.5px] text-muted">
                  <GitPullRequest size={13} />
                  <span className={PR_TONE[s.pr.tone]}>{s.pr.text}</span>
                  {s.pr.checks && <span>· {s.pr.checks}</span>}
                  {s.pr.failing && <span className="text-error">· {s.pr.failing}</span>}
                  {s.pr.review && <span>· {s.pr.review}</span>}
                </span>
              )}
            </div>
          ))}
          {t.worktrees.map((w) => (
            <div key={w.path} className="flex items-center gap-2.5 rounded-[12px] border border-dashed border-border-strong p-3">
              <GitBranch size={15} className="text-muted" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-mono text-[13px]">{w.branch}</span>
                <span className="text-[12px] text-faint">Worktree without a session</span>
              </span>
              <Btn className="h-9" onClick={() => startFromTask({ board, task, worktree: w })}>
                Start
              </Btn>
            </div>
          ))}
        </section>

        {t.description && (
          <section aria-labelledby="task-description" className="flex flex-col gap-2">
            <h2 id="task-description" className="eyebrow m-0">
              Description
            </h2>
            <div className="text-[14.5px] leading-[1.5]">
              <Markdown text={t.description} />
            </div>
          </section>
        )}

        {t.criteria && (
          <section aria-labelledby="task-criteria" className="flex flex-col gap-2">
            <h2 id="task-criteria" className="eyebrow m-0">
              {t.criteria.heading}
            </h2>
            {t.criteria.items.map((c, i) => (
              <div key={i} className="flex items-start gap-2.5 text-[14.5px]">
                <span className={cx("mt-[2px] flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] border", c.done ? "border-fg bg-fg text-bg" : "border-border-strong")} aria-label={c.done ? "Done" : "Not done"}>
                  {c.done && <Check size={13} strokeWidth={3} />}
                </span>
                <span className={c.done ? "text-muted" : ""}>{c.text}</span>
              </div>
            ))}
          </section>
        )}

        <Comments b={b} t={t} />

        {t.activity.length > 0 && (
          <section aria-label="Activity" className="flex flex-col gap-1.5 rounded-[12px] border border-border">
            <button type="button" aria-expanded={activity} onClick={() => setActivity(!activity)} className="flex items-center gap-2 px-3 py-2.5 text-left text-[13px] text-muted">
              <History size={15} className="flex-none" />
              <span className="min-w-0 flex-1">Activity{!activity && t.latest ? ` · ${t.latest}` : ""}</span>
              <ChevronDown size={15} className={cx("flex-none transition-transform", activity && "rotate-180")} />
            </button>
            {activity &&
              t.activity.map((e, i) => (
                <div key={i} className="flex gap-3 px-3 pb-2 text-[13px]">
                  <span className="w-[72px] flex-none font-mono text-[12px] text-faint">{e.when}</span>
                  <span className="text-muted">{e.text}</span>
                </div>
              ))}
          </section>
        )}
      </main>
      {moveOpen && <MoveSheet b={b} t={t} onClose={() => setMoveOpen(false)} />}
      {cleaning && t.card && <CleanUpSheet c={t.card} b={b} onClose={() => setCleaning(false)} />}
    </div>
  );
}
