// What the Inbox cards and the docked asks say (X40).

import { readPrompt } from "@desktop/lib/terminalRead";
import type { ReadRequest } from "@desktop/lib/protocol";

/** `now`, `2m`, `3h`, `2d`: how long an ask has waited. */
export function ageText(since: number | null, now: number): string {
  if (since === null) return "";
  const m = Math.floor((now - since) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / (24 * 60))}d`;
}

/** `Allow Bash?`; an MCP tool reads `Allow linear · create_issue?`. */
export function askHeadline(tool: string): string {
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(tool);
  return `Allow ${mcp ? `${mcp[1]} · ${mcp[2]}` : tool}?`;
}

/** The plan's first sentence after its heading, without Markdown, at most 140 characters. */
export function planBlurb(plan: string): string {
  const body = plan
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.replace(/^([-*+]|\d+\.)\s+/, ""))
    .join(" ")
    .replace(/[*_`]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  const first = /^.*?[.!?](?=\s|$)/.exec(body)?.[0] ?? body;
  return first.length > 140 ? `${first.slice(0, 139).trimEnd()}…` : first;
}

/** X31's question for a terminal read. */
export const readMessage = (req: ReadRequest, sessionName: string) => readPrompt(req, sessionName).message;

/** Answers that let an agent act wait for Face ID when the setting is on. */
export function needsFaceId(answer: "allow" | "always" | "approve" | "deny" | "feedback", faceId: boolean): boolean {
  return faceId && (answer === "allow" || answer === "always" || answer === "approve");
}
