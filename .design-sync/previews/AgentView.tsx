import { AgentView, JauntPreview } from "@jaunt/ds";

export const Conversation = () => (
  <JauntPreview>
    <div className="bg-bg" style={{ width: 760, height: 640 }}>
      <AgentView host="local" id={1} wsId="s-checkout" focused={false} visible />
    </div>
  </JauntPreview>
);

export const AwaitingApproval = () => (
  <JauntPreview
    selected="s-search"
    chats={{
      1: {},
      3: {
        status: "blocked",
        pending: [{ id: "r1", tool: "Bash", summary: "pnpm test:visual", input: { command: "pnpm test:visual" }, can_always: true }],
      },
    }}
  >
    <div className="bg-bg" style={{ width: 760, height: 640 }}>
      <AgentView host="local" id={3} wsId="s-search" focused={false} visible />
    </div>
  </JauntPreview>
);
