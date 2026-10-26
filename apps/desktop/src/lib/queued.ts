// Queued messages, Send now and Ask aside (X49): what the chat says about
// messages Claude has not read yet.
import type { AsideAnswer, ChatItem, ChatState, QueuedMessage } from "./protocol";
import { clock } from "./subagents";
import type { ChatImage } from "./attachments";

/** A line of the queued area: text, then a command in mono, then more text. */
export interface Line {
  text: string;
  command?: string;
  tail?: string;
}

/** The tool call the turn waits on: the last one still running. */
export interface Running {
  id: string;
  summary: string;
  /** When the call started (ms). */
  since: number;
}

export function waitingOn(items: readonly ChatItem[]): Running | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.tool?.status === "running") return { id: it.id, summary: it.tool.summary, since: it.ts };
  }
  return null;
}

/** What the queued messages wait for, above them. */
export function queuedLine(queued: readonly QueuedMessage[], running: Running | null): Line {
  const lead = queued.length > 1 ? `${queued.length} queued · Claude reads them` : "Queued · Claude reads it";
  return running ? { text: `${lead} after`, command: running.summary } : { text: `${lead} at its next step` };
}

export function sendNowLabel(queued: readonly QueuedMessage[]): string {
  return queued.length > 1 ? `Send ${queued.length} now` : "Send now";
}

/** Hovering Send now while a command runs: it will be stopped. */
export function sendNowWarning(running: Running | null, now: number): Line | null {
  return running && { text: "Send now stops", command: running.summary, tail: `(running ${clock(now - running.since)})` };
}

/** After Send now, until Claude reads the message. */
export function stoppingLine(running: Running | null): Line {
  return running ? { text: "Stopping", command: running.summary, tail: "…" } : { text: "Sending…" };
}

/** The divider for an `Interrupted` that stopped a tool call: which, and how far in. */
export function interruptedLine(items: readonly ChatItem[], index: number): Line | null {
  const it = items[index];
  if (it?.kind !== "system" || it.text !== "Interrupted") return null;
  const before = items.slice(0, index).reverse().find((i) => i.kind !== "thinking");
  if (!before?.tool) return null;
  return { text: "Interrupted by you ·", command: before.tool.summary, tail: `stopped at ${clock(it.ts - before.ts)}` };
}

/** Under an aside's answer: `3s · $0.0015`. */
export function asideFooter(a: AsideAnswer): string {
  return `${Math.max(1, Math.round(a.duration_ms / 1000))}s · $${a.cost_usd.toFixed(4)}`;
}

/**
 * The chat input's placeholder. Claude queues a message sent during a turn; Codex steers the turn with it.
 * A narrow chat leaves the hints out of the idle one (X51).
 */
export function composerPlaceholder(agent: string, working: boolean, hints = true): string {
  if (!working) return hints ? "Ask for a change, @ to mention a file, / for commands" : "Ask for a change…";
  return agent === "claude" ? "Queue a message for Claude" : "Queue a message…";
}

/** After Working in the footer; null with nothing queued. */
export function queuedCount(queued: readonly QueuedMessage[]): string | null {
  return queued.length ? `· ${queued.length} queued` : null;
}

/** The line above the queued messages, its tone, and whether the running command's row is ringed. */
export function queuedHeader(queued: readonly QueuedMessage[], running: Running | null, warn: Line | null): { line: Line; tone: "waiting" | "warn" | "sending"; ring: boolean } {
  if (queued.some((q) => q.sending)) return { line: stoppingLine(running), tone: "sending", ring: !!running };
  if (warn) return { line: warn, tone: "warn", ring: true };
  return { line: queuedLine(queued, running), tone: "waiting", ring: false };
}

/** `chat.send_now`'s params: the one queued message, or every one. */
export function sendNowParams(queued: readonly QueuedMessage[]): { message?: string } {
  return queued.length === 1 ? { message: queued[0].id } : {};
}

/**
 * What became of a message Ask aside asked Claude to give back: still
 * `waiting` in the queue, `cancelled` out of it, or `taken` by Claude
 * first (its uuid is then a transcript item's id).
 */
export function unqueued(st: Pick<ChatState, "queued" | "items">, id: string): "waiting" | "cancelled" | "taken" {
  if (st.queued.some((q) => q.id === id)) return "waiting";
  return st.items.some((i) => i.id === id) ? "taken" : "cancelled";
}

/** A side question and its answer: not added to the session, gone when closed. */
export interface Aside {
  question: string;
  answer?: AsideAnswer;
  error?: string;
}

/** The open aside once `question`'s reply arrives; a reply to a closed or replaced question changes nothing. */
export function asideSettled(cur: Aside | null, question: string, reply: Pick<Aside, "answer" | "error">): Aside | null {
  return cur?.question === question ? { ...cur, ...reply } : cur;
}

/** Sends a message of the user's to the agent. */
export type UserSend = (text: string, images: ChatImage[]) => Promise<unknown>;

/** How the user's messages reach the agent, a message typed and an aside's
 *  question requeued alike: through the screen's own send when it has one,
 *  as a design's chat puts its edits by hand first (X65), else `chatSend`. */
export function userSend(sendText: UserSend | undefined, chatSend: UserSend): UserSend {
  return sendText ?? chatSend;
}

/** Requeue on an aside's card: its question goes to Claude as the user's
 *  own message, by `send` ({@link userSend}); nothing once it is closed. */
export function requeue(aside: Aside | null, send: UserSend): Promise<unknown> {
  return aside ? send(aside.question, []) : Promise.resolve();
}

/** ⌥↵ asks aside while Claude works, unless the input answers a plan. */
export function canAskAside(agent: string, working: boolean, revising: boolean): boolean {
  return agent === "claude" && working && !revising;
}
