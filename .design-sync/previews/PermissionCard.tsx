import { PermissionCard } from "@jaunt/ds";

const cwd = "/Users/alex/code/storefront";

export const Command = () => (
  <div className="bg-bg p-3" style={{ width: 560 }}>
    <PermissionCard cwd={cwd} onAnswer={() => {}} ask={{ id: "r1", tool: "Bash", summary: "pnpm test --filter checkout", input: { command: "pnpm test --filter checkout" }, can_always: true }} />
  </div>
);

export const EditWithDiff = () => (
  <div className="bg-bg p-3" style={{ width: 560 }}>
    <PermissionCard
      cwd={cwd}
      onAnswer={() => {}}
      ask={{
        id: "r2",
        tool: "Edit",
        summary: `${cwd}/src/styles/checkout.css`,
        input: { file_path: `${cwd}/src/styles/checkout.css` },
        can_always: true,
        diff: "--- a\n+++ b\n@@\n-.checkout-button { width: 420px; }\n+.checkout-button { width: 100%; max-width: 420px; }\n",
      }}
    />
  </div>
);

export const WithReason = () => (
  <div className="bg-bg p-3" style={{ width: 560 }}>
    <PermissionCard cwd={cwd} onAnswer={() => {}} ask={{ id: "r3", tool: "WebFetch", summary: "https://api.stripe.com/v1/refunds", input: { url: "https://api.stripe.com/v1/refunds" }, reason: "Network access is outside the workspace sandbox.", can_always: false }} />
  </div>
);
