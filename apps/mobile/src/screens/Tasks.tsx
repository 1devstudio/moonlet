// The Tasks tab (X57): the boards the app on the Mac shared, one at a time,
// a tab per column, and each card with its sessions live.

import { useState } from "react";
import { ArrowLeftRight, Check, ChevronDown, ChevronRight, Plus, Search, X } from "lucide-react";
import { type Category, syncedColumns } from "@desktop/lib/boards";
import { createTarget, createsIn } from "@desktop/lib/newIssue";
import { showScreen, updateSettings, useApp } from "../lib/app";
import { type CardView, type ColumnTab, type PhoneBoard, boardScreen, firstColumn, phoneBoards, switcher } from "../lib/board";
import { useNow } from "../lib/now";
import { useSessionsDetails } from "../lib/rowDetails";
import { moveOnMac, useTaskFailures, useTaskMoves } from "../lib/taskActions";
import { NewIssueSheet } from "./NewIssue";
import { Sheet } from "../components/Sheet";
import { StateGlyph, cx } from "../components/ui";

const INK = { fg: "#e6e6e6", muted: "#8c8c8c", merged: "#a371f7" };

/** A column's category as the design draws it: a ring, filled to the work done. */
export function CategoryGlyph({ category, size = 13 }: { category: Category; size?: number }) {
  const ring = category === "todo" ? INK.muted : category === "done" ? INK.merged : INK.fg;
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" className="flex-none">
      <circle cx="7" cy="7" r="5.5" fill={category === "done" ? INK.merged : "none"} stroke={ring} strokeWidth="1.5" />
      {category === "in_progress" && <path d="M7 7 L7 4 A3 3 0 0 1 7 10 Z" fill={INK.fg} />}
      {category === "in_review" && <path d="M7 7 L7 4 A3 3 0 1 1 4 7 Z" fill={INK.fg} />}
      {category === "done" && <path d="M4.6 7.1 L6.3 8.8 L9.4 5.4" fill="none" stroke="#161616" strokeWidth="1.5" strokeLinecap="round" />}
    </svg>
  );
}

/** A tracker's letter tile: Linear, Jira, others. */
export function TrackerMark({ mark, size = 30 }: { mark: string; size?: number }) {
  const tint = mark === "L" ? ["#2b2a3d", "#b9b4f5"] : mark === "J" ? ["#1d2a3d", "#8fb8f5"] : ["#1f1f1f", "#8c8c8c"];
  return (
    <span className="flex flex-none items-center justify-center rounded-[8px] text-[12px] font-semibold" style={{ width: size, height: size, background: tint[0], color: tint[1] }}>
      {mark}
    </span>
  );
}

function PriorityBars({ priority }: { priority: number }) {
  return (
    <span className="flex h-[10px] items-end gap-[2px]" aria-label={`Priority ${priority} of 3`}>
      {[0, 1, 2].map((j) => (
        <span key={j} className="w-[3px] rounded-[1px]" style={{ height: 4 + j * 3, background: j < priority ? "var(--color-muted)" : "var(--color-border-strong)" }} />
      ))}
    </span>
  );
}

const META_TONE = { blocked: "text-blocked", open: "text-done", merged: "text-merged", error: "text-error", muted: "text-muted", faint: "text-faint" } as const;

