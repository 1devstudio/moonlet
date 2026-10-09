// The chat input's `+` menu (X29): what it offers, how its choices edit
// the input, and how it shows the agent's MCP servers.

import type { AgentState, McpServer } from "./protocol";

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

export type PlusEntry = "attach" | "add-dir" | "commands" | "mcp" | "agents";

/** The menu's items in sections (a divider between them). The new-session
 *  composer has no running agent, so it offers the file items only. */
export function plusEntries({ variant, agents }: { variant: "chat" | "composer"; agents: number }): PlusEntry[][] {
  const files: PlusEntry[] = ["attach", "add-dir"];
  if (variant === "composer") return [files];
  const agent: PlusEntry[] = agents > 0 ? ["commands", "mcp", "agents"] : ["commands", "mcp"];
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

/** The MCP submenu's header and the badge count of servers to sign in to. */
export function mcpSummary(servers: McpServer[]): { header: string; needsAuth: number } {
  const connected = servers.filter((s) => s.status === "connected").length;
  const needsAuth = servers.filter((s) => s.status === "needs-auth" || s.status === "authing").length;
  return { header: `MCP servers · ${connected}/${servers.length}`, needsAuth };
}

const STATUS: Record<string, { label: string; glyph: AgentState }> = {
  connected: { label: "Connected", glyph: "done" },
  "needs-auth": { label: "Needs authentication", glyph: "blocked" },
  authing: { label: "Signing in…", glyph: "working" },
  failed: { label: "Failed to connect", glyph: "error" },
  pending: { label: "Starting…", glyph: "idle" },
  disabled: { label: "Disabled", glyph: "idle" },
};

const MAX_TOOL_CHIPS = 6;

/** What the detail card shows for a server. Tools only once it is connected. */
export function mcpCard(s: McpServer): { label: string; glyph: AgentState; tools: { summary: string; chips: string[] } | null } {
  const { label, glyph } = STATUS[s.status] ?? STATUS.pending;
  if (s.status !== "connected") return { label, glyph, tools: null };
  const n = s.tools.length;
  const chips = s.tools.slice(0, MAX_TOOL_CHIPS);
  if (n > MAX_TOOL_CHIPS) chips.push(`+${n - MAX_TOOL_CHIPS} more`);
  return { label, glyph, tools: { summary: `${n} tool${n === 1 ? "" : "s"}`, chips } };
}

/** Why the MCP submenu has no servers to show, from the `chat.mcp` error. */
export function mcpErrorText(message: string): string {
  // A daemon from before X29 runs on until it is restarted or upgraded.
  if (/unknown method/i.test(message)) return "The moonlet daemon is older than this app. Restart it to see MCP servers.";
  return `The agent could not start: ${message}`;
}
