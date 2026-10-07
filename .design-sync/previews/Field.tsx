import { Field, inputCls } from "@moonlet/ds";

export const Form = () => (
  <div className="flex flex-col gap-3 bg-panel p-4" style={{ width: 380 }}>
    <Field label="Workspace name">
      <input className={inputCls} defaultValue="Acme" />
    </Field>
    <Field label="Branch" hint="Created from main when the session starts">
      <input className={inputCls} defaultValue="moonlet/fix-checkout-button" />
    </Field>
    <Field label="Setup script">
      <input className={inputCls} placeholder="pnpm install" />
    </Field>
  </div>
);
