// How a session row, its project's mark and its task line look in the
// Sessions list (X48, X118). No store here: the desktop sidebar and the
// phone's Sessions draw the same rows from what each one loads.

import { useState, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import type { Column } from "../lib/tasks";
import { glyphShape } from "../lib/taskDetails";
import type { sessionGlyph } from "../lib/sidebar";
import type { numberColumn, TaskGroup } from "../lib/sessionRows";
import { StateGlyph, cx, prTone } from "./ui";

/** Project mark: the GitHub owner's avatar `src` (X15), else a dotted glyph like Conductor's. */
export function ProjectMarkView({ src, size = 15 }: { src: string | null | undefined; size?: number }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (src && failed !== src) {
    return <img src={src} alt="" width={size} height={size} draggable={false} onError={() => setFailed(src)} className="shrink-0 rounded-[3px]" style={{ width: size, height: size }} />;
  }
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className="shrink-0 text-[#4fd1c5]" fill="currentColor">
      {[
        [8, 2],
        [3, 5],
        [13, 5],
        [3, 11],
        [13, 11],
        [8, 14],
        [8, 8],
      ].map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={i === 6 ? 1.6 : 1.3} />
      ))}
    </svg>
  );
}

/** Task state by shape: ring Todo, half In Progress, three quarters In Review, filled check Done. */
export function TaskGlyph({ column, size = 14, dashed = false }: { column: Column; size?: number; dashed?: boolean }) {
  const shape = glyphShape(column);
  const done = shape === "check";
  const pie = shape === "half" ? "M7 7 L7 4 A3 3 0 0 1 7 10 Z" : shape === "three-quarters" ? "M7 7 L7 4 A3 3 0 1 1 4 7 Z" : "";
  return (
    <svg viewBox="0 0 14 14" width={size} height={size} className={cx("shrink-0", done ? "text-merged" : column === "todo" ? "text-muted" : "text-fg")} aria-hidden="true">
      <circle cx="7" cy="7" r="5.5" fill={done ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" strokeDasharray={dashed ? "2 2" : undefined} />
      {pie && <path d={pie} fill="currentColor" />}
      {done && <path d="M4.6 7.1 L6.3 8.8 L9.4 5.4" fill="none" stroke="var(--color-bg)" strokeWidth="1.5" />}
    </svg>
  );
}

/** Branch glyph tinted by PR state; a merged PR gets a merge glyph instead (the row's end badge). */
export function BranchIcon({ state }: { state?: string }) {
  const merged = state === "merged";
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" className={cx("shrink-0", prTone(state))} fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="4.5" cy="3.5" r="1.6" />
      <circle cx="4.5" cy="12.5" r="1.6" />
      {merged ? (
        <>
          <circle cx="11.5" cy="9" r="1.6" />
          <path d="M4.5 5.1v5.8M4.5 5.1c0 2.4 2.2 3.9 5.4 3.9" />
        </>
      ) : (
        <>
          <circle cx="11.5" cy="5" r="1.6" />
          <path d="M4.5 5.1v5.8M11.5 6.6c0 3-4.5 2.4-6.6 4.4" />
        </>
      )}
    </svg>
  );
}

/** A session row's leading glyph (see `sessionGlyph`). */
export function RowGlyph({ glyph, pr }: { glyph: ReturnType<typeof sessionGlyph>; pr?: string }) {
  return glyph === "branch" ? <BranchIcon state={pr} /> : <StateGlyph state={glyph} size={15} />;
}

export const BADGE_TONE = { muted: "text-muted", blocked: "text-blocked", agents: "text-faint", diff: "text-muted" };

export type RowCell = { text: string; outOfSync: boolean; width: number };

/**
 * One session row's look (X48), shared by the sidebar, the Settings
 * preview and the phone (X118): the glyph, style A's number cell, the name
 * and the badge on one line. `nested` is style B's indented 34px row under
 * a task line. `touch` makes the row 44px tall, a finger's target, as the
 * phone draws it.
 */
