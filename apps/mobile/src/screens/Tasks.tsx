// The Tasks tab (X76): the boards the app on the Mac shared, one at a time,
// a tab per column, and each card with its sessions live.

import { useState } from "react";
import { Check, ChevronDown, Play, Plus, RotateCw, Search, X } from "lucide-react";
import { type Category, syncedColumns } from "@desktop/lib/boards";
import { cleanUpMessage } from "@desktop/lib/keepInStep";
import { createTarget, createsIn } from "@desktop/lib/newIssue";
import { trackerOf } from "@desktop/lib/tasks";
import { showScreen, startFromTask, updateSettings, useApp, useShownWorkspace } from "../lib/app";
import { type CardView, type ColumnTab, type PhoneBoard, boardScreen, firstColumn, phoneBoards, switcher, syncLine } from "../lib/board";
import { useBusy } from "../lib/busy";
import { useNow } from "../lib/now";
import { useSessionsDetails } from "../lib/rowDetails";
import { askMac, fixOnMac, moveOnMac, syncAction, useTaskFailures, useTaskMoves } from "../lib/taskActions";
import { NewIssueSheet } from "./NewIssue";
import { Sheet } from "../components/Sheet";
import { WorkspacePill } from "../components/WorkspacePill";
import { Btn, StateGlyph, cx } from "../components/ui";

/** A column's category as the design draws it: a ring, filled to the work done, green once done. */
export function CategoryGlyph({ category, size = 12 }: { category: Category; size?: number }) {
  const ring = category === "todo" ? "#8c8c8c" : category === "done" ? "#3ecf6e" : "#e6e6e6";
  const fill = { todo: "", in_progress: "M 7 1.5 A 5.5 5.5 0 0 1 7 12.5 Z", in_review: "M 7 7 L 7 1.5 A 5.5 5.5 0 1 1 1.5 7 Z", done: "M 7 1.5 A 5.5 5.5 0 1 1 7 12.5 A 5.5 5.5 0 1 1 7 1.5 Z" }[category];
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" className="flex-none">
      <circle cx="7" cy="7" r="5.5" fill="none" stroke={ring} strokeWidth="1.5" />
      {fill && <path d={fill} fill={ring} />}
    </svg>
  );
}

const TILE: Record<string, string> = { J: "#2f6fde", L: "#5e6ad2", C: "#7b68ee", G: "#3a3a3a" };

/** A tracker's letter tile in its colour: Jira, Linear, ClickUp, GitHub. */
export function TrackerMark({ mark, size = 22 }: { mark: string; size?: number }) {
  return (
    <span className="flex flex-none items-center justify-center rounded-[6px] font-bold text-white" style={{ width: size, height: size, fontSize: Math.round(size * 0.55), background: TILE[mark] ?? "#3a3a3a" }}>
      {mark}
    </span>
  );
}

export function PriorityBars({ priority }: { priority: number }) {
  return (
    <span className="flex items-end gap-[2px]" aria-label={`Priority ${["None", "Low", "Medium", "High"][priority] ?? priority}`}>
      {[0, 1, 2].map((j) => (
        <span key={j} className="w-[3px] rounded-[1px]" style={{ height: 5 + j * 3, background: j < priority ? "#e6e6e6" : "#2e2e2e" }} />
      ))}
    </span>
  );
}

const META_TONE = { blocked: "text-blocked", open: "text-done", merged: "text-merged", error: "text-error", muted: "text-muted", faint: "text-faint" } as const;

/** The board the Tasks tab shows, and what it needs; the tab bar's badge reads it too. */
export function useShownBoard() {
  const hosts = useApp((s) => s.hosts);
  const data = useApp((s) => s.data);
  const shown = useShownWorkspace();
  const saved = useApp((s) => s.settings.board ?? null);
  const all = phoneBoards(hosts, data, shown);
  // The board last shown on the phone, else the one the Mac shows, else the first.
  const current = all.find((b) => b.key === saved) ?? all.find((b) => b.snapshot.shownBoard === b.board.id) ?? all[0] ?? null;
  const d = current ? data[current.host] : undefined;
  const sessions = current && d ? d.sessions.filter((s) => s.workspace_id === current.workspace) : [];
  return { current, d, sessions };
}

/** The Tasks tab's badge: the shown board's cards out of sync, as the board shows them. It reads the
 * PRs the board or rows loaded, and loads none itself. */
