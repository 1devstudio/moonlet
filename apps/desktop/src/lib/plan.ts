// The plan panel (X24): the latest plan of a chat, where it stands, and
// which chat of a session the Plan tab follows.

import { planOf } from "./chat";
import type { ChatState } from "./protocol";

export type PlanStatus = "pending" | "revising" | "stopped" | "approved";

export interface PlanView {
  plan: string;
  file: string | null;
  /** The plan's first heading, else its first line (the daemon's summary). */
  title: string;
  /** When the plan's call arrived; null when only the ask is known. */
  ts: number | null;
  /** The transcript row of the plan's `ExitPlanMode` call, if any. */
  itemId: string | null;
  /** The pending ask to answer, if the plan waits for one. */
  askId: string | null;
  status: PlanStatus;
  /** The chat's mode once the plan is approved. */
  mode: string | null;
}

/** The chat's latest plan: its pending `ExitPlanMode` ask, else its last `ExitPlanMode` call. */
export function planView(st: ChatState): PlanView | null {
  const item = st.items.findLast((i) => i.tool && planOf({ tool: i.tool.name, input: i.tool.input }));
  const tool = item?.tool;
  const ask = st.pending.find((a) => planOf(a));
  if (ask) {
    const p = planOf(ask)!;
    const running = tool?.status === "running";
    return { ...p, title: ask.summary || "Plan", ts: running ? item!.ts : null, itemId: running ? item!.id : null, askId: ask.id, status: "pending", mode: null };
  }
  if (!item || !tool) return null;
  const status: PlanStatus = tool.status === "running" ? "pending" : tool.status === "denied" ? "revising" : tool.status === "error" ? "stopped" : "approved";
  return {
    ...planOf({ tool: tool.name, input: tool.input })!,
    title: tool.summary || "Plan",
    ts: item.ts,
    itemId: item.id,
    askId: null,
    status,
    mode: status === "approved" ? (st.mode ?? null) : null,
  };
}

/** How an approved plan runs, by the mode Claude reports. */
const APPROVED: Record<string, string> = { auto: "auto mode", acceptEdits: "accepting edits", manual: "asking before edits" };

/** The plan's status in the conversation card and the panel, and its colour token. */
export function planLabels(status: PlanStatus, mode: string | null): { card: string; panel: string; tone: "blocked" | "accent" | "muted" | "done" } {
  if (status === "pending") return { card: "Claude has a plan · waiting for approval", panel: "Waiting for your approval", tone: "blocked" };
  if (status === "revising") return { card: "Plan · revising with your feedback", panel: "Revising", tone: "accent" };
  if (status === "stopped") return { card: "Plan · stopped", panel: "Stopped", tone: "muted" };
  const how = mode ? APPROVED[mode] : undefined;
  return how ? { card: `Plan approved · ${how}`, panel: `Approved · ${how}`, tone: "done" } : { card: "Plan approved", panel: "Approved", tone: "done" };
}

/** The chat the Plan tab follows among a session's chats: the one whose plan
 *  waits, else the focused one, else the first (lowest id). */
export function planChat(focused: number | null, chats: readonly { id: number; st: ChatState | undefined }[]): number | null {
  const waiting = chats.find((c) => c.st?.pending.some((a) => planOf(a)));
  if (waiting) return waiting.id;
  if (chats.some((c) => c.id === focused)) return focused;
  return chats.length ? Math.min(...chats.map((c) => c.id)) : null;
}

/** The Plan tab's dot: a plan waits and the tab is not showing it. */
export const planTabDot = (tab: string, preview: boolean, waiting: boolean) => waiting && (tab !== "plan" || preview);
