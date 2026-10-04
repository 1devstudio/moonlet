import { AgentIcon } from "@jaunt/ds";

export const Agents = () => (
  <div className="flex flex-col gap-2 bg-panel p-4 text-[13px] text-fg">
    <span className="flex items-center gap-2"><AgentIcon agent="claude" /> Claude Code</span>
    <span className="flex items-center gap-2"><AgentIcon agent="codex" /> Codex</span>
    <span className="flex items-center gap-2"><AgentIcon agent="opencode" /> Custom agent</span>
    <span className="flex items-center gap-2"><AgentIcon agent={null} /> Terminal only</span>
  </div>
);

export const Sizes = () => (
  <div className="flex items-center gap-4 bg-panel p-4">
    <AgentIcon agent="claude" size={14} />
    <AgentIcon agent="claude" size={20} />
    <AgentIcon agent="claude" size={28} />
  </div>
);