export function useTasksBadge(): number {
  const { current, d, sessions } = useShownBoard();
  const moving = useTaskMoves();
  const notNow = useApp((s) => s.settings.notNow);
  const mine = useApp((s) => (current ? !!s.settings.mine?.[current.key] : false));
  const details = useSessionsDetails(current?.host ?? null, sessions, { load: false });
  return current && d ? boardScreen(current, d, details, moving, { mine, notNow }).outOfSync : 0;
}

/** Clean up asks on the phone first; the Mac then runs it without asking again (X76). */
export function CleanUpSheet({ c, b, onClose }: { c: CardView; b: PhoneBoard; onClose: () => void }) {
  const { busy, error, run } = useBusy();
  return (
    <Sheet label={`Clean up ${c.key}?`} onClose={onClose}>
      <div className="flex flex-col gap-3 px-5 pt-1 pb-2">
        <h2 className="m-0 text-[17px] font-semibold">Clean up {c.key}?</h2>
        <p className="m-0 text-[14px] leading-[1.45] text-muted">{cleanUpMessage(c.card.rows.length, c.card.orphans.length, [])}</p>
        {error && <p className="m-0 text-[13px] text-error">{error}</p>}
        <Btn tone="primary" disabled={busy} onClick={() => void run(() => fixOnMac(b, c.task, c.driftKey ?? "")).then((ok) => ok && onClose())}>
          {busy ? "Cleaning up…" : "Clean up"}
        </Btn>
        <Btn tone="ghost" onClick={onClose}>
          Cancel
        </Btn>
      </div>
    </Sheet>
  );
}

/** Runs a card's out-of-sync fix: a fix that moves the task is a move; Clean up asks first; the others run on the Mac (X45, X76). */
export function fixCard(b: PhoneBoard, c: CardView, askCleanUp: () => void) {
  const to = syncedColumns(b.board, null).find((x) => x.name === c.drift?.to);
  if (to?.statuses[0]) void moveOnMac(b, c.task, { label: to.name, status: to.statuses[0] }).catch(() => {});
  else if (c.drift?.kind === "done_open") askCleanUp();
  else void fixOnMac(b, c.task, c.driftKey ?? "").catch(() => {});
}

