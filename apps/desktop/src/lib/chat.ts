// Structured agent conversations (X6): a mirror of each chat terminal's
// ChatState, loaded with `chat.state` and kept current by `chat.*` events.

import { create } from "zustand";
import type { PlanApproveMode } from "./agents";
import { rpc } from "./daemon";
import { type ChatItem, type ChatState, type ContextUsage, M, type ToolCall, type TurnTime } from "./protocol";
import { readStored, writeStored } from "./storage";

export const chatKey = (host: string, id: number) => `${host}:${id}`;

interface ChatStore {
  chats: Record<string, ChatState>;
}

const g = globalThis as unknown as { __moonletChat?: ReturnType<typeof makeStore> };
function makeStore() {
  return create<ChatStore>(() => ({ chats: {} }));
}
/** One store across hot reloads (see store.ts). */
export const useChat = (g.__moonletChat ??= makeStore());

const empty: ChatState = { items: [], pending: [], status: "idle", cost_usd: 0, input_tokens: 0, output_tokens: 0, slash_commands: [], queued: [] };

/** Inserts or replaces an item by id, keeping order. */
/** The composer's text after text sent from elsewhere arrives, such as a
 * command block from a shell (T8): it follows what is typed, after a blank
 * line, or after a space for a file mention (X25). */
export function joinDraft(current: string, sent: string): string {
  if (!current.trim()) return sent;
  return `${current.trimEnd()}${isMention(sent) ? " " : "\n\n"}${sent}`;
}

function isMention(text: string): boolean {
  return /^@\S+$/.test(text);
}

/** How the Files tab's "Add to chat" mentions a file of the workspace (X25). */
export function fileMention(root: string, path: string): string {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return `@${path.startsWith(prefix) ? path.slice(prefix.length) : path}`;
}

export function mergeItem(items: ChatItem[], item: ChatItem): ChatItem[] {
  const i = items.findIndex((x) => x.id === item.id);
  if (i < 0) return [...items, item];
  const next = items.slice();
  next[i] = item;
  return next;
}

/** Events that arrive while `chat.state` is in flight, applied after it. */
const buffered = new Map<string, { items: ChatItem[]; state?: ChatState }>();

export function onChatItem(host: string, id: number, item: ChatItem) {
  const key = chatKey(host, id);
  const buf = buffered.get(key);
  if (buf) {
    buf.items.push(item);
    return;
  }
  useChat.setState((s) => {
    const cur = s.chats[key];
    // Not loaded and not loading: the next load includes it.
    if (!cur) return s;
    return { chats: { ...s.chats, [key]: { ...cur, items: mergeItem(cur.items, item) } } };
  });
}

export function onChatState(host: string, id: number, state: ChatState) {
  const key = chatKey(host, id);
  const buf = buffered.get(key);
  if (buf) {
    buf.state = state;
    return;
  }
  useChat.setState((s) => {
    const cur = s.chats[key];
    if (!cur) return s;
    // The event carries everything but the items.
    return { chats: { ...s.chats, [key]: { ...state, items: cur.items } } };
  });
}

const loading = new Set<string>();

export async function loadChat(host: string, id: number) {
  const key = chatKey(host, id);
  if (loading.has(key)) return;
  loading.add(key);
  // Events can overtake the reply: hold them and replay them on top of it.
  buffered.set(key, { items: [] });
  try {
    const st = await rpc<ChatState>(host, M.chatState, { id });
    const buf = buffered.get(key);
    let items = st.items;
    for (const it of buf?.items ?? []) items = mergeItem(items, it);
    const latest = buf?.state ? { ...buf.state, items } : { ...st, items };
    useChat.setState((s) => ({ chats: { ...s.chats, [key]: { ...empty, ...latest } } }));
  } catch (e) {
    // A reload of a chat already shown failed: keep the events it held.
    const buf = buffered.get(key);
    buffered.delete(key);
    for (const it of buf?.items ?? []) onChatItem(host, id, it);
    if (buf?.state) onChatState(host, id, buf.state);
    throw e;
  } finally {
    buffered.delete(key);
    loading.delete(key);
  }
}

export function forgetChat(host: string, id: number) {
  useChat.setState((s) => {
    const chats = { ...s.chats };
    delete chats[chatKey(host, id)];
    return { chats };
  });
  saveChatDraft(host, id, "");
}

