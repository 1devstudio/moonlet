// The session screen's header and Chat tab (X40).

import { CLAUDE_MODELS, CLAUDE_MODES, DEFAULT_MODE, EFFORTS } from "@desktop/lib/agents";
import { type ChatBlock, contextView } from "@desktop/lib/chat";
import type { ChatState, Project, QueuedMessage, Session, TerminalInfo } from "@desktop/lib/protocol";
import { sendNowLabel, sendNowParams, unqueued } from "@desktop/lib/queued";
import { type AgentRowState, agentRows } from "@desktop/lib/subagents";
import type { ChatSummary, HostData } from "./app";

/** The session's conversation: its first chat terminal. */
export function sessionChat(d: HostData, sessionId: string): number | null {
  const chats = Object.values(d.terminals)
    .filter((t) => t.session_id === sessionId && t.chat)
    .sort((a, b) => a.created_at - b.created_at);
  return chats[0]?.id ?? null;
}

/** A conversation row's React key: an item's id, a run's id (its first call). */
export const blockKey = (b: ChatBlock) => (b.kind === "item" ? b.item.id : b.id);

/** The session's shell, run and setup terminals, oldest first. */
export function shellTerminals(d: HostData, sessionId: string): TerminalInfo[] {
  return Object.values(d.terminals)
    .filter((t) => t.session_id === sessionId && !t.chat && t.kind !== "agent")
    .sort((a, b) => a.created_at - b.created_at);
}

/** `storefront · moonlet/add-search · This Mac` */
export const sessionLine = (s: Session, p: Project | undefined, host: string) => [p?.name, s.branch, host].filter(Boolean).join(" · ");

export interface ChatFooter {
  /** Share of the context window used, whole percent. */
  context: number | null;
  cost: string | null;
  model: string;
  mode: string;
}

export function chatFooter(st: ChatSummary): ChatFooter {
  const model = st.model ? (CLAUDE_MODELS.find((m) => m.id === st.model)?.label ?? st.model) : "Default model";
  const effort = EFFORTS.find((e) => e.id === st.effort)?.label;
  return {
    context: st.context ? contextView(st.context).percent : null,
    cost: st.cost_usd > 0 ? `$${st.cost_usd.toFixed(2)}` : null,
    model: effort && st.model ? `${model} · ${effort}` : model,
    mode: CLAUDE_MODES.find((m) => m.id === (st.mode ?? DEFAULT_MODE))?.label ?? st.mode ?? "Manual",
  };
}

/** The buttons under the queued messages (X49): Send now for all of them,
 * Ask aside for the last; none once Send now was asked. */
export function queuedActions(queued: readonly QueuedMessage[]): { sendNow: string; params: { message?: string }; aside: QueuedMessage } | null {
  if (!queued.length || queued.some((q) => q.sending)) return null;
  return { sendNow: sendNowLabel(queued), params: sendNowParams(queued), aside: queued[queued.length - 1] };
}

/** After Ask aside took `asked` out of the queue (X49): wait for Claude, ask
 * it aside once Claude gave it back, or say Claude read it first. */
export function asideStep(st: Pick<ChatState, "queued" | "items">, asked: QueuedMessage): { kind: "wait" } | { kind: "ask"; question: string } | { kind: "note"; text: string } {
  const outcome = unqueued(st, asked.id);
  if (outcome === "waiting") return { kind: "wait" };
  return outcome === "cancelled" ? { kind: "ask", question: asked.text } : { kind: "note", text: "Claude read the message before it could be asked aside" };
}

/** The session header's strip while subagents work (X76): a bar per agent
 * in launch order, how many are done, and whether one needs the user. */
export function agentStrip(st: Pick<ChatState, "subagents" | "pending">, now: number): { bars: AgentRowState[]; progress: string; word: string } | null {
  const agents = st.subagents ?? [];
  if (!agents.length) return null;
  const stateOf = new Map(agentRows([{ id: 0, st }], now).map((r) => [r.agent.id, r.state]));
  const bars = agents.map((a) => stateOf.get(a.id) ?? "done");
  const needs = bars.filter((b) => b === "needs").length;
  const active = bars.some((b) => b === "running" || b === "needs");
  const ended = (["failed", "stopped"] as const).filter((x) => bars.includes(x)).map((x) => `${bars.filter((b) => b === x).length} ${x}`);
  const word = needs ? `${needs} needs you` : active ? "all running" : ended.length ? ended.join(" · ") : "all done";
  return { bars, progress: `${bars.filter((b) => b === "done").length}/${bars.length}`, word };
}
