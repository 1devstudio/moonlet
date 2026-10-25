// A design system's sync in its view (X64): the step bar while it runs, and
// after it the summary, what needs the user and what it changed.

import { Check, ChevronRight, Circle, CircleAlert, Loader2, Square, X } from "lucide-react";
import { useState } from "react";
import { errorToast } from "../../lib/store";
import { rpc } from "../../lib/daemon";
import { M, type DesignCard, type DesignSystem } from "../../lib/protocol";
import { afterSyncLine, afterSyncShown, base, changedRows, needsYou, orphanLine, proposalLabel, type NeedsYouItem, type StepCell } from "../../lib/designSync";
import { cardUrl } from "../../lib/designView";
import { loadCards, loadSystems, openCard } from "../../lib/designStore";
import { cx } from "../../lib/cx";
import { Button } from "../ui";

/** Inventory › Tokens › Cards › Layouts, each with its result. */
export function StepBar({ cells }: { cells: StepCell[] }) {
  const icon = (c: StepCell) =>
    c.state === "done" ? (
      <Check size={12} className="text-done" />
    ) : c.state === "current" ? (
      <Loader2 size={12} className="animate-spin text-accent" />
    ) : c.state === "needs" ? (
      <CircleAlert size={12} className="text-blocked" />
    ) : c.state === "stopped" ? (
      <Square size={10} className="text-faint" />
    ) : (
      <Circle size={10} className="text-faint" />
    );
  return (
    <ol aria-label="Sync steps" className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-4 py-2 ui-text-12.5">
      {cells.map((c, i) => (
        <li key={c.step} className="flex shrink-0 items-center gap-1">
          {i > 0 && <ChevronRight size={12} className="text-faint" />}
          <span
            aria-current={c.state === "current" || c.state === "needs" ? "step" : undefined}
            className={cx(
              "flex items-center gap-1.5 rounded-full px-2.5 py-1",
              c.state === "current" && "bg-accent/10 text-fg",
              c.state === "needs" && "bg-blocked/15 text-fg",
              c.state === "done" && "text-fg",
              (c.state === "pending" || c.state === "stopped") && "text-faint",
            )}
          >
            {icon(c)}
            {c.state === "needs" ? "Needs you" : c.label}
            {c.summary && <span className={cx("max-w-[280px] truncate", c.state === "needs" ? "text-blocked" : "text-muted")}>{c.summary}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** When the app started: a sync recorded since is summed up even when it changed nothing. */
const STARTED = Date.now();

/** "Sync finished · …", dismissed until the next sync. */
export function AfterSyncBar({ sys, cards, onOpenAgent }: { sys: DesignSystem; cards: DesignCard[]; onOpenAgent: (() => void) | null }) {
  const [dismissed, setDismissed] = useState<number | null>(null);
  if (!afterSyncShown(sys, cards, STARTED) || dismissed === sys.synced_at) return null;
  return (
    <div role="status" className="flex shrink-0 items-center gap-2 border-b border-border bg-done/[0.07] px-5 py-2 ui-text-12.5">
      <Check size={13} className="text-done" />
      <span className="font-medium text-fg">Sync finished</span>
      <span className="min-w-0 flex-1 truncate text-muted">· {afterSyncLine(sys, cards)}</span>
      {onOpenAgent && (
        <Button size="sm" variant="ghost" onClick={onOpenAgent}>
          Open agent
        </Button>
      )}
      <button aria-label="Dismiss" className="rounded p-1 text-faint hover:bg-panel-2 hover:text-fg" onClick={() => setDismissed(sys.synced_at)}>
        <X size={13} />
      </button>
    </div>
  );
}

const sectionLabel = "mb-3 ui-text-11.5 uppercase tracking-[0.08em] text-faint";

/** A card's frame at a fixed width, for Needs you. */
function Preview({ url, title, viewport, width }: { url: string; title: string; viewport: [number, number]; width: number }) {
  const scale = Math.min(width / viewport[0], 1);
  return (
    <div className="relative overflow-hidden" style={{ width: viewport[0] * scale, height: Math.min(viewport[1] * scale, 280) }}>
      <iframe title={title} src={url} sandbox="allow-scripts" className="pointer-events-none absolute left-0 top-0 border-0" style={{ width: viewport[0], height: viewport[1], transform: `scale(${scale})`, transformOrigin: "0 0" }} />
    </div>
  );
}

/** **Needs you**: a card edited by hand beside the sync's version, and an orphan. */
export function NeedsYouSection({ host, workspace, sys, cards, rev }: { host: string; workspace: string; sys: DesignSystem; cards: DesignCard[]; rev: number }) {
  const items = needsYou(cards);
  const [busy, setBusy] = useState<string | null>(null);
  if (items.length === 0) return null;
  const settle = async (item: NeedsYouItem, choice: "mine" | "synced" | "keep" | "remove") => {
    setBusy(item.card.path);
    try {
      await rpc(host, M.designSettle, { workspace, slug: sys.slug, card: item.card.path, choice });
      await Promise.all([loadCards(host, workspace, sys.slug), loadSystems(host, workspace)]);
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section aria-label="Needs you" className="mb-8">
      <h2 className={sectionLabel}>Needs you · {items.length}</h2>
      <div className="flex flex-col gap-4">
        {items.map((item) =>
          item.kind === "edited" ? (
            <div key={`edited-${item.card.path}`} className="overflow-hidden rounded-lg border border-accent/50 bg-panel">
              <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="ui-text-13 text-fg">
                    {item.card.name} <span className="text-faint">· {item.card.group}</span>
                  </p>
                  <p className="ui-text-12 text-muted">You edited this card by hand, and the sync wrote its version beside yours.</p>
                </div>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void settle(item, "mine")}>
                  Keep mine
                </Button>
                <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void settle(item, "synced")}>
                  Use synced
                </Button>
              </div>
              <div className="grid grid-cols-2 divide-x divide-border">
                <div className="min-w-0 p-3">
                  <p className="mb-2 font-mono ui-text-11.5 text-muted">{base(item.card.path)} · yours</p>
                  <Preview url={cardUrl(workspace, sys.slug, item.card.path, rev)} title={`${item.card.name}, yours`} viewport={item.card.viewport} width={420} />
                </div>
                <div className="min-w-0 p-3">
                  <p className="mb-2 font-mono ui-text-11.5 text-accent">{proposalLabel(item)} · synced</p>
                  {item.proposal ? (
                    <Preview url={cardUrl(workspace, sys.slug, item.proposal, rev)} title={`${item.card.name}, synced`} viewport={item.card.viewport} width={420} />
                  ) : (
                    <p className="ui-text-12.5 text-muted">The sync changed {proposalLabel(item)}; your HTML stays.</p>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div key={`orphaned-${item.card.path}`} className="flex items-center gap-3 rounded-lg border border-dashed border-border-strong bg-panel px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="ui-text-13 text-fg">
                  {item.card.name} <span className="text-faint">· {item.card.group} · orphaned</span>
                </p>
                <p className="ui-text-12 text-muted">{orphanLine(item.card)}</p>
              </div>
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void settle(item, "keep")}>
                Keep for now
              </Button>
              <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => void settle(item, "remove")}>
                Remove card
              </Button>
            </div>
          ),
        )}
      </div>
    </section>
  );
}

/** **Changed by this sync**: each card it rewrote, added or removed, with **View**. */
export function ChangedSection({ host, workspace, sys, cards }: { host: string; workspace: string; sys: DesignSystem; cards: DesignCard[] }) {
  const rows = changedRows(sys, cards);
  if (rows.length === 0) return null;
  const tone = { Rewritten: "bg-accent/15 text-accent", New: "bg-done/15 text-done", Removed: "bg-error/15 text-error" } as const;
  return (
    <section aria-label="Changed by this sync" className="mb-8">
      <h2 className={sectionLabel}>Changed by this sync · {rows.length}</h2>
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-panel">
        {rows.map((r) => (
          <div key={r.path} className="flex h-11 items-center gap-3 px-4">
            <span className={cx("rounded px-1.5 py-0.5 ui-text-11.5", tone[r.label])}>{r.label}</span>
            <span className="min-w-0 flex-1 truncate ui-text-13 text-fg">{r.name}</span>
            <span className="font-mono ui-text-11.5 text-faint">{r.sources}</span>
            {r.open && (
              <Button size="sm" variant="ghost" onClick={() => openCard(host, workspace, sys.slug, r.path)}>
                View
              </Button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
