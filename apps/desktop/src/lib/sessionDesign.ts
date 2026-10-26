// A session's designs (X65): what its Design tab, its row in Sessions mode,
// its chat and its chat's slash menu show of them. Pure: the state is
// designStore.ts, the tab components/design/SessionDesign.tsx.

import { pagePath } from "./designPage";
import { commandOptions, fuzzyScore, toolCommand } from "./chat";
import type { Design, DesignSystem, ToolCall } from "./protocol";

/** The file above a session design's page: its path in the worktree, such
 *  as `docs/design/settings-page/pages/index.html`. */
export function worktreeFile(worktree: string, design: Design, page: string): string {
  const root = `${worktree.replace(/\/+$/, "")}/`;
  const folder = design.path.startsWith(root) ? design.path.slice(root.length) : design.path;
  return `${folder}/${pagePath(page)}`;
}

/** The pen icon on a session's row in Sessions mode, titled with its
 *  designs, while it has one; null without. */
export function designMark(designs: Design[]): string | null {
  if (!designs.length) return null;
  return `${designs.length === 1 ? "Design" : "Designs"}: ${designs.map((d) => d.name).join(", ")}`;
}

/** The note "Design view opened. The design system is copied into the
 *  session for Claude to read" follows a tool call of the session's agent
 *  when it is its `design new --here` that ran: the call that made the
 *  session design and opened its Design tab. */
export function opensDesignView(tool: ToolCall): boolean {
  const command = toolCommand(tool);
  return tool.status === "ok" && command !== null && /\bdesign\s+new\b[^\n]*\s--here\b/.test(command);
}

/** A row of the chat input's slash menu: the command, and what it does. */
export interface SlashRow {
  value: string;
  hint: string | null;
}

/** `/moonlet-design`'s three forms, as the skill takes them (X65). */
const DESIGN_FORMS: SlashRow[] = [
  { value: "/moonlet-design", hint: "Prototype it here, in this session's Design view" },
  { value: "/moonlet-design new", hint: "A separate design in Design mode, with its own agent" },
  { value: "/moonlet-design sync", hint: "Sync the design system built from this project" },
];

/** The chat input's slash menu for a `/token` (X65): the agent's commands
 *  (`commandOptions`); in a session's chat (`footer`, the design system
 *  /moonlet-design will use) `/moonlet-design` is its three forms, each
 *  with what it does, first while the token at the start of the message
 *  matches it, with the footer. */
export function slashMenu(commands: readonly string[], text: string, token: { start: number; query: string }, footer: string | null): { rows: SlashRow[]; footer: string | null } {
  if (footer === null) return { rows: commandOptions(commands, text, token).map((value) => ({ value, hint: null })), footer: null };
  const others = commandOptions(commands.filter((c) => c !== "moonlet-design"), text, token).map((value) => ({ value, hint: null }));
  const atStart = text.slice(0, token.start).trim() === "";
  const design = atStart && fuzzyScore("moonlet-design", token.query) !== null;
  return design ? { rows: [...DESIGN_FORMS, ...others], footer } : { rows: others, footer: null };
}

/** The slash menu's footer in a session: the design system `/moonlet-design`
 *  will use, as `design new --here` picks it (`pick_system` in
 *  moonlet-cli's design.rs): the workspace's one built from the session's
 *  project (`project`, its path), which to pick when several are, or how
 *  to make one. */
export function designSystemFooter(systems: DesignSystem[], project: string): string {
  const built = systems.filter((s) => s.sources.includes(project)).map((s) => s.name);
  if (built.length === 1) return `Uses ${built[0]}, the design system built from this project`;
  if (built.length > 1) return `Asks which design system to use: ${built.slice(0, -1).join(", ")} or ${built.at(-1)}, ${built.length === 2 ? "both" : "all"} built from this project`;
  return "No design system is built from this project yet: /moonlet-design sync builds one";
}
