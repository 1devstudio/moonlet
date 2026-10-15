// The subagents a chat's agent launched (X42): the Agents tab's rows.

import { type ChatBlock, invisible, tokens } from "./chat";
import type { AgentState, ChatItem, ChatState, PermissionAsk, Subagent } from "./protocol";

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

/** "Wants to run …" for an agent's ask. A command shows in full, not
 *  only its first line as in `summary`: Allow sits right next to it. */
export function askLine(ask: PermissionAsk): string {
  const shell = ["Bash", "shell", "command"].includes(ask.tool);
  const command = (ask.input as { command?: unknown } | null)?.command;
  const verb = shell ? "run" : ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(ask.tool) ? "edit" : `use ${ask.tool} on`;
  return `Wants to ${verb} ${shell && typeof command === "string" ? command : ask.summary}`.trim();
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

/** What Retry sends the main agent for failed agents. */
export function retryMessage(agents: Subagent[]): string {
  const names = agents.map((a) => `"${a.description}"`);
  return names.length === 1 ? `Run the ${names[0]} agent again.` : `Run these agents again: ${names.join(", ")}.`;
}

/** When an agent ended, or would have by Claude's duration. */
const endedAt = (a: Subagent) => a.ended_at ?? a.started_at + (a.duration_ms ?? 0);

// The strip's steps after an agent ended (ms), from the design.
/** A finished agent's dot pops this long. */
const DOT_POP = 280;
/** The done count shows green this long. */
const COUNT_FLASH = 900;
/** Then the dot shrinks away. */
const DOT_HIDE = 1200;
/** "All done" holds this long after the last one ended, then the strip folds. */
const STRIP_FOLD = 1600;

/** One agent's dot in the strip: `pop` just after it ended, `gone` once
 *  hidden. Only agents still at work keep theirs. */
export interface StripDot {
  key: string;
  state: AgentRowState;
  phase: "pop" | "on" | "gone";
}

/** The strip above the chat input (X42). */
export interface StripView {
  /** One per agent, in launch order. */
  dots: StripDot[];
  /** "All done" once every agent is done, else none: the counts lead. */
  title: string | null;
  /** "2 running", "2 done", "1 stopped": the counts after the title. */
  counts: { state: "running" | "done" | "stopped"; text: string }[];
  /** An agent finished just now: the done count shows green. */
  flash: boolean;
  /** Every agent is done: the title gets a check. */
  finished: boolean;
  /** Finished a while ago: the strip folds away. */
  collapsed: boolean;
  alert: { tone: "blocked" | "error"; text: string } | null;
  clock: string;
  /** Review changes once all ended, some stopped; Retry once one failed and none runs. */
  button: "review" | "retry" | null;
  dismissible: boolean;
  /** When the view next changes with no new data, or null. */
  wake: number | null;
}

/** The agents launched since the user's last message. */
export function batchOf(st: ChatState): Subagent[] {
  const since = st.items.reduce((t, i) => (i.kind === "user" ? Math.max(t, i.ts) : t), 0);
  return (st.subagents ?? []).filter((a) => a.started_at >= since);
}

/** The agents launched since the user's last message, unless × hid them
 *  (`dismissedAt`, the latest start then); `null` hides the strip. */
export function stripView(st: ChatState, now: number, dismissedAt: number): StripView | null {
  const batch = batchOf(st);
  if (!batch.length || batch.every((a) => a.started_at <= dismissedAt)) return null;
  const rows = agentRows([{ id: 0, st: { ...st, subagents: batch } }], now);
  const stateOf = new Map(rows.map((r) => [r.agent, r.state]));
  const n = (state: AgentRowState) => rows.filter((r) => r.state === state).length;
  const idle = !rows.some((r) => isActive(r.state));
  const ended = idle && !n("failed");
  // Finished means every agent did its work; stopped ones did not.
  const finished = ended && !n("stopped");
  const counts = (["running", "done", "stopped"] as const).filter((state) => n(state)).map((state) => ({ state, text: `${n(state)} ${state}` }));
  const ends = batch.filter((a) => a.status === "done").map(endedAt);
  // Every ended agent's dot pops and hides; only done ones flash the count.
  const dotEnds = batch.filter((a) => a.status !== "running").map(endedAt);
  const last = finished ? Math.max(...ends) : NaN;
  const wake = Math.min(
    ...[...dotEnds.flatMap((t) => [t + DOT_POP, t + DOT_HIDE]), ...ends.map((t) => t + COUNT_FLASH), last + STRIP_FOLD].filter((t) => t > now),
  );
  const alert = n("needs") ? { tone: "blocked" as const, text: `${n("needs")} needs you` } : n("failed") ? { tone: "error" as const, text: `${n("failed")} failed` } : null;
  return {
    dots: batch.map((a) => {
      const state = stateOf.get(a)!;
      return { key: a.id, state, phase: a.status === "running" ? "on" : dotPhase(now - endedAt(a)) };
    }),
    title: finished ? "All done" : null,
    counts: finished ? [] : counts,
    flash: ends.some((t) => now < t + COUNT_FLASH),
    finished,
    collapsed: now >= last + STRIP_FOLD,
    alert,
    clock: spanClock(batch, now),
    button: ended && !finished ? "review" : idle && n("failed") ? "retry" : null,
    dismissible: ended && !finished,
    wake: Number.isFinite(wake) ? wake : null,
  };
}

/** An ended agent's dot phase, `since` ms after it ended. An end a little
 *  ahead of this clock (the daemon's) still pops. */
function dotPhase(since: number): StripDot["phase"] {
  if (since >= DOT_HIDE) return "gone";
  return since < DOT_POP ? "pop" : "on";
}

/** The strip's × hides it until an agent starts after this. */
export const stripDismissAt = (st: ChatState) => Math.max(0, ...batchOf(st).map((a) => a.started_at));

/** What the strip's Retry sends: the batch's failed agents, if any. */
export function stripRetry(st: ChatState): string | null {
  const failed = batchOf(st).filter((a) => a.status === "failed");
  return failed.length ? retryMessage(failed) : null;
}

/** Lines the agents' edits added and removed, and the files they edited.
 *  Only edits that went through count. */
export function batchDiff(agents: Subagent[]): { additions: number; deletions: number; files: number } {
  const edits = agents.flatMap((a) => a.tools).filter((t) => t.status === "ok" && t.added != null);
  return {
    additions: edits.reduce((n, t) => n + (t.added ?? 0), 0),
    deletions: edits.reduce((n, t) => n + (t.removed ?? 0), 0),
    files: new Set(edits.map((t) => t.summary)).size,
  };
}

/** "+318 −41 in 9 files", or nothing without edits. */
export function diffLine(d: { additions: number; deletions: number; files: number }): string {
  return d.additions || d.deletions ? `+${d.additions} −${d.deletions} in ${d.files} ${d.files === 1 ? "file" : "files"}` : "";
}

/** "Haiku 5.5" for `claude-haiku-5-5`; other ids as they are. */
export function modelLabel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/.exec(id);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id;
}