function TaskCard({ c, b, project, failure }: { c: CardView; b: PhoneBoard; project: string | null; failure: string | null }) {
  const host = b.host;
  const onOpen = () => showScreen({ kind: "task", board: b.key, task: c.id });
  // An out-of-sync fix moves the task to the column its fix names (X45, X50).
  const fix = () => {
    const to = syncedColumns(b.board, null).find((x) => x.name === c.drift?.to);
    if (to?.statuses[0]) void moveOnMac(b, c.task, { label: to.name, status: to.statuses[0] }).catch(() => {});
  };
  return (
    <article className={cx("flex flex-col gap-2.5 rounded-[14px] border bg-panel p-3.5", c.needsYou ? "border-[rgba(242,201,76,0.4)]" : "border-[#242424]")}>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[12px] text-muted">{c.key}</span>
        <PriorityBars priority={c.priority} />
        <span className="flex-1" />
        {project && <span className="text-[11.5px] text-faint">{project}</span>}
        {c.initials && <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full border border-border-strong bg-raised text-[9px] font-semibold text-muted">{c.initials}</span>}
      </div>
      <button type="button" onClick={onOpen} className="text-left text-[15.5px] leading-[1.35] font-medium">
        {c.title}
      </button>
      {c.line && <span className="-mt-1.5 text-[12.5px] text-faint">{c.line}</span>}
      {c.rows.length > 0 && (
        <div className="flex flex-col gap-1">
          {c.rows.map((r) => (
            <button key={r.id} type="button" onClick={() => showScreen({ kind: "session", host, id: r.id, tab: "chat" })} className="flex min-h-11 items-center gap-2.5 rounded-[10px] bg-bg px-3 text-left text-[14px]">
              <StateGlyph state={r.state} size={15} />
              <span className="min-w-0 flex-1 truncate">{r.name}</span>
              <span className={cx("font-mono text-[12px] whitespace-nowrap", META_TONE[r.meta.tone])}>{r.meta.text}</span>
              <ChevronRight size={15} className="text-faint" />
            </button>
          ))}
        </div>
      )}
      {!c.rows.length && c.empty && <span className="text-[13px] text-faint">{c.empty}</span>}
      {c.drift && (
        <div className="flex min-h-11 items-center gap-2.5 rounded-[10px] border border-[rgba(217,119,87,0.35)] bg-[rgba(217,119,87,0.07)] px-3 text-[13.5px]">
          <ArrowLeftRight size={14} className="flex-none text-accent" />
          <span className="flex-1">{c.drift.text}</span>
          {c.drift.to && (
            <button type="button" onClick={fix} className="h-8 rounded-[8px] px-2.5 text-[13.5px] font-medium text-[#e8956f]">
              {c.drift.fix}
            </button>
          )}
        </div>
      )}
      {failure && <span className="text-[12.5px] text-error">{failure}</span>}
    </article>
  );
}

function Switcher({ shown, onClose }: { shown: string | null; onClose: () => void }) {
  const hosts = useApp((s) => s.hosts);
  const data = useApp((s) => s.data);
  const workspace = useApp((s) => s.settings.workspace);
  const [q, setQ] = useState("");
  const all = phoneBoards(hosts, data, null);
  const groups = switcher(all, shown, q, data, { prs: {}, git: {} }, Date.now());
  const pick = (key: string) => {
    const b = all.find((x) => x.key === key);
    // A board of another workspace shows that workspace (X57, as X50).
    updateSettings({ board: key, ...(b && workspace !== null && { workspace: b.workspaceName }) });
    onClose();
  };
  return (
    <Sheet label="Boards" onClose={onClose}>
      <div className="flex items-center px-5 pt-1 pb-3">
        <h2 className="m-0 flex-1 text-[16px] font-semibold">Boards</h2>
        <button type="button" aria-label="Close" onClick={onClose} className="flex h-9 w-9 items-center justify-center text-muted">
          <X size={19} />
        </button>
      </div>
      <label className="mx-4 flex h-11 items-center gap-2.5 rounded-[12px] border border-border-strong bg-raised px-3">
        <Search size={17} className="text-faint" />
        <input aria-label="Find a board" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a board" className="min-w-0 flex-1 bg-transparent text-[15px] outline-none" />
      </label>
      <div className="scroll flex flex-col gap-3 px-2 pt-3 pb-2">
        {!groups.length && <p className="px-3 text-[14px] text-muted">No board matches.</p>}
        {groups.map((g) => (
          <div key={g.name} className="flex flex-col">
            <div className="flex px-3 pb-1 text-[11.5px] tracking-[0.06em] text-faint uppercase">
              <span className="flex-1">{g.name}</span>
              <span className="tracking-normal normal-case">{g.hint}</span>
            </div>
            {g.rows.map((r) => (
              <button key={r.key} type="button" onClick={() => pick(r.key)} className={cx("flex min-h-14 items-center gap-3 rounded-[12px] px-3 text-left", r.current && "bg-[#2a1f1a]")}>
                <TrackerMark mark={r.mark} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[15px]">{r.name}</span>
                  <span className="truncate text-[12.5px] text-muted">{r.meta}</span>
                </span>
                {r.needsYou && <span className="h-2 w-2 rounded-full bg-blocked" aria-label="A session needs you" />}
                {r.current && <Check size={18} className="text-fg" />}
              </button>
            ))}
          </div>
        ))}
      </div>
    </Sheet>
  );
}

function ColumnTabs({ columns, shown, onPick }: { columns: ColumnTab[]; shown: string | null; onPick: (name: string) => void }) {
  return (
    <div role="tablist" aria-label="Columns" className="-mx-4 flex gap-1.5 overflow-x-auto px-4">
      {columns.map((c) => {
        const on = c.name === shown;
        return (
          <button
            key={c.name}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onPick(c.name)}
            className={cx("flex h-9 flex-none items-center gap-[7px] rounded-[18px] border px-3 text-[13.5px]", on ? "border-border-strong bg-[#1f1f1f] text-fg" : "border-transparent text-muted")}
          >
            <CategoryGlyph category={c.category} />
            {c.name}
            <span className="font-mono text-[12px] text-faint">{c.wip ?? c.count}</span>
            {c.dot && <span className={cx("h-1.5 w-1.5 rounded-full", c.dot === "blocked" ? "bg-blocked" : "bg-accent")} />}
          </button>
        );
      })}
    </div>
  );
}

