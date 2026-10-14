const AGENT_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex", cursor: "Cursor", opencode: "OpenCode" };

/** Display name of an agent ("Claude"), or a neutral fallback. */
export const agentLabel = (agent?: string | null) => (agent ? (AGENT_LABEL[agent] ?? agent) : "the agent");

export const CLAUDE_MODELS = [
  { id: "fable", label: "Fable 5.1" },
  { id: "opus", label: "Opus 5.5" },
  { id: "sonnet", label: "Sonnet 5.5" },
  { id: "haiku", label: "Haiku 4.5" },
];

export const EFFORTS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Max" },
];

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
