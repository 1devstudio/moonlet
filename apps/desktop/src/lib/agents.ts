import type { ClaudeModel } from "./protocol";

const AGENT_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex", cursor: "Cursor", opencode: "OpenCode" };

/** Display name of an agent ("Claude"), or a neutral fallback. */
export const agentLabel = (agent?: string | null) => (agent ? (AGENT_LABEL[agent] ?? agent) : "the agent");

export interface ModelChoice {
  id: string;
  label: string;
}

/** The Claude model menu (X105): the newest models, and the rest under More models. */
export interface ModelMenu {
  latest: ModelChoice[];
  more: ModelChoice[];
}

/** Claude Code's aliases, for a host that has not said which models it offers (X105). */
const FALLBACK_MODELS: ModelChoice[] = [
  { id: "opus", label: "Opus" },
  { id: "fable", label: "Fable" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

/** An alias such as `fable` stands for the newest of its line; `default` repeats one of them. */
const isAlias = (value: string) => value !== "default" && !value.startsWith("claude-");

/** The model menu from the models Claude Code offers, in its order (X105). */
const choiceOf = (m: ClaudeModel): ModelChoice => ({ id: m.value, label: m.label || m.value });

export function modelMenu(models: ClaudeModel[] | undefined | null): ModelMenu {
  if (!models?.length) return { latest: FALLBACK_MODELS, more: [] };
  return {
    latest: models.filter((m) => isAlias(m.value)).map(choiceOf),
    more: models.filter((m) => !isAlias(m.value) && m.value !== "default").map(choiceOf),
  };
}

export const EFFORTS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Max" },
];

/** A Claude model's name in the menus: Claude Code's label, else the id as it is (X105). */
export function claudeModelLabel(models: ClaudeModel[] | undefined | null, id: string): string {
  const known = models?.length ? models.map(choiceOf) : FALLBACK_MODELS;
  return known.find((m) => m.id === id)?.label ?? id;
}

/** The efforts a Claude model supports, as Claude Code lists them; all five for a model it does not list (X105). */
function claudeEfforts(models: ClaudeModel[] | undefined | null, model: string | null | undefined) {
  const m = models?.find((x) => x.value === model);
  return m ? EFFORTS.filter((e) => m.efforts.includes(e.id)) : EFFORTS;
}

/** The Effort menu for an agent's model: Claude's follow its model (X105), Codex has three. */
export function agentEfforts(agent: string, models: ClaudeModel[] | undefined | null, model: string | null | undefined) {
  return agent === "claude" ? claudeEfforts(models, model) : EFFORTS.filter((e) => ["low", "medium", "high"].includes(e.id));
}

/** The effort once `model` is chosen: kept when it supports it, else High; none for a model without efforts (X105). */
export function effortAfter(models: ClaudeModel[] | undefined | null, model: string, effort: string | null): string | null {
  const offered = claudeEfforts(models, model);
  if (!offered.length) return null;
  if (effort && offered.some((e) => e.id === effort)) return effort;
  return offered.find((e) => e.id === "high")?.id ?? offered[0].id;
}

/** `chat.settings` for picking a running chat's model: its effort changes only when the new model
 * lacks it, and stays for a model without efforts, which Claude Code accepts (X105). */
export function chatModelPatch(models: ClaudeModel[] | undefined | null, model: string, effort: string | null): { model: string; effort?: string } {
  const next = effortAfter(models, model, effort);
  return next && next !== effort ? { model, effort: next } : { model };
}

/** Claude permission modes (X7), in the order the picker lists them and Shift+Tab cycles them. */
export const CLAUDE_MODES = [
  { id: "auto", label: "Auto", description: "Claude handles permission decisions" },
  { id: "manual", label: "Manual", description: "Always ask before making changes" },
  { id: "acceptEdits", label: "Accept edits", description: "Automatically accept all file edits" },
  { id: "plan", label: "Plan", description: "Create a plan before making changes" },
];

export const BYPASS_MODE = { id: "bypassPermissions", label: "Bypass permissions", description: "Skip every permission check" };

/** What a session without a chosen mode runs in: Claude asks before changes. */
export const DEFAULT_MODE = "manual";

/** A stored or received mode if the picker offers it, else the default (a stale or edited setting must not reach `claude`). */
export function resolveMode(value: unknown): string {
  return CLAUDE_MODES.some((m) => m.id === value) ? (value as string) : DEFAULT_MODE;
}

/** Modes an approved plan can switch to (X24), the default first. */
export const PLAN_APPROVE_MODES = [
  { id: "auto", label: "Auto", description: "Claude handles permission decisions" },
  { id: "acceptEdits", label: "Accept edits", description: "Automatically accept all file edits" },
] as const;
export type PlanApproveMode = (typeof PLAN_APPROVE_MODES)[number]["id"];

/** The stored "when a plan is approved" setting, or Auto when missing or unknown. */
export function resolvePlanMode(value: unknown): PlanApproveMode {
  return PLAN_APPROVE_MODES.find((m) => m.id === value)?.id ?? "auto";
}

/** The mode Shift+Tab switches to; bypass joins the cycle once the user enabled it. */
export function nextMode(current: string | null | undefined, bypassEnabled: boolean): string {
  const cycle = ["manual", "acceptEdits", "plan", "auto", ...(bypassEnabled ? [BYPASS_MODE.id] : [])];
  const i = cycle.indexOf(current ?? DEFAULT_MODE);
  return cycle[(i + 1) % cycle.length];
}

/** Agents moonlet can run with the structured view (X6). */
export const isStructured = (agent?: string | null) => agent === "claude" || agent === "codex";

/** The agent a new tab opens (X38): the session's, else Claude. */
export const tabAgent = (agent?: string | null) => (agent && agent !== "none" ? agent : "claude");

/** Whether a new TUI agent can take pasted text (T8): once it has printed
 * its first screen. An agent that exited or was removed never will. */
export function agentReadiness(t?: { created_at: number; last_output_at: number; exit?: unknown }): "waiting" | "ready" | "gone" {
  if (!t || t.exit) return "gone";
  return t.last_output_at > t.created_at ? "ready" : "waiting";
}

/** The TUI a chat opens in a terminal (X7): its agent resuming conversation
 * `id`. Claude starts in the footer's `mode` when it knows it, and with
 * `--chrome` when the host's Claude in Chrome switch is on (X103). */
export function tuiCommand(agent: string | null | undefined, id: string, mode: string | null | undefined, chrome: boolean): string[] {
  if (agent === "codex") return ["codex", "resume", id];
  const known = mode && [...CLAUDE_MODES.map((m) => m.id), BYPASS_MODE.id].includes(mode);
  return ["claude", "--resume", id, ...(known ? ["--permission-mode", mode] : []), ...(chrome ? ["--chrome"] : [])];
}
