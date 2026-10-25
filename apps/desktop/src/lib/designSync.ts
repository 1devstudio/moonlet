// A design system's sync in the app (X64): the step bar, what a finished
// sync left to the user, and the sync agent's notifications. Pure: the store
// is designStore.ts.

import type { ChatItem, DesignCard, DesignStep, DesignSystem } from "./protocol";

const STEPS: { step: DesignStep; label: string }[] = [
  { step: "inventory", label: "Inventory" },
  { step: "tokens", label: "Tokens" },
  { step: "cards", label: "Cards" },
  { step: "layouts", label: "Layouts" },
];

export interface StepCell {
  step: DesignStep;
  label: string;
  /** `current` while the agent works on it, `needs` while it waits for the
   *  user there, `stopped` when the sync ended there unrecorded. */
  state: "done" | "current" | "needs" | "stopped" | "pending";
  summary: string | null;
}

/** The step bar while a sync is under way (`working`: its agent is at work),
 *  or after one stopped unrecorded; null when no sync is under way. */
export function stepBar(sys: DesignSystem, working: boolean): StepCell[] | null {
  if (!working && sys.steps.length === 0) return null;
  // The last step reported is the one at work; before any, the first.
  const at = sys.steps.length ? STEPS.findIndex((s) => s.step === sys.steps[sys.steps.length - 1].step) : 0;
  return STEPS.map(({ step, label }, i) => {
    const summary = sys.steps.find((s) => s.step === step)?.summary ?? null;
    if (i < at) return { step, label, state: "done", summary };
    if (i > at) return { step, label, state: "pending", summary: null };
    if (!working) return { step, label, state: "stopped", summary };
    if (sys.needs_you) return { step, label, state: "needs", summary: sys.needs_you.text.split("\n")[0] };
    return { step, label, state: "current", summary };
  });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const base = (path: string) => path.split("/").pop() ?? path;

/** "2 cards rewritten, 1 new, 1 change to settle, 1 orphaned. 0 check problems." */
export function afterSyncLine(sys: DesignSystem, cards: DesignCard[]): string {
  const count = (change: string) => sys.last_sync.filter((c) => c.change === change).length;
  const items = needsYou(cards);
  const settle = items.filter((i) => i.kind === "edited").length;
  const orphaned = items.filter((i) => i.kind === "orphaned").length;
  const parts = [
    count("rewritten") && `${plural(count("rewritten"), "card")} rewritten`,
    count("new") && `${count("new")} new`,
    count("removed") && `${count("removed")} removed`,
    settle && plural(settle, "change to settle", "changes to settle"),
    orphaned && `${orphaned} orphaned`,
  ].filter(Boolean);
  return `${parts.join(", ") || "Nothing changed"}. ${plural(sys.check_problems, "check problem")}.`;
}

export interface NeedsYouItem {
  /** `edited`: the user edited it and the sync proposed its own version; `orphaned`: its sources are gone. */
  kind: "edited" | "orphaned";
  card: DesignCard;
  /** The proposed HTML to show beside the card, when the sync rewrote its HTML. */
  proposal: string | null;
}

/** What waits for the user after a sync: cards edited by hand with the
 *  sync's proposals, and orphans not kept for now. */
export function needsYou(cards: DesignCard[]): NeedsYouItem[] {
  const edited = cards
    .filter((c) => c.proposals.length > 0)
    .map((card) => ({ kind: "edited" as const, card, proposal: card.proposals.find((p) => p.endsWith(".proposed.html")) ?? null }));
  const orphaned = cards.filter((c) => c.orphaned && !c.kept && c.proposals.length === 0).map((card) => ({ kind: "orphaned" as const, card, proposal: null }));
  return [...edited, ...orphaned];
}

export interface ChangedRow {
  path: string;
  label: "Rewritten" | "New" | "Removed";
  name: string;
  /** Its sources' file names. */
  sources: string;
  /** The card is there to view. */
  open: boolean;
}

/** **Changed by this sync**: each card the last sync rewrote, added or removed. */
export function changedRows(sys: DesignSystem, cards: DesignCard[]): ChangedRow[] {
  const label = { rewritten: "Rewritten", new: "New", removed: "Removed" } as const;
  return sys.last_sync.map((c) => {
    const card = cards.find((x) => x.path === c.path);
    return { path: c.path, label: label[c.change], name: card?.name ?? base(c.path).replace(/\.html$/, ""), sources: c.sources.map(base).join(", "), open: !!card };
  });
}

/** The card the sync agent is writing now: the one its running Write or
 *  Edit is on (a component's `.css` or `.prompt.md` counts for its card). */
export function rewritingCard(items: ChatItem[], systemDir: string): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const t = items[i].tool;
    if (!t || t.status !== "running" || (t.name !== "Write" && t.name !== "Edit")) continue;
    const file = (t.input as { file_path?: string } | null)?.file_path ?? "";
    if (!file.startsWith(`${systemDir}/`)) continue;
    const rel = file.slice(systemDir.length + 1);
    const m = /^components\/([^/]+)\/([^/]+)\/[^/]+$/.exec(rel);
    if (m) return `components/${m[1]}/${m[2]}/${m[2]}.html`;
    if (/^ui_kits\/[^/]+\/[^/]+\.html$/.test(rel)) return rel;
  }
  return null;
}

/** The notification a change of a design system calls for (X65): its agent
 *  asks or needs an approval, or the sync was recorded; else null. */
export function syncNotice(before: DesignSystem, after: DesignSystem): { title: string; body: string } | null {
  const title = `Design · ${after.name}`;
  const asks = after.needs_you;
  if (asks && (asks.kind !== before.needs_you?.kind || asks.text !== before.needs_you?.text)) {
    return { title, body: `${asks.kind === "question" ? "asks" : "needs your approval"}: ${asks.text}` };
  }
  if (after.synced_at !== null && after.synced_at !== before.synced_at) {
    return { title, body: `${after.name} synced${after.to_settle ? ` · ${after.to_settle} to settle` : ""}` };
  }
  return null;
}
