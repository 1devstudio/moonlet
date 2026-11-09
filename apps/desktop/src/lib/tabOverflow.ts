// A session's tab row when its tabs don't fit (X94): which sides fade, how
// many tabs are out of view, where to scroll, and the All tabs list.

import type { AgentState, JobState } from "./protocol";

/** WebKit leaves a fraction of a pixel at either end of a scrolled row. */
const SLACK = 1;

export interface ScrollBox {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
}

/** The sides of the row with tabs out of view, where a fade and a chevron show. */
export function tabEdges(row: ScrollBox): { left: boolean; right: boolean } {
  return {
    left: row.scrollLeft > SLACK,
    right: row.scrollLeft + row.clientWidth < row.scrollWidth - SLACK,
  };
}

export interface Span {
  left: number;
  right: number;
}

/** How many tabs are wholly or partly out of the row's view: the All tabs badge. */
export function hiddenTabs(row: Span, tabs: Span[]): number {
  return tabs.filter((t) => t.right > t.left && (t.left < row.left - SLACK || t.right > row.right + SLACK)).length;
}

/** Clear space kept between a tab scrolled into view and the row's edge. */
const REVEAL_PAD = 40;

/** Where to scroll the row so the tab shows, 40 px clear of the edge; null when it already does. */
export function revealScroll(tab: { offsetLeft: number; offsetWidth: number }, row: { scrollLeft: number; clientWidth: number }): number | null {
  const left = tab.offsetLeft;
  const right = left + tab.offsetWidth;
  const to =
    left < row.scrollLeft + REVEAL_PAD
      ? Math.max(0, left - REVEAL_PAD)
      : right > row.scrollLeft + row.clientWidth - REVEAL_PAD
        ? right - row.clientWidth + REVEAL_PAD
        : row.scrollLeft;
  return to === row.scrollLeft ? null : to;
}

/** How far a wheel event scrolls the row sideways: a vertical wheel's travel; a sideways swipe scrolls the row by itself. */
export function wheelScroll(deltaX: number, deltaY: number): number {
  return Math.abs(deltaY) > Math.abs(deltaX) ? deltaY : 0;
}

/** How far a chevron scrolls the row: 60 % of its width, at least 160 px. */
export function scrollStep(clientWidth: number): number {
  return Math.max(160, clientWidth * 0.6);
}

/** What a tab shows: a terminal (agent or shell), a file, a diff or a job. */
export type TabState =
  | { kind: "terminal"; agentState?: AgentState | null; exited?: boolean }
  | { kind: "file"; dirty: boolean }
  | { kind: "diff" }
  | { kind: "job"; state?: JobState };

export type TabTone = "working" | "blocked" | "done" | "error" | "unsaved" | "idle";

const QUIET = { tone: "idle", label: "" } as const;

/** A tab's status in the All tabs list: its dot's tone and its word. */
export function tabStatus(tab: TabState): { tone: TabTone; label: string } {
  switch (tab.kind) {
    case "terminal":
      if (tab.exited) return { tone: "idle", label: "Exited" };
      if (tab.agentState === "working") return { tone: "working", label: "Running" };
      if (tab.agentState === "blocked") return { tone: "blocked", label: "Needs input" };
      return QUIET;
    case "file":
      return tab.dirty ? { tone: "unsaved", label: "Unsaved" } : QUIET;
    case "job": {
      const s = tab.state;
      if (!s) return QUIET;
      if (s.kind === "waiting" || s.kind === "running" || s.kind === "bringing_back") return { tone: "working", label: "Running" };
      return s.kind === "done" && s.exit === 0 ? { tone: "done", label: "Done" } : { tone: "error", label: "Failed" };
    }
    case "diff":
      return QUIET;
  }
}

/** The All tabs list narrowed by its filter: the tabs whose name has it, in any case. */
export function filterTabs<T extends { name: string }>(tabs: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  return q ? tabs.filter((t) => t.name.toLowerCase().includes(q)) : tabs;
}
