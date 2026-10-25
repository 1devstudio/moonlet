// The right rail's History tab (X65): a design's snapshots, newest first,
// each with its type, summary and time. Picking one previews it on the
// canvas; the one previewed has Restore and Back to current. What a row
// says is lib/designHistory.ts.

import { Pencil, RotateCcw } from "lucide-react";
import { historyRows, type HistoryRow } from "../../lib/designHistory";
import type { DesignSnapshot } from "../../lib/protocol";
import { cx } from "../../lib/cx";
import { AgentIcon, Button } from "../ui";

function KindIcon({ kind }: { kind: HistoryRow["kind"] }) {
  return (
    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-raised text-muted">
      {kind === "agent_turn" ? <AgentIcon agent="claude" size={12} /> : kind === "edits_by_hand" ? <Pencil size={12} className="text-[#5b8def]" /> : <RotateCcw size={12} />}
    </span>
  );
}

export function HistoryTab({
  snapshots,
  previewed,
  locked,
  onPick,
  onBack,
  onRestore,
}: {
  /** Undefined while they are listed. */
  snapshots: DesignSnapshot[] | undefined;
  /** The snapshot the canvas previews, by number. */
  previewed: number | null;
  /** The agent works: Restore waits. */
  locked: boolean;
  onPick: (n: number) => void;
  onBack: () => void;
  onRestore: (n: number) => void;
}) {
  const rows = historyRows(snapshots ?? [], Date.now());
  return (
    <div aria-label="History" className="flex min-h-0 flex-1 flex-col">
      <p className="shrink-0 border-b border-border px-4 py-3 ui-text-12.5 text-muted">Snapshots of pages/ and assets/. The last 50 are kept.</p>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {snapshots && rows.length === 0 && <p className="px-4 py-6 text-center ui-text-12.5 text-faint">No snapshots yet. One is taken when Claude ends a turn, and when edits by hand stop for 10 seconds.</p>}
        {rows.map((r) => {
          const shown = previewed === r.n;
          return (
            <article key={r.n} aria-label={`Snapshot ${r.n}`} aria-current={shown ? "true" : undefined} className={cx("border-b border-border", shown && "bg-accent/[0.06] shadow-[inset_2px_0_var(--color-accent)]")}>
              <button className="flex w-full gap-2.5 px-3.5 py-3 text-left hover:bg-panel-2" onClick={() => onPick(r.n)}>
                <KindIcon kind={r.kind} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="flex-1 truncate ui-text-13 text-fg">{r.title}</span>
                    <span className="shrink-0 font-mono ui-text-11.5 text-faint">{r.time}</span>
                  </span>
                  {r.summary && <span className="mt-0.5 block break-words ui-text-12.5 text-muted">{r.summary}</span>}
                </span>
              </button>
              {shown && (
                <div className="flex items-center gap-3 pb-3 pl-[50px]">
                  <Button size="sm" variant="subtle" disabled={locked} title={locked ? "Restore opens when Claude stops" : undefined} onClick={() => onRestore(r.n)}>
                    Restore
                  </Button>
                  <button className="ui-text-12.5 text-muted hover:text-fg" onClick={onBack}>
                    Back to current
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
