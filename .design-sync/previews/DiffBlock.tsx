import { DiffBlock } from "@moonlet/ds";

export const CssEdit = () => (
  <div className="bg-bg p-3" style={{ width: 520 }}>
    <DiffBlock diff={"--- src/styles/checkout.css\n+++ src/styles/checkout.css\n@@ -10,4 +10,5 @@\n .checkout {\n-  .checkout-button { width: 420px; }\n+  .checkout-button { width: 100%; max-width: 420px; }\n+  .checkout-button:disabled { opacity: 0.5; }\n }\n"} />
  </div>
);

export const NewFile = () => (
  <div className="bg-bg p-3" style={{ width: 520 }}>
    <DiffBlock diff={"--- /dev/null\n+++ notes/release.md\n@@\n+## 1.4.0\n+- Checkout button fits on small screens\n+- Faster product search\n"} />
  </div>
);
