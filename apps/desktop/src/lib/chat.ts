// Structured agent conversations (X6): a mirror of each chat terminal's
// ChatState, loaded with `chat.state` and kept current by `chat.*` events.

import { create } from "zustand";
import { rpc } from "./daemon";
import { type ChatItem, type ChatState, M } from "./protocol";

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
