// A task (X57): its state, description, sessions, worktrees and activity,
// as the desktop's detail shows them, with New session for it.

import { useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, GitBranch, MoreHorizontal, Play, ShieldAlert } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { syncedColumns } from "@desktop/lib/boards";
import { showScreen, startFromTask, useApp } from "../lib/app";
import { phoneBoards } from "../lib/board";
import { useBusy } from "../lib/busy";
import { useNow } from "../lib/now";
import { useSessionsDetails } from "../lib/rowDetails";
import { moveOnMac, useTaskMoves } from "../lib/taskActions";
import { taskDetail } from "../lib/taskView";
import { Markdown } from "../components/Markdown";
import { Sheet } from "../components/Sheet";
import { AgentIcon, Btn, DiffStat, StateGlyph, cx } from "../components/ui";
import { CategoryGlyph, TrackerMark } from "./Tasks";

export function TaskScreen({ board, task, created }: { board: string; task: string; created?: boolean }) {
  const hosts = useApp((s) => s.hosts);
  const data = useApp((s) => s.data);
  const moving = useTaskMoves();
  const now = useNow();
  const [states, setStates] = useState(false);
  const [more, setMore] = useState(false);
  const [menu, setMenu] = useState(false);
  const { busy, error, run } = useBusy();
  const b = phoneBoards(hosts, data, null).find((x) => x.key === board) ?? null;
  const d = b ? data[b.host] : undefined;
  const sessions = b && d ? d.sessions.filter((s) => s.workspace_id === b.workspace) : [];
  const details = useSessionsDetails(b?.host ?? null, sessions);
  const t = b && d ? taskDetail(b, task, d, details, moving, now) : null;
  const back = () => showScreen(null);

  if (!b || !t) {
    return (
      <div className="p-6 text-muted" style={{ paddingTop: "calc(var(--safe-top) + 20px)" }}>
        <button type="button" onClick={back} className="mb-4 text-accent-2">
          Board
        </button>
        <p>{created ? `Created ${task.slice(task.indexOf(" ") + 1)}. It shows here once moonlet on the Mac shares the board.` : "This task is not on the board any more, or its host is offline."}</p>
      </div>
    );
  }
  const columns = syncedColumns(b.board, null);
  const category = columns.find((c) => c.name === t.state)?.category;
  const long = t.description.split("\n").length > 3 || t.description.length > 220;

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-none items-center gap-1 px-2 pb-1" style={{ paddingTop: "calc(var(--safe-top) + 6px)" }}>
        <button type="button" onClick={back} className="flex h-10 items-center gap-0.5 pr-2 text-[15px] text-accent-2">
          <ChevronLeft size={20} /> Board
        </button>
        <span className="flex-1" />
        <button type="button" aria-label="Open in the tracker" onClick={() => void openUrl(t.url).catch(console.error)} className="flex h-10 w-10 items-center justify-center text-muted">
          <ExternalLink size={18} />
        </button>
        <button type="button" aria-label="More" onClick={() => setMenu(true)} className="flex h-10 w-10 items-center justify-center text-muted">
          <MoreHorizontal size={19} />
        </button>
      </header>
      <main className="scroll flex min-h-0 flex-1 flex-col gap-5 px-4 pb-4">
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center gap-1.5 text-[12.5px] text-muted">
            <TrackerMark mark={t.mark} size={18} />
            <span className="font-mono text-fg">{t.key}</span>
            {t.meta && <span>· {t.meta}</span>}
          </div>
          <h1 className="m-0 text-[21px] leading-tight font-semibold">{t.title}</h1>
          <button type="button" disabled={busy} onClick={() => setStates(true)} className="flex h-9 items-center gap-2 self-start rounded-[18px] border border-border-strong bg-panel px-3 text-[13.5px]">
            {category && <CategoryGlyph category={category} size={14} />}
            {busy ? "Moving…" : (t.state ?? "State")}
            <ChevronDown size={14} className="text-muted" />
          </button>
          {error && <span className="text-[12.5px] text-error">{error}</span>}
          {t.description && (
            <div className={cx("relative text-[14px] text-muted", !more && long && "max-h-[4.6em] overflow-hidden")}>
              <Markdown text={t.description} />
            </div>
          )}
          {long && (
            <button type="button" onClick={() => setMore(!more)} className="self-start text-[14px] text-accent-2">
              {more ? "Less" : "More"}
            </button>
          )}
        </div>

        <section aria-labelledby="task-sessions" className="flex flex-col gap-2">
          <h2 id="task-sessions" className="eyebrow m-0">
            Sessions · {t.sessions.length}
          </h2>
          {!t.sessions.length && <p className="m-0 text-[13.5px] text-faint">No sessions yet.</p>}
          {t.sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => showScreen({ kind: "session", host: b.host, id: s.id, tab: "chat" })}
              className={cx("flex flex-col gap-1.5 rounded-[14px] border bg-panel p-3.5 text-left", s.waiting ? "border-[rgba(242,201,76,0.35)]" : "border-[#242424]")}
            >
              <span className="flex items-center gap-2">
                <StateGlyph state={s.state} size={16} />
                <span className="min-w-0 flex-1 truncate text-[15px]">{s.name}</span>
                <ChevronRight size={17} className="text-faint" />
              </span>
              <span className={cx("flex items-center gap-1.5 text-[12.5px]", s.state === "working" || s.state === "blocked" ? "text-accent" : "text-faint")}>
                <AgentIcon agent={s.agent} size={14} />
                {s.word}
              </span>
              <span className="flex items-center gap-1.5 text-[12px] text-faint">
                <GitBranch size={13} />
                <span className="min-w-0 flex-1 truncate font-mono">{s.branch}</span>
                <DiffStat add={s.add} del={s.del} />
              </span>
              {s.waiting && (
                <span className="flex items-center gap-1.5 rounded-[10px] border border-[rgba(242,201,76,0.3)] bg-[rgba(242,201,76,0.06)] px-2.5 py-2 text-[12.5px] text-blocked">
                  <ShieldAlert size={14} /> {s.waiting}
                </span>
              )}
            </button>
          ))}
        </section>

        {t.worktrees.length > 0 && (
          <section aria-labelledby="task-worktrees" className="flex flex-col gap-2">
            <h2 id="task-worktrees" className="eyebrow m-0">
              {t.worktrees.length === 1 ? "Worktree without a session" : "Worktrees without a session"}
            </h2>
            {t.worktrees.map((w) => (
              <div key={w.path} className="flex items-center gap-2.5 rounded-[14px] border border-dashed border-border-strong p-3">
                <GitBranch size={16} className="text-muted" />
                <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{w.branch}</span>
                <Btn className="h-9" onClick={() => startFromTask({ board, task, worktree: w })}>
                  Start
                </Btn>
              </div>
            ))}
          </section>
        )}

        {t.activity.length > 0 && (
          <section aria-labelledby="task-activity" className="flex flex-col gap-1.5">
            <h2 id="task-activity" className="eyebrow m-0">
              Activity
            </h2>
            {t.activity.map((e, i) => (
              <div key={i} className="flex gap-3 text-[13px]">
                <span className="w-[72px] flex-none font-mono text-[12px] text-faint">{e.when}</span>
                <span className="text-muted">{e.text}</span>
              </div>
            ))}
          </section>
        )}
      </main>
      <div className="flex-none border-t border-border px-4 pt-3" style={{ paddingBottom: "max(var(--safe-bottom), 12px)" }}>
        <Btn tone="primary" className="w-full bg-accent text-[#1a1208]" onClick={() => startFromTask({ board, task })}>
          <Play size={16} /> New session for {t.key}
        </Btn>
      </div>

      {states && (
        <Sheet label="State" onClose={() => setStates(false)}>
          <div className="flex flex-col px-2 pb-2">
            {t.choices.map((c) => (
              <button
                key={c.label}
                type="button"
                onClick={() => {
                  setStates(false);
                  if (!c.current) void run(() => moveOnMac(b, t.task, c));
                }}
                className="flex min-h-12 items-center gap-3 rounded-[10px] px-3 text-left text-[15px]"
              >
                {(() => {
                  const cat = columns.find((x) => x.name === c.label)?.category;
                  return cat ? <CategoryGlyph category={cat} size={14} /> : null;
                })()}
                <span className="flex-1">{c.label}</span>
                {c.current && <Check size={16} className="text-accent" />}
              </button>
            ))}
          </div>
        </Sheet>
      )}
      {menu && (
        <Sheet label="Task actions" onClose={() => setMenu(false)}>
          <div className="flex flex-col gap-2 px-4 pb-2">
            <Btn
              onClick={() => {
                void navigator.clipboard?.writeText(t.url).catch(() => {});
                setMenu(false);
              }}
            >
              Copy link
            </Btn>
            <Btn tone="ghost" onClick={() => setMenu(false)}>
              Cancel
            </Btn>
          </div>
        </Sheet>
      )}
    </div>
  );
}
