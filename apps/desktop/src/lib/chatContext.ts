// Context a new agent chat can start from (X38): the session's other chats
// and the plans their agents wrote, written to git-ignored files in the
// worktree and mentioned in the chat input.

import { planOf, transcript } from "./chat";
import type { ChatItem, ChatState, TerminalInfo } from "./protocol";

/** Another chat of the session, offered as a transcript. */
export interface ContextChat {
  id: number;
  title: string;
  agent?: string;
  items: ChatItem[];
}

const firstLine = (text: string) => text.trim().split("\n")[0].trim();

/** The session's other structured chats, whose conversations the chips read. */
export const otherChats = (terminals: TerminalInfo[], session: string, self: number) => terminals.filter((t) => t.chat && t.session_id === session && t.id !== self);

/** The session's other structured chats that have a user message, newest tab first. */
export function contextChats(terminals: TerminalInfo[], chats: Record<number, ChatState | undefined>, where: { session: string; self: number }): ContextChat[] {
  return otherChats(terminals, where.session, where.self)
    .sort((a, b) => b.created_at - a.created_at)
    .flatMap((t) => {
      const items = chats[t.id]?.items ?? [];
      const first = items.find((i) => i.kind === "user" && i.text.trim());
      return first ? [{ id: t.id, title: firstLine(first.text), agent: t.agent, items }] : [];
    });
}

/** A plan an agent of the session proposed with `ExitPlanMode`. */
export interface ContextPlan {
  /** The plan file, or the text when there is none. */
  key: string;
  title: string;
  plan: string;
}

/** The session's plans, newest first, the latest version of each plan file. */
export function contextPlans(terminals: TerminalInfo[], chats: Record<number, ChatState | undefined>, session: string): ContextPlan[] {
  const found = terminals
    .filter((t) => t.chat && t.session_id === session)
    .flatMap((t) => chats[t.id]?.items ?? [])
    .flatMap((i) => {
      const p = i.tool && planOf({ tool: i.tool.name, input: i.tool.input });
      return p ? [{ ts: i.ts, key: p.file ?? p.plan, title: planTitle(p.plan), plan: p.plan }] : [];
    })
    .sort((a, b) => b.ts - a.ts);
  const seen = new Set<string>();
  return found.filter((p) => !seen.has(p.key) && seen.add(p.key)).map(({ key, title, plan }) => ({ key, title, plan }));
}

/** A plan's first heading, else its first line. */
function planTitle(plan: string): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(plan);
  return heading ? heading[1].trim() : firstLine(plan);
}

/** What an empty chat offers: nothing while it has no folder to write to. */
export function newChatContext(
  terminals: TerminalInfo[],
  chats: Record<number, ChatState | undefined>,
  chat: { session: string; self: number; cwd: string },
): { transcripts: ContextChat[]; plans: ContextPlan[] } {
  if (!chat.cwd) return { transcripts: [], plans: [] };
  return { transcripts: contextChats(terminals, chats, chat), plans: contextPlans(terminals, chats, chat.session) };
}

/** A section's chips: four, then "+N more" until all are asked for; null
 * hides a section with nothing in it. */
export function chipSection<T>(rows: T[], all: boolean): { shown: T[]; more: number } | null {
  if (!rows.length) return null;
  const shown = all ? rows : rows.slice(0, 4);
  return { shown, more: rows.length - shown.length };
}

/** What clicking a chip writes, and the mention it adds to the input. */
export interface ContextFiles {
  /** Relative to the worktree, without the `@`. */
  mention: string;
  /** `fs.write` parameters: each stays inside `root`, never through a symlink. */
  writes: { root: string; path: string; content: string }[];
}

const DIR = ".moonlet/context";

/** Letters and digits only, so a title can't leave the context folder. */
function slug(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 48).replace(/-+$/, "");
  return s || "untitled";
}

/** A short FNV-1a hash, so plans with the same title get their own file. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(text)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

function contextFiles(root: string, name: string, content: string): ContextFiles {
  const base = root.replace(/\/+$/, "");
  const dir = `${base}/${DIR}`;
  return {
    mention: `${DIR}/${name}`,
    writes: [
      // Ignores itself and everything beside it: never in Changes, never committed.
      { root: base, path: `${dir}/.gitignore`, content: "*\n" },
      { root: base, path: `${dir}/${name}`, content },
    ],
  };
}

export function chatContextFiles(root: string, chat: ContextChat): ContextFiles {
  return contextFiles(root, `chat-${slug(chat.title)}-${chat.id}.md`, `# Chat transcript: ${chat.title}\n\n${transcript(chat.items)}\n`);
}

export function planContextFiles(root: string, plan: ContextPlan): ContextFiles {
  return contextFiles(root, `plan-${slug(plan.title)}-${hash(plan.key)}.md`, plan.plan);
}
