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

/** The session's other structured chats that have a user message, newest tab first. */
export function contextChats(terminals: TerminalInfo[], chats: Record<number, ChatState | undefined>, where: { session: string; self: number }): ContextChat[] {
  return terminals
    .filter((t) => t.chat && t.session_id === where.session && t.id !== where.self)
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

/** What clicking a chip writes, and the mention it adds to the input. */
export interface ContextFiles {
  /** Relative to the worktree, without the `@`. */
  mention: string;
  writes: { path: string; content: string }[];
}

const DIR = ".moonlet/context";

/** Letters and digits only, so a title can't leave the context folder. */
function slug(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 48).replace(/-+$/, "");
  return s || "untitled";
}

function contextFiles(root: string, name: string, content: string): ContextFiles {
  const dir = `${root.replace(/\/+$/, "")}/${DIR}`;
  return {
    mention: `${DIR}/${name}`,
    writes: [
      // Ignores itself and everything beside it: never in Changes, never committed.
      { path: `${dir}/.gitignore`, content: "*\n" },
      { path: `${dir}/${name}`, content },
    ],
  };
}

export function chatContextFiles(root: string, chat: ContextChat): ContextFiles {
  return contextFiles(root, `chat-${slug(chat.title)}.md`, `# Chat transcript: ${chat.title}\n\n${transcript(chat.items)}\n`);
}

export function planContextFiles(root: string, plan: ContextPlan): ContextFiles {
  return contextFiles(root, `plan-${slug(plan.title)}.md`, plan.plan);
}
