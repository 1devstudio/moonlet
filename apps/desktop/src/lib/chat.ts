// Structured agent conversations (X6): a mirror of each chat terminal's
// ChatState, loaded with `chat.state` and kept current by `chat.*` events.

import { create } from "zustand";
import { rpc } from "./daemon";
import { type ChatItem, type ChatState, M, type ToolCall } from "./protocol";

export const chatKey = (host: string, id: number) => `${host}:${id}`;

interface ChatStore {
  chats: Record<string, ChatState>;
}

const g = globalThis as unknown as { __jauntChat?: ReturnType<typeof makeStore> };
function makeStore() {
  return create<ChatStore>(() => ({ chats: {} }));
}
/** One store across hot reloads (see store.ts). */
export const useChat = (g.__jauntChat ??= makeStore());

const empty: ChatState = { items: [], pending: [], status: "idle", cost_usd: 0, input_tokens: 0, output_tokens: 0, slash_commands: [], queued: [] };

/** Inserts or replaces an item by id, keeping order. */
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
}

// ------------------------------------------------------------ prompt history

const HISTORY_KEY = "jaunt.prompts";
const MAX_PROMPTS = 300;

export function promptHistory(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
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
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(-MAX_PROMPTS)));
  } catch {
    /* storage unavailable */
  }
}

// ------------------------------------------------------------ display helpers

/** `+a −d` from a unified diff. */
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

export function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
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
export type ChatBlock = { kind: "item"; item: ChatItem } | { kind: "tools"; id: string; tools: ChatItem[] };

/** Items that render nothing: no text yet, thinking that was redacted, or a tool item without its call. */
const invisible = (it: ChatItem) => (it.kind === "assistant" && !it.text) || (it.kind === "thinking" && !it.partial && !it.text.trim()) || (it.kind === "tool" && !it.tool);

/**
 * The conversation's rows. Collapsed, each run of tool calls becomes one
 * group; text and thinking are never folded, so they end a run. Items that
 * render nothing are dropped and do not split a run.
 */
export function chatBlocks(items: readonly ChatItem[], view: ToolCallView): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  for (const it of items) {
    if (invisible(it)) continue;
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
