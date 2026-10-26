// A session's designs (X65): what its Design tab, its row in Sessions mode,
// its chat and its chat's slash menu show of them. Pure: the state is
// designStore.ts, the tab components/design/SessionDesign.tsx.

import { pagePath } from "./designPage";
import { toolCommand } from "./chat";
import type { Design, ToolCall } from "./protocol";

/** The file above a session design's page: its path in the worktree, such
 *  as `docs/design/settings-page/pages/index.html`. */
export function worktreeFile(worktree: string, design: Design, page: string): string {
  const root = `${worktree.replace(/\/+$/, "")}/`;
  const folder = design.path.startsWith(root) ? design.path.slice(root.length) : design.path;
  return `${folder}/${pagePath(page)}`;
}

/** The note "Design view opened. The design system is copied into the
 *  session for Claude to read" follows a tool call of the session's agent
 *  when it is its `design new --here` that ran: the call that made the
 *  session design and opened its Design tab. */
export function opensDesignView(tool: ToolCall): boolean {
  const command = toolCommand(tool);
  return tool.status === "ok" && command !== null && /\bdesign\s+new\b[^\n]*\s--here\b/.test(command);
}