/** Identifies one subagent across the session's chats. */
export const agentKey = (chat: number, id: string) => `${chat}:${id}`;

const STATE_LABEL: Record<AgentRowState, string> = { needs: "needs you", running: "running", failed: "failed", done: "done", stopped: "stopped" };

/** The rows of a "Launched N agents" card, one per Agent call (X42). */
export function launchedRows(
  tools: ChatItem[],
  rows: AgentRow[],
): { key: string; description: string; state: AgentRowState | null; label: string; elapsed: string; agent: string | null }[] {
  return tools.map((t) => {
    const r = rows.find((x) => x.agent.tool_use_id === t.id);
    if (!r) return { key: t.id, description: t.tool?.summary ?? "", state: null, label: "", elapsed: "", agent: null };
    return { key: t.id, description: r.agent.description, state: r.state, label: STATE_LABEL[r.state], elapsed: r.elapsed, agent: agentKey(r.chat, r.agent.id) };
  });
}

/** The subagent that asks, for the permission card's header; null for the
 *  main agent. The name is the model's, so it stays on one line, apart from
 *  the request it heads. */
export function askerName(ask: PermissionAsk, subagents: Subagent[]): string | null {
  const a = ask.agent ? subagents.find((x) => x.id === ask.agent) : undefined;
  if (!a) return null;
  // Line breaks and other control characters (C0, DEL, C1) become spaces.
  return a.description.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
}

export type AgentNote = { kind: "finished"; agent: Subagent } | { kind: "all"; title: string; clock: string; diff: string };

/** Notes in the conversation (X42): each agent that finished or failed,
 *  after the last message that shows from before it ended, and each batch
 *  of agents (launched after the same user message) once every one ended.
 *  `after` is null when no message came before. */
export function agentNotes(items: ChatItem[], subagents: Subagent[]): { after: string | null; note: AgentNote }[] {
  const shown = items.filter((i) => !invisible(i));
  const anchor = (t: number) => shown.reduce<ChatItem | null>((last, i) => (i.ts <= t ? i : last), null)?.id ?? null;
  const userTimes = items.filter((i) => i.kind === "user").map((i) => i.ts);
  const batchOfAgent = (a: Subagent) => Math.max(0, ...userTimes.filter((t) => t <= a.started_at));
  const notes: { at: number; after: string | null; note: AgentNote }[] = [];
  for (const a of subagents) {
    if (a.status === "done" || a.status === "failed") notes.push({ at: endedAt(a), after: anchor(endedAt(a)), note: { kind: "finished", agent: a } });
  }
  const batches = new Map<number, Subagent[]>();
  for (const a of subagents) batches.set(batchOfAgent(a), [...(batches.get(batchOfAgent(a)) ?? []), a]);
  for (const batch of batches.values()) {
    if (batch.length < 2 || batch.some((a) => a.status === "running")) continue;
    const last = Math.max(...batch.map(endedAt));
    const finished = batch.every((a) => a.status === "done");
    const note: AgentNote = { kind: "all", title: `${agentCount(batch.length)} ${finished ? "finished" : "ended"}`, clock: spanClock(batch, last), diff: diffLine(batchDiff(batch)) };
    // After the last agent's own note.
    notes.push({ at: last + 0.5, after: anchor(last), note });
  }
  return notes.sort((x, y) => x.at - y.at).map(({ after, note }) => ({ after, note }));
}

/** Where the notes go among the conversation's blocks: before them all, or
 *  after the block holding their message (by block id). */
export function notesByBlock(blocks: ChatBlock[], notes: { after: string | null; note: AgentNote }[]): { lead: AgentNote[]; after: Record<string, AgentNote[]> } {
  const blockOf = new Map<string, string>();
  for (const b of blocks) {
    if (b.kind === "item") blockOf.set(b.item.id, b.item.id);
    else for (const t of b.tools) blockOf.set(t.id, b.id);
  }
  const lead: AgentNote[] = [];
  const after: Record<string, AgentNote[]> = {};
  for (const n of notes) {
    const block = n.after === null ? undefined : blockOf.get(n.after);
    if (block === undefined) lead.push(n.note);
    else (after[block] ??= []).push(n.note);
  }
  return { lead, after };
}
