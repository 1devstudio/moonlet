// The subagents a chat's agent launched (X42): the Agents tab's rows.

import { tokens } from "./chat";
import type { AgentState, ChatState, PermissionAsk, Subagent } from "./protocol";

/** An agent's state on screen: `needs` while one of its asks waits. */
export type AgentRowState = "needs" | "running" | "failed" | "done" | "stopped";

export interface AgentRow {
  /** The chat terminal the agent belongs to. */
  chat: number;
  agent: Subagent;
  state: AgentRowState;
  /** Its pending ask, while it needs the user. */
  ask: PermissionAsk | null;
  /** How long it ran or runs, `m:ss`. */
  elapsed: string;
  /** The row's second line. */
  line: { tone: "fg" | "muted" | "error"; text: string } | null;
}

const ORDER: AgentRowState[] = ["needs", "running", "failed", "done", "stopped"];

/** How each state shows, shared by every view of the agents. */
export const AGENT_STATE: Record<AgentRowState, { label: string; glyph: AgentState; text: string; dot: string }> = {
  needs: { label: "needs you", glyph: "blocked", text: "text-blocked", dot: "bg-blocked" },
  running: { label: "running", glyph: "working", text: "text-muted", dot: "bg-accent" },
  failed: { label: "failed", glyph: "error", text: "text-error", dot: "bg-error" },
  done: { label: "done", glyph: "done", text: "text-muted", dot: "bg-done" },
  stopped: { label: "stopped", glyph: "idle", text: "text-muted", dot: "bg-idle" },
};

/** Still at work: running, or waiting for the user. */
export const isActive = (state: AgentRowState) => state === "running" || state === "needs";

/** "1 agent", "5 agents". */
export const agentCount = (n: number) => (n === 1 ? "1 agent" : `${n} agents`);

/** `m:ss`, e.g. `1:02`. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** How long an agent ran, or runs until `now`. */
export function agentMs(a: Subagent, now: number): number {
  if (a.status === "running") return now - a.started_at;
  return a.duration_ms ?? (a.ended_at ?? now) - a.started_at;
}

/** "Wants to run …" for an agent's ask. */
export function askLine(ask: PermissionAsk): string {
  const verb = ["Bash", "shell", "command"].includes(ask.tool)
    ? "run"
    : ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(ask.tool)
      ? "edit"
      : `use ${ask.tool} on`;
  return `Wants to ${verb} ${ask.summary}`.trim();
}

function rowLine(state: AgentRowState, a: Subagent, ask: PermissionAsk | null): AgentRow["line"] {
  if (state === "needs" && ask) return { tone: "fg", text: askLine(ask) };
  if (state === "running") return a.activity ? { tone: "muted", text: a.activity } : null;
  if (state === "failed") return { tone: "error", text: a.error || "Failed" };
  if (state === "stopped") return { tone: "muted", text: "Stopped" };
  return null;
}

/** Every subagent of the given chats, those that need the user first. */
export function agentRows(chats: { id: number; st: Pick<ChatState, "subagents" | "pending"> | undefined }[], now: number): AgentRow[] {
  const rows: AgentRow[] = [];
  for (const { id, st } of chats) {
    for (const a of st?.subagents ?? []) {
      const ask = a.status === "running" ? (st?.pending.find((p) => p.agent === a.id) ?? null) : null;
      const state: AgentRowState = ask ? "needs" : a.status;
      rows.push({ chat: id, agent: a, state, ask, elapsed: clock(agentMs(a, now)), line: rowLine(state, a, ask) });
    }
  }
  // A stable sort keeps launch order within a state.
  return rows.sort((x, y) => ORDER.indexOf(x.state) - ORDER.indexOf(y.state));
}

/** The tab's header: "5 agents · 2:14 · 156k tokens", and how many can be stopped. */
export function agentsHeader(rows: AgentRow[], now: number): { text: string; running: number } {
  const total = rows.reduce((n, r) => n + r.agent.tokens, 0);
  const agents = rows.map((r) => r.agent);
  return { text: `${agentCount(rows.length)} · ${spanClock(agents, now)} · ${tokens(total)} tokens`, running: stoppable(rows).length };
}

/** The agents Stop all stops. */
export const stoppable = (rows: AgentRow[]) => rows.filter((r) => isActive(r.state));

/** From the first start to now while any runs, else to the last end. */
export function spanClock(agents: Subagent[], now: number): string {
  const start = Math.min(...agents.map((a) => a.started_at));
  const end = agents.some((a) => a.status === "running") ? now : Math.max(...agents.map((a) => a.started_at + agentMs(a, now)));
  return clock(end - start);
}

/** The Agents tab shows a dot while an agent needs the user elsewhere. */
export const agentsTabDot = (tab: string, rows: AgentRow[]) => tab !== "agents" && rows.some((r) => r.state === "needs");

/** What Retry sends the main agent for a failed agent. */
export const retryMessage = (a: Subagent) => `Run the "${a.description}" agent again.`;

/** "Haiku 5.5" for `claude-haiku-5-5`; other ids as they are. */
export function modelLabel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/.exec(id);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id;
}

/** Identifies one subagent across the session's chats. */
export const agentKey = (chat: number, id: string) => `${chat}:${id}`;
