// The chat input's `+` menu (X29): what it offers and how its choices edit
// the input.

/** The input after choosing a slash command: the command leads, replacing
 *  one already there, and the caret follows it. */
export function withSlashCommand(text: string, name: string): { text: string; caret: number } {
  const head = `/${name} `;
  // Only the spaces after the old command go; its line breaks stay.
  const rest = text.replace(/^\/\S*[ \t]*/, "");
  return { text: head + rest, caret: head.length };
}

/** The input after inserting `@<mention> ` at the caret, such as a subagent
 *  (`agent-Plan`) or an attached file. */
export function withMention(text: string, caret: number, mention: string): { text: string; caret: number } {
  const before = text.slice(0, caret);
  const gap = before === "" || /\s$/.test(before) ? "" : " ";
  const head = `${before}${gap}@${mention} `;
  return { text: head + text.slice(caret), caret: head.length };
}

export type PlusEntry = "attach" | "commands" | "agents";

/** The menu's items in sections (a divider between them). The new-session
 *  composer has no running agent, so it offers the file items only. */
export function plusEntries({ variant, agents }: { variant: "chat" | "composer"; agents: number }): PlusEntry[][] {
  const files: PlusEntry[] = ["attach"];
  if (variant === "composer") return [files];
  const agent: PlusEntry[] = agents > 0 ? ["commands", "agents"] : ["commands"];
  return [files, agent];
}

/** ⌘U opens the attach dialog. */
export function isAttachShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "u";
}

/** How an attached file is mentioned: relative to the session's directory
 *  when inside it, quoted when it has spaces. */
export function fileMention(path: string, root: string): string {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const rel = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  return /\s/.test(rel) ? `"${rel}"` : rel;
}

/** Mentions of this Mac's files mean nothing to an agent on another host. */
export function canMentionFiles(host: string): boolean {
  return host === "local";
}
