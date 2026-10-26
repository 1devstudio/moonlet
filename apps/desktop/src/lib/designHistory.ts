// A design's History (X65): its snapshots as the right rail's History tab
// lists them, and the snapshot the canvas previews. Pure: the screen is
// components/design/DesignScreen.tsx.

import { MONTHS } from "./dates";
import type { DesignSnapshot, SnapshotKind } from "./protocol";

/** One snapshot as the History tab lists it. */
export interface HistoryRow {
  n: number;
  kind: SnapshotKind;
  /** "Agent turn", "Edits by hand" or "Restored snapshot 3". */
  title: string;
  summary: string;
  time: string;
}

const TITLES: Record<SnapshotKind, string> = { agent_turn: "Agent turn", edits_by_hand: "Edits by hand", restored: "Restored snapshot" };

/** A snapshot's type as History says it ("Agent turn", "Edits by hand",
 *  "Restored snapshot 3"), and for a restore the snapshot it made current. */
function typeOf(s: DesignSnapshot): { title: string; from: { n: number; time: number } | null } {
  if (s.type === "restored" && s.from) return { title: `${TITLES.restored} ${s.from.n}`, from: s.from };
  return { title: TITLES[s.type], from: null };
}
const two = (n: number) => String(n).padStart(2, "0");

/** When a snapshot was taken, in local time: "10:41" today, else "Oct 24, 18:30". */
export function snapshotTime(ms: number, now: number): string {
  const d = new Date(ms);
  const today = new Date(now);
  const hour = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay ? hour : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${hour}`;
}

/** The History tab's rows, in the order `design.history` gives them (newest
 *  first): a restore says the time of the snapshot it made current. */
export function historyRows(snapshots: DesignSnapshot[], now: number): HistoryRow[] {
  return snapshots.map((s) => {
    const { title, from } = typeOf(s);
    return { n: s.n, kind: s.type, title, summary: from ? `From ${snapshotTime(from.time, now)}` : s.summary, time: snapshotTime(s.time, now) };
  });
}

/** The blue bar's time and type of the snapshot previewed: "10:33", "edits by hand". */
export function previewBar(s: DesignSnapshot, now: number): { time: string; type: string } {
  return { time: snapshotTime(s.time, now), type: typeOf(s).title.toLowerCase() };
}

/** The snapshot the canvas previews, by number; null for the current pages. */
export type Preview = { n: number } | null;

export type PreviewAct =
  /** A snapshot picked in the History tab. */
  | { kind: "pick"; n: number }
  /** **Back to current**. */
  | { kind: "back" }
  /** **Restore**: the snapshot is the current design now. */
  | { kind: "restored" }
  /** The design's snapshots listed again. */
  | { kind: "listed"; snapshots: DesignSnapshot[] };

/** The snapshot previewed after `act`: a pick previews it, Back to current
 *  and a restore show the current pages again, and so does a listing
 *  without it (rotated out of the newest 50). */
export function previewStep(p: Preview, act: PreviewAct): Preview {
  switch (act.kind) {
    case "pick":
      return { n: act.n };
    case "back":
    case "restored":
      return null;
    case "listed":
      return p && act.snapshots.some((s) => s.n === p.n) ? p : null;
  }
}
