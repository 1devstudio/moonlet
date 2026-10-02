const AGENT_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex", cursor: "Cursor", opencode: "OpenCode" };

/** Display name of an agent ("Claude"), or a neutral fallback. */
export const agentLabel = (agent?: string | null) => (agent ? (AGENT_LABEL[agent] ?? agent) : "the agent");
