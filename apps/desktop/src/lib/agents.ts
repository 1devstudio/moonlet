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

/** Agents jaunt can run with the structured view (X6). */
export const isStructured = (agent?: string | null) => agent === "claude" || agent === "codex";
