import { Archive, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { archivedCount } from "../../lib/archivedSession";
import type { BoardSession } from "../../lib/tasksBoard";
import { cx } from "../ui";

/** A task's archived sessions (X86): a folded `N archived` line under its
 *  live ones; unfolded, a row per session that opens its read-only page. */
export function ArchivedSessions({ sessions, host, onOpen, className }: { sessions: BoardSession[]; host: string; onOpen: (host: string, id: string) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const label = archivedCount(sessions.length);
  if (!label) return null;
  return (
    <div className={cx("flex flex-col", className)}>
      <button aria-expanded={open} className="flex items-center gap-1 self-start ui-text-12 text-faint hover:text-muted" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {label}
      </button>
      {open &&
        sessions.map((s) => (
          <button
            key={s.id}
            aria-label={`Archived session ${s.name}`}
            onClick={() => onOpen(s.host ?? host, s.id)}
            className="flex h-[24px] items-center gap-[7px] rounded-md px-1.5 text-left hover:bg-panel-2"
          >
            <Archive size={12} className="shrink-0 text-faint" />
            <span className="min-w-0 flex-1 truncate ui-text-12.5 text-muted">{s.name}</span>
            <span className="max-w-[45%] truncate font-mono ui-text-11 text-faint">{s.branch}</span>
          </button>
        ))}
    </div>
  );
}
