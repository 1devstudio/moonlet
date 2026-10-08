import { ToolRow } from "@moonlet/ds";

const cwd = "/Users/alex/code/storefront";

export const Statuses = () => (
  <div className="flex flex-col gap-0.5 bg-bg p-3" style={{ width: 560 }}>
    <ToolRow cwd={cwd} tool={{ name: "Read", summary: `${cwd}/src/components/Checkout.tsx`, input: {}, status: "ok", output: "export function Checkout() { … }" }} />
    <ToolRow cwd={cwd} tool={{ name: "Bash", summary: "pnpm test --filter checkout", input: {}, status: "running" }} />
    <ToolRow cwd={cwd} tool={{ name: "Grep", summary: "\"checkout-button\"", input: {}, status: "ok", output: "src/styles/checkout.css:12" }} />
    <ToolRow cwd={cwd} tool={{ name: "Bash", summary: "rm -rf node_modules", input: {}, status: "denied" }} />
    <ToolRow cwd={cwd} tool={{ name: "Bash", summary: "pnpm lint", input: {}, status: "error", output: "2 errors" }} />
  </div>
);

export const Edit = () => (
  <div className="bg-bg p-3" style={{ width: 560 }}>
    <ToolRow
      cwd={cwd}
      tool={{
        name: "Edit",
        summary: `${cwd}/src/styles/checkout.css`,
        input: {},
        status: "ok",
        diff: "--- a\n+++ b\n@@\n-.checkout-button { width: 420px; }\n+.checkout-button { width: 100%; max-width: 420px; }\n+.checkout-button:disabled { opacity: 0.5; }\n",
      }}
    />
  </div>
);