export function RowView({
  glyph,
  cell,
  name,
  badge,
  merged,
  mergedNote,
  selected,
  picked,
  nested,
  touch,
  ...rest
}: {
  glyph: ReactNode;
  cell?: RowCell;
  name: ReactNode;
  badge?: { text: string; tone: keyof typeof BADGE_TONE } | null;
  /** The session's PR is merged: a merge icon ends the row. */
  merged?: boolean;
  /** Why its host has not archived the merged session (X116): the icon's
   *  tooltip, amber when it needs the user. */
  mergedNote?: { text: string; warn: boolean } | null;
  selected: boolean;
  /** Picked with ⌘- or ⇧-click (X106): tinted. */
  picked?: boolean;
  nested?: boolean;
  touch?: boolean;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={cx(
        // Filled with the pane's tone when shown (X94); taller with a bigger font.
        "group relative mx-2 flex cursor-default items-center gap-2.5 rounded-md pr-2 text-left transition-colors",
        touch ? (nested ? "h-[40px] pl-[calc(0.5rem+20px)]" : "h-[44px] pl-2") : nested ? "h-ui-34 pl-[calc(0.5rem+20px)]" : "h-ui-38 pl-2",
        picked ? "bg-selected" : selected ? "bg-bg" : touch ? "active:bg-tab-hover" : "hover:bg-tab-hover",
      )}
    >
      <span className="flex w-[15px] shrink-0 justify-center">{glyph}</span>
      {cell && cell.width > 0 && (
        <span style={{ width: `${Math.max(cell.width, 3)}ch` }} className={cx("shrink-0 text-right font-mono ui-text-11.5 tabular-nums", cell.outOfSync ? "text-accent-2" : "text-faint")}>
          {cell.text}
        </span>
      )}
      {name}
      {badge && <span className={cx("shrink-0 font-mono ui-text-11.5 tabular-nums", BADGE_TONE[badge.tone])}>{badge.text}</span>}
      {merged && (
        <span role="img" aria-label={mergedNote?.text ?? "merged"} title={mergedNote?.text ?? "PR merged"} className={cx("shrink-0", mergedNote?.warn && "flex items-center gap-0.5 text-blocked")}>
          {mergedNote?.warn && <CircleAlert size={11} />}
          <BranchIcon state="merged" />
        </span>
      )}
    </div>
  );
}

/** Style B's quiet line for a task, above its sessions (X48). */
export function TaskLineHeader({ g }: { g: TaskGroup }) {
  return (
    <div title={g.key ? `${g.key} · ${g.title}` : "Not linked to a task"} className="mx-2 flex h-[24px] items-center gap-[7px] px-2 ui-text-11.5 text-faint">
      <span className="mx-[2px] flex shrink-0">
        {g.column ? (
          <TaskGlyph column={g.column} size={11} />
        ) : (
          <svg width="11" height="11" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="7" cy="7" r="5.5" fill="none" stroke="#5e5e5e" strokeWidth="1.6" strokeDasharray="2 2" />
          </svg>
        )}
      </span>
      {g.key && <span className={cx("shrink-0 font-mono ui-text-11", g.outOfSync ? "text-accent-2" : "text-muted")}>{g.key}</span>}
      <span className="min-w-0 flex-1 truncate">{g.outOfSync ? `${g.title} · out of sync` : g.title}</span>
    </div>
  );
}

/** Style B's task lines, each above its sessions with a guide line (X48). */
export function TaskGroupList({ tasks, row }: { tasks: TaskGroup[]; row: (id: string) => ReactNode }) {
  return tasks.map((t) => (
    <div key={t.key || "none"} className="flex flex-col">
      <TaskLineHeader g={t} />
      <div className="relative flex flex-col">
        <span aria-hidden className="absolute bottom-[10px] left-[calc(1rem+7.5px)] top-0 w-px bg-border-strong" />
        {t.ids.map(row)}
      </div>
    </div>
  ));
}

/** Style A's cell for one row, or none. */
export const cellOf = (column: ReturnType<typeof numberColumn> | null, id: string): RowCell | undefined => (column ? { ...column.cells[id], width: column.width } : undefined);
