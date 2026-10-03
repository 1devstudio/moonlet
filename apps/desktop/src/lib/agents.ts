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

/** The mode Shift+Tab switches to; bypass joins the cycle once the user enabled it. */
export function nextMode(current: string | null | undefined, bypassEnabled: boolean): string {
  const cycle = ["manual", "acceptEdits", "plan", "auto", ...(bypassEnabled ? [BYPASS_MODE.id] : [])];
  const i = cycle.indexOf(current ?? DEFAULT_MODE);
  return cycle[(i + 1) % cycle.length];
}

/** Agents jaunt can run with the structured view (X6). */
export const isStructured = (agent?: string | null) => agent === "claude" || agent === "codex";