function TaskCard({ c, b, failure }: { c: CardView; b: PhoneBoard; failure: string | null }) {
  const [cleaning, setCleaning] = useState(false);
  const onOpen = () => showScreen({ kind: "task", board: b.key, task: c.id });
  const fix = () => fixCard(b, c, () => setCleaning(true));
  const waiting = useTaskMoves()[c.id]?.waiting;
  return (
    <article className={cx("flex flex-col gap-2 rounded-[12px] border bg-panel p-3", c.needsYou ? "border-[rgba(242,201,76,0.45)]" : "border-[#242424]")}>
      <div className="flex items-center gap-[7px] text-[12px] text-muted">
        <span className="font-mono text-fg">{c.key}</span>
        {c.type && <span className="text-faint">{c.type}</span>}
        <PriorityBars priority={c.priority} />
        <span className="flex-1" />
        {c.points && <span className="font-mono text-[11.5px] text-faint">{c.points}</span>}
        {c.initials && <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-raised text-[10.5px] font-semibold text-muted">{c.initials}</span>}
      </div>
      <button type="button" onClick={onOpen} className="text-left text-[15px] leading-[1.35] font-medium">
        {c.title}
      </button>
      {c.line && <span className="-mt-1 text-[12.5px] text-faint">{c.line}</span>}
      {c.rows.map((r) => (
        <button key={r.id} type="button" onClick={() => showScreen({ kind: "session", host: b.host, id: r.id, tab: "chat" })} className="flex min-h-9 items-center gap-2 rounded-[9px] bg-raised px-2.5 text-left text-[13px]">
          <StateGlyph state={r.state} />
          <span className="min-w-0 flex-1 truncate">{r.name}</span>
          <span className={cx("text-[12px] whitespace-nowrap", META_TONE[r.meta.tone])}>{r.meta.text}</span>
        </button>
      ))}
      {!c.rows.length && (
        <div className="flex items-center gap-2">
          <span className="flex-1 text-[12.5px] text-faint">{c.empty}</span>
          <button
            type="button"
            onClick={() => startFromTask({ board: b.key, task: c.id, ...(c.card.orphans[0] && { worktree: { path: c.card.orphans[0].path, branch: c.card.orphans[0].branch ?? "", project: c.card.orphans[0].project } }) })}
            className="flex h-9 items-center gap-1.5 rounded-[9px] border border-border-strong bg-raised px-3 text-[13.5px]"
          >
            <Play size={12} />
            {c.card.orphans.length ? "Start session" : "Start"}
          </button>
        </div>
      )}
      {c.drift && (
        <div className="flex items-center gap-2 rounded-[9px] border border-[rgba(217,119,87,0.4)] bg-[rgba(217,119,87,0.07)] py-1.5 pr-1.5 pl-2.5">
          <span className="min-w-0 flex-1 text-[12.5px] text-accent-2">{c.drift.text}</span>
          <button type="button" onClick={fix} className="h-8 rounded-[8px] bg-accent px-[11px] text-[12.5px] font-semibold text-bg">
            {c.drift.fix}
          </button>
        </div>
      )}
      {waiting && <span className="text-[12.5px] text-faint">Waits for moonlet on {b.snapshot.from}</span>}
      {failure && <span className="text-[12.5px] text-error">{failure}</span>}
      {cleaning && <CleanUpSheet c={c} b={b} onClose={() => setCleaning(false)} />}
    </article>
  );
}

function Switcher({ shown, onClose }: { shown: string | null; onClose: () => void }) {
  const hosts = useApp((s) => s.hosts);
  const data = useApp((s) => s.data);
  const workspace = useApp((s) => s.settings.workspace);
  const [q, setQ] = useState("");
  const all = phoneBoards(hosts, data, null);
  const groups = switcher(all, shown, q, data, { prs: {}, git: {} });
  const pick = (key: string) => {
    const b = all.find((x) => x.key === key);
    // A board of another workspace shows that workspace (X76, as X50).
    updateSettings({ board: key, ...(b && workspace !== null && { workspace: { host: b.host, id: b.workspace, account: data[b.host]?.account ?? "" } }) });
    onClose();
  };
  return (
    <Sheet label="Boards" onClose={onClose}>
      <div className="flex items-center px-5 pt-1 pb-3">
        <h2 className="m-0 flex-1 text-[16px] font-semibold">Boards</h2>
        <button type="button" aria-label="Close" onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-full bg-raised text-muted">
          <X size={17} />
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
              <button key={r.key} type="button" onClick={() => pick(r.key)} className={cx("flex min-h-14 items-center gap-3 rounded-[12px] px-3 text-left", r.current && "bg-raised")}>
                <TrackerMark mark={r.mark} size={26} />
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
    <div role="tablist" aria-label="Columns" className="flex flex-none gap-1.5 overflow-x-auto border-b border-border px-4 pt-3 pb-2.5">
      {columns.map((c) => {
        const on = c.name === shown;
        return (
          <button
            key={c.name}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onPick(c.name)}
            className={cx("flex h-[34px] flex-none items-center gap-1.5 rounded-[9px] border px-[11px] text-[13px]", on ? "border-border-strong bg-border-strong font-semibold text-fg" : "border-border text-muted")}
          >
            <CategoryGlyph category={c.category} />
            {c.name}
            <span className="font-normal text-faint">{c.wip ?? c.count}</span>
            {c.cleanUps > 0 && (
              <span className="flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-error px-1 text-[10px] font-bold text-bg" aria-label={`${c.cleanUps} to clean up`}>
                {c.cleanUps}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function TasksScreen() {
  const { current, d, sessions } = useShownBoard();
  const savedColumns = useApp((s) => s.settings.columns);
  const mineBoards = useApp((s) => s.settings.mine);
  const notNow = useApp((s) => s.settings.notNow);
  const now = useNow();
  const moving = useTaskMoves();
  const failures = useTaskFailures();
  const [creating, setCreating] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const syncing = useBusy();
  const details = useSessionsDetails(current?.host ?? null, sessions);

  const head = (
    <div className="flex items-center gap-2.5">
      <h1 className="m-0 text-[28px] font-semibold tracking-[-0.01em]">Tasks</h1>
      <span className="flex-1" />
      {current && (
        <button type="button" aria-label="Find a task" onClick={() => setQuery(query === null ? "" : null)} className="flex h-11 w-11 items-center justify-center rounded-full text-muted">
          {query === null ? <Search size={20} /> : <X size={20} />}
        </button>
      )}
      <WorkspacePill />
    </div>
  );
  if (!current || !d) {
    return (
      <div className="flex h-full flex-col px-4" style={{ paddingTop: "calc(var(--safe-top) + 14px)" }}>
        {head}
        <p className="mt-4 text-[14.5px] leading-[1.45] text-muted">No boards yet. Add one in moonlet on the Mac (Tasks › Add a board).</p>
      </div>
    );
  }
  const mine = !!mineBoards?.[current.key];
  const screen = boardScreen(current, d, details, moving, { mine, notNow });
  const shownColumn = screen.columns.find((c) => c.name === savedColumns?.[current.key])?.name ?? firstColumn(screen.columns);
  const column = screen.columns.find((c) => c.name === shownColumn);
  const q = query?.trim().toLowerCase() ?? "";
  const cards = (column?.cards ?? []).filter((c) => !q || `${c.key} ${c.title}`.toLowerCase().includes(q));
  const foot = syncLine(current.snapshot, d.macOpen, now);
  const col = syncedColumns(current.board, null).find((x) => x.name === shownColumn);
  const canCreate = !!col && createsIn(current.board) && !!createTarget(current.board, col);
  const mark = (trackerOf(current.board.connection) ?? "github").charAt(0).toUpperCase();

  return (
    <div className="relative flex h-full flex-col">
      <header className="flex flex-none flex-col gap-3 px-4" style={{ paddingTop: "calc(var(--safe-top) + 14px)" }}>
        {head}
        {query !== null && <input autoFocus aria-label="Key or title" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Key or title" className="h-10 rounded-[10px] border border-border-strong bg-raised px-3 text-[15px] outline-none" />}
        <button type="button" aria-label="Switch board" onClick={() => setSwitching(true)} className="flex items-center gap-2.5 rounded-[12px] border border-border bg-panel px-3 py-2.5 text-left">
          <TrackerMark mark={mark} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[15px] font-semibold">{screen.title}</span>
            <span className="truncate text-[12px] text-muted">{screen.subtitle}</span>
          </span>
          <ChevronDown size={16} className="text-muted" />
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => updateSettings({ mine: { ...mineBoards, [current.key]: !mine } })}
            className="flex h-8 items-center gap-1 rounded-full border border-border-strong px-[11px] text-[12.5px]"
          >
            Assignee: {mine ? "me" : "anyone"} <ChevronDown size={12} className="text-muted" />
          </button>
          {screen.outOfSync > 0 && (
            <span className="flex h-8 items-center gap-1.5 rounded-full bg-[rgba(217,119,87,0.12)] px-[11px] text-[12.5px] text-accent-2">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              {screen.outOfSync} out of sync
            </span>
          )}
          <span className="flex-1" />
          <button
            type="button"
            aria-label="Refresh tasks"
            disabled={syncing.busy}
            onClick={() => void syncing.run(() => askMac(current, syncAction(current.board)))}
            className="flex h-9 w-9 items-center justify-center rounded-full text-muted"
          >
            <RotateCw size={15} className={cx(syncing.busy && "animate-spin")} />
          </button>
        </div>
        {syncing.error && <p className="m-0 text-[12.5px] text-error">{syncing.error}</p>}
      </header>
      <ColumnTabs columns={screen.columns} shown={shownColumn} onPick={(name) => updateSettings({ columns: { ...savedColumns, [current.key]: name } })} />
      <main className="scroll flex min-h-0 flex-1 flex-col gap-2.5 px-4 pt-3 pb-12">
        {[screen.attention, screen.problem].filter(Boolean).map((line) => (
          <p key={line} className="m-0 text-[12.5px] leading-snug text-muted">
            {line}
          </p>
        ))}
        <div className="flex items-center gap-2 text-[12.5px] text-muted">
          <span>{column?.line}</span>
          <span className="flex-1" />
          {canCreate && (
            <button type="button" onClick={() => setCreating(true)} className="flex h-8 items-center gap-1 rounded-[8px] border border-border-strong px-2.5 text-[12.5px] text-fg">
              <Plus size={13} /> New issue
            </button>
          )}
        </div>
        {!cards.length && <p className="m-0 py-6 text-center text-[14px] text-faint">{q ? "No task matches." : `Nothing in ${shownColumn ?? "this column"}.`}</p>}
        {cards.map((c) => (
          <TaskCard key={c.id} c={c} b={current} failure={failures[c.id] ?? null} />
        ))}
      </main>
      <div className="pointer-events-none absolute right-0 bottom-0 left-0 flex items-center gap-[7px] bg-[linear-gradient(transparent,#121212_40%)] px-4 pt-4 pb-2 text-[12px]" style={{ color: foot.open ? "#7d7d7d" : "#8c8c8c" }}>
        <span className="h-1.5 w-1.5 flex-none rounded-full" style={{ background: foot.open ? "#3ecf6e" : "#7d7d7d" }} />
        <span className="truncate">{foot.text}</span>
      </div>
      {switching && <Switcher shown={current.key} onClose={() => setSwitching(false)} />}
      {creating && shownColumn && <NewIssueSheet b={current} column={shownColumn} onClose={() => setCreating(false)} />}
    </div>
  );
}