export function TasksScreen() {
  const hosts = useApp((s) => s.hosts);
  const data = useApp((s) => s.data);
  const workspace = useApp((s) => s.settings.workspace);
  const saved = useApp((s) => s.settings.board ?? null);
  const savedColumns = useApp((s) => s.settings.columns);
  const now = useNow();
  const moving = useTaskMoves();
  const failures = useTaskFailures();
  const [creating, setCreating] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const all = phoneBoards(hosts, data, workspace);
  // The board last shown on the phone, else the one the Mac shows, else the first.
  const current = all.find((b) => b.key === saved) ?? all.find((b) => b.snapshot.shownBoard === b.board.id) ?? all[0] ?? null;
  const d = current ? data[current.host] : undefined;
  const sessions = current && d ? d.sessions.filter((s) => s.workspace_id === current.workspace) : [];
  const details = useSessionsDetails(current?.host ?? null, sessions);

  if (!current || !d) {
    return (
      <div className="flex h-full flex-col px-4" style={{ paddingTop: "calc(var(--safe-top) + 14px)" }}>
        <h1 className="m-0 text-[28px] font-semibold">Tasks</h1>
        <p className="mt-4 text-[14.5px] leading-[1.45] text-muted">No boards yet. Add one in moonlet on the Mac (Tasks › Add a board).</p>
      </div>
    );
  }
  const screen = boardScreen(current, d, details, moving, now);
  const shownColumn = screen.columns.find((c) => c.name === savedColumns?.[current.key])?.name ?? firstColumn(screen.columns);
  const column = screen.columns.find((c) => c.name === shownColumn);
  const q = query?.trim().toLowerCase() ?? "";
  const cards = (column?.cards ?? []).filter((c) => !q || `${c.key} ${c.title}`.toLowerCase().includes(q));
  // The project shows on cards when the board's sessions are in several.
  const projects = new Set(screen.columns.flatMap((c) => c.cards.flatMap((x) => x.card.rows.map((r) => r.session.project))).filter(Boolean));

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-none flex-col gap-3 border-b border-border bg-panel px-4 pb-2.5" style={{ paddingTop: "calc(var(--safe-top) + 8px)" }}>
        <div className="flex items-center gap-2.5">
          <span aria-label={`Workspace ${current.workspaceName}`} className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[8px] bg-accent text-[13px] font-bold text-[#1a1208]">
            {current.workspaceName.charAt(0).toUpperCase()}
          </span>
          <button type="button" onClick={() => setSwitching(true)} className="flex min-w-0 flex-1 flex-col gap-px text-left">
            <span className="flex items-center gap-1.5 text-[17px] font-semibold">
              <span className="truncate">{screen.title}</span>
              <ChevronDown size={15} className="flex-none text-muted" />
            </span>
            <span className="truncate text-[12px] text-muted">{screen.subtitle}</span>
          </button>
          <button type="button" aria-label="Search tasks" onClick={() => setQuery(query === null ? "" : null)} className="flex h-11 w-11 flex-none items-center justify-center rounded-[10px] text-muted">
            {query === null ? <Search size={19} /> : <X size={19} />}
          </button>
        </div>
        {query !== null && <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Key or title" className="h-10 rounded-[10px] border border-border-strong bg-bg px-3 text-[15px] outline-none" />}
        <ColumnTabs columns={screen.columns} shown={shownColumn} onPick={(name) => updateSettings({ columns: { ...savedColumns, [current.key]: name } })} />
      </header>
      <main className="scroll flex min-h-0 flex-1 flex-col gap-2.5 px-4 pt-3.5 pb-4">
        {[screen.attention, screen.problem, screen.stale].filter(Boolean).map((line) => (
          <p key={line} className="m-0 text-[12.5px] leading-snug text-muted">
            {line}
          </p>
        ))}
        {(() => {
          const col = syncedColumns(current.board, null).find((x) => x.name === shownColumn);
          if (!col || !createsIn(current.board) || !createTarget(current.board, col)) return null;
          return (
            <button type="button" onClick={() => setCreating(true)} className="flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-dashed border-border-strong text-[14px] text-muted">
              <Plus size={15} /> New issue in {shownColumn}
            </button>
          );
        })()}
        {!cards.length && <p className="m-0 py-6 text-center text-[14px] text-faint">{q ? "No task matches." : `Nothing in ${shownColumn ?? "this column"}.`}</p>}
        {cards.map((c) => (
          <TaskCard key={c.id} c={c} b={current} project={projects.size > 1 ? (c.card.rows[0]?.session.project ?? null) : null} failure={failures[c.id] ?? null} />
        ))}
      </main>
      {switching && <Switcher shown={current.key} onClose={() => setSwitching(false)} />}
      {creating && shownColumn && <NewIssueSheet b={current} column={shownColumn} onClose={() => setCreating(false)} />}
    </div>
  );
}
