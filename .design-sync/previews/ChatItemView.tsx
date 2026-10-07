import { ChatItemView } from "@moonlet/ds";

const cwd = "/Users/alex/code/storefront";

export const Conversation = () => (
  <div className="flex flex-col gap-0.5 bg-bg p-4" style={{ width: 560 }}>
    <ChatItemView cwd={cwd} item={{ id: "u", kind: "user", text: "The checkout button overflows on small screens. Can you fix it?", ts: 0 }} />
    <ChatItemView cwd={cwd} item={{ id: "t", kind: "tool", text: "", ts: 0, tool: { name: "Bash", summary: "rg -n \"checkout-button\" src", input: {}, status: "ok", output: "src/styles/checkout.css:12" } }} />
    <ChatItemView cwd={cwd} item={{ id: "a", kind: "assistant", text: "Fixed: the button now uses `max-width: 420px` and fills smaller screens.", ts: 0 }} />
  </div>
);

export const SystemAndError = () => (
  <div className="flex flex-col gap-1 bg-bg p-4" style={{ width: 560 }}>
    <ChatItemView cwd={cwd} item={{ id: "s", kind: "system", text: "Interrupted", ts: 0 }} />
    <ChatItemView cwd={cwd} item={{ id: "e", kind: "error", text: "The agent exited (code 1):\nError: ANTHROPIC_API_KEY is not set", ts: 0 }} />
  </div>
);