// ------------------------------------------------------------ unsent text

// What is typed but not sent, per chat terminal. The editor unmounts when
// another session opens, so the text lives here until it is sent.
const drafts = new Map<string, string>();

export const chatDraft = (host: string, id: number) => drafts.get(chatKey(host, id)) ?? "";

export function saveChatDraft(host: string, id: number, text: string) {
  if (text) drafts.set(chatKey(host, id), text);
  else drafts.delete(chatKey(host, id));
}

// ------------------------------------------------------------ prompt history

const HISTORY_KEY = "prompts";
const MAX_PROMPTS = 300;

export function promptHistory(): string[] {
  try {
    const v = JSON.parse(readStored(HISTORY_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function rememberPrompt(text: string) {
  const t = text.trim();
  if (!t) return;
  const h = promptHistory().filter((x) => x !== t);
  h.push(t);
  try {
    writeStored(HISTORY_KEY, JSON.stringify(h.slice(-MAX_PROMPTS)));
  } catch {
    /* storage unavailable */
  }
}

// ------------------------------------------------------------ display helpers

/** `+a −d` from a unified diff. */
/** Whether the agent is in a turn: working, or waiting on a permission. */
export function turnRunning(status: ChatState["status"] | undefined): boolean {
  return status === "working" || status === "blocked";
}

export function diffStat(diff: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++") || l.startsWith("---")) continue;
    if (l.startsWith("+")) add++;
    else if (l.startsWith("-")) del++;
  }
  return { add, del };
}

/** The `@token` or `/token` being typed at the caret, if any. */
export function activeToken(text: string, caret: number): { kind: "@" | "/"; start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)([@/])([^\s@]*)$/.exec(before);
  if (!m) return null;
  const kind = m[2] as "@" | "/";
  const start = caret - m[3].length - 1;
  // Slash commands only at the very start of the message.
  if (kind === "/" && before.slice(0, start).trim() !== "") return null;
  return { kind, start, query: m[3] };
}

/** Subsequence match score: lower is better, null when no match. */
export function fuzzyScore(candidate: string, query: string): number | null {
  if (!query) return 0;
  const c = candidate.toLowerCase();
  const q = query.toLowerCase();
  let pos = -1;
  let score = 0;
  for (const ch of q) {
    const next = c.indexOf(ch, pos + 1);
    if (next < 0) return null;
    score += next - pos - 1;
    pos = next;
  }
  // Prefer matches in the file name over the directory.
  const base = c.lastIndexOf("/") + 1;
  return score + (c.indexOf(q[0], base) >= base ? 0 : 20) + c.length / 100;
}

export function fuzzyFilter(items: readonly string[], query: string, limit = 8): string[] {
  return items
    .map((x) => [x, fuzzyScore(x, query)] as const)
    .filter((x): x is readonly [string, number] => x[1] !== null)
    .sort((a, b) => a[1] - b[1])
    .slice(0, limit)
    .map((x) => x[0]);
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

/** A token count in the footer's short form (X34): `297`, `8.1k`, `124k`, `130.7M`. */
export function tokens(n: number): string {
  const short = (v: number, digits: number) => v.toFixed(digits).replace(/\.0$/, "");
  if (n >= 1_000_000) return `${short(n / 1_000_000, 1)}M`;
  if (n >= 1000) return `${short(n / 1000, n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

/** The footer's spend (X34): `$0.42 · 120k in · 3k out`; null before any. */
export function costLine(st: Pick<ChatState, "cost_usd" | "input_tokens" | "output_tokens">): string | null {
  if (st.cost_usd <= 0 && st.input_tokens <= 0) return null;
  const cost = st.cost_usd > 0 ? `$${st.cost_usd.toFixed(st.cost_usd < 1 ? 3 : 2)} · ` : "";
  return `${cost}${tokens(st.input_tokens)} in · ${tokens(st.output_tokens)} out`;
}

/** Fixed colours for Claude's own categories; the rest take OTHER in turn. */
const CONTEXT_COLORS: Record<string, string> = {
  "System prompt": "#8c8c8c",
  "System tools": "#8c8c8c",
  "MCP tools": "#b48ead",
  "Memory files": "#f2c94c",
  Messages: "#d97757",
};
const OTHER_COLORS = ["#6ea8fe", "#3ecf6e", "#56c2d6", "#e58fb5"];

export interface ContextView {
  /** Used share of the window, a whole percent. */
  percent: number;
  /** `124k / 200k` */
  label: string;
  /** One per category; `width` is its share of the window in percent. */
  rows: { name: string; tokens: string; color: string; width: number }[];
  free: string;
  autoCompact: string;
}

/** What the context ring and its card show (X34). */
export function contextView(c: ContextUsage): ContextView {
  let other = 0;
  return {
    percent: c.max > 0 ? Math.round((c.used / c.max) * 100) : 0,
    label: `${tokens(c.used)} / ${tokens(c.max)}`,
    rows: c.categories.map((cat) => ({
      name: cat.name,
      tokens: tokens(cat.tokens),
      color: CONTEXT_COLORS[cat.name] ?? OTHER_COLORS[other++ % OTHER_COLORS.length],
      width: c.max > 0 ? (cat.tokens / c.max) * 100 : 0,
    })),
    free: tokens(Math.max(0, c.max - c.used)),
    autoCompact: c.auto_compact_at && c.max > 0 ? `Auto-compacts at ${Math.round((c.auto_compact_at / c.max) * 100)}%` : "Auto-compact is off",
  };
}

const DAY = 86_400_000;

/**
 * The footer under a turn's final message (X16): `14s · 4:00 PM`. The end
 * time gains the weekday after today, and the date after the last 6 days.
 */
export function turnFooter(turn: TurnTime, now: number, locale?: string): string {
  const end = new Date(turn.ended_at);
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(new Date(now)) - midnight(end)) / DAY);
  const time = { hour: "numeric", minute: "2-digit" } as const;
  const opts: Intl.DateTimeFormatOptions =
    days === 0
      ? time
      : days > 0 && days < 7
        ? { weekday: "short", ...time }
        : { year: end.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric", month: "short", day: "numeric", ...time };
  // Newer ICU puts a narrow no-break space before AM/PM.
  return `${elapsed(turn.ended_at - turn.started_at)} · ${end.toLocaleString(locale, opts).replace(/\u202f/g, " ")}`;
}

/** Plain-text transcript for "Copy transcript". */
export function transcript(items: readonly ChatItem[]): string {
  return items
    .map((it) => {
      switch (it.kind) {
        case "user":
          return `> ${it.text.replace(/\n/g, "\n> ")}`;
        case "tool":
          return `[${it.tool?.name ?? "tool"}] ${it.tool?.summary ?? ""}${it.tool?.status === "denied" ? " (denied)" : ""}`;
        case "thinking":
          return "";
        default:
          return it.text;
      }
    })
    .filter(Boolean)
    .join("\n\n");
}

/** How tool calls show in the conversation (X14). */
export type ToolCallView = "collapsed" | "expanded";

/** One row of the conversation: an item, or a run of tool calls folded into one. */
export type ChatBlock = { kind: "item"; item: ChatItem } | { kind: "tools"; id: string; tools: ChatItem[] } | { kind: "agents"; id: string; tools: ChatItem[] };

/** Claude's tool that launches a subagent (X42). */
export const isAgentCall = (it: ChatItem) => it.kind === "tool" && (it.tool?.name === "Agent" || it.tool?.name === "Task");

/** Items that render nothing: no text yet, thinking that was redacted, or a tool item without its call. */
export const invisible = (it: ChatItem) => (it.kind === "assistant" && !it.text) || (it.kind === "thinking" && !it.partial && !it.text.trim()) || (it.kind === "tool" && !it.tool);

/**
 * The conversation's rows. Collapsed, each run of tool calls becomes one
 * group; text and thinking are never folded, so they end a run. Items that
 * render nothing are dropped and do not split a run. Runs of Agent calls
 * are always a block of their own (X42).
 */
export function chatBlocks(items: readonly ChatItem[], view: ToolCallView): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  for (const it of items) {
    if (invisible(it)) continue;
    // Subagent launches get their own card in either view (X42).
    if (isAgentCall(it)) {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "agents") last.tools.push(it);
      else blocks.push({ kind: "agents", id: it.id, tools: [it] });
      continue;
    }
    if (view === "collapsed" && it.kind === "tool") {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "tools") last.tools.push(it);
      // Keyed by its first call, so the group keeps its open state as calls stream in.
      else blocks.push({ kind: "tools", id: it.id, tools: [it] });
      continue;
    }
    blocks.push({ kind: "item", item: it });
  }
  return blocks;
}

export const toolGroupLabel = (n: number) => `${n} tool call${n === 1 ? "" : "s"}`;

/** A group's status mark: running while any call runs, then the worst outcome. */
export function toolGroupStatus(tools: readonly ChatItem[]): ToolCall["status"] {
  const st = tools.map((t) => t.tool?.status);
  return st.includes("running") ? "running" : st.includes("error") ? "error" : st.includes("denied") ? "denied" : "ok";
}

/** Thinking squeezed onto one line for its collapsed row. */
export const thinkingPreview = (text: string) => text.replace(/\s+/g, " ").trim();

/** The whole command of a shell call, for its opened row: the row itself shows
 *  only the summary's first line. Null for other tools. */
export function toolCommand(tool: ToolCall): string | null {
  if (!["bash", "shell", "command"].includes(tool.name.toLowerCase())) return null;
  const input = tool.input as { command?: unknown; cmd?: unknown } | null;
  const cmd = typeof input?.command === "string" ? input.command : typeof input?.cmd === "string" ? input.cmd : null;
  return cmd?.trimEnd() || null;
}

/** One question from Claude's `AskUserQuestion` tool input. */
export interface Question {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

/** The questions in an `AskUserQuestion` input; malformed entries are dropped. */
export function askQuestions(input: unknown): Question[] {
  const qs = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(qs)) return [];
  return qs
    .filter((q) => q && typeof q.question === "string")
    .map((q) => ({
      question: q.question,
      header: typeof q.header === "string" ? q.header : "",
      options: (Array.isArray(q.options) ? q.options : [])
        .filter((o: { label?: unknown }) => o && typeof o.label === "string")
        .map((o: { label: string; description?: unknown }) => ({ label: o.label, description: typeof o.description === "string" ? o.description : "" })),
      multiSelect: q.multiSelect === true,
    }));
}

/** What the user picked for one question: option labels and "Other" text. */
export interface QuestionPick {
  labels: string[];
  other: string;
}

/**
 * Answers keyed by question text, as `AskUserQuestion` expects them, or null
 * while a question is unanswered. Typed text replaces a single choice and is
 * added to multiple ones; multi-select answers are joined with ", ".
 */
export function questionAnswers(qs: readonly Question[], picks: readonly QuestionPick[]): Record<string, string> | null {
  const answers: Record<string, string> = {};
  for (const [i, q] of qs.entries()) {
    const p = picks[i] ?? { labels: [], other: "" };
    const other = p.other.trim();
    const answer = q.multiSelect ? [...p.labels, other].filter(Boolean).join(", ") : other || p.labels[0] || "";
    if (!answer) return null;
    answers[q.question] = answer;
  }
  return answers;
}

/** The plan in Claude's `ExitPlanMode` ask, or null when it has none (X20). */
export function planOf(ask: { tool: string; input: unknown }): { plan: string; file: string | null } | null {
  if (ask.tool !== "ExitPlanMode") return null;
  const input = ask.input as { plan?: unknown; planFilePath?: unknown } | null;
  if (typeof input?.plan !== "string" || !input.plan.trim()) return null;
  return { plan: input.plan, file: typeof input.planFilePath === "string" ? input.planFilePath : null };
}

/** What the user does with a plan: approve into the Settings mode (X24) or Manual, or send feedback. */
export type PlanChoice = "approve" | "ask" | "keepPlanning";

/** `chat.permission` parameters for a plan choice; null for empty feedback. */
export function planAnswer(choice: PlanChoice, feedback = "", approveMode: PlanApproveMode = "auto"): { decision: "allow" | "deny"; mode?: PlanApproveMode; message?: string } | null {
  if (choice === "approve") return { decision: "allow", mode: approveMode };
  if (choice === "ask") return { decision: "allow" };
  const message = feedback.trim();
  return message ? { decision: "deny", message } : null;
}

/** The approve button, named after the mode it switches to (X24). */
export const planApproveLabel = (mode: PlanApproveMode) => (mode === "auto" ? "Approve, auto mode" : "Approve, accept edits");
