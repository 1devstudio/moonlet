import { useEffect, useState } from "react";
import { answerConfirm, confirmView, type PendingConfirm } from "../lib/confirm";
import { useStore } from "../lib/store";
import { ConfirmDialog } from "./ui";

/** Shows the open confirm request (X23). */
export function ConfirmHost() {
  const pending = useStore((s) => s.confirm);
  return pending ? <OpenConfirm key={pending.id} pending={pending} /> : null;
}

function OpenConfirm({ pending }: { pending: PendingConfirm }) {
  const o = pending.options;
  const [checked, setChecked] = useState(o.checkbox?.checked ?? false);
  // Read while rendering, before the action button takes focus, so focus goes
  // back where it was on close, such as the terminal that pressed ⌘W.
  const [before] = useState(() => document.activeElement);
  useEffect(
    () => () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    },
    [before],
  );
  const view = confirmView(o, checked);
  return (
    <ConfirmDialog
      title={o.title}
      message={view.message}
      action={o.action}
      cancel={o.cancel}
      variant={view.variant}
      checkbox={o.checkbox?.label}
      checked={checked}
      onCheck={setChecked}
      onConfirm={() => answerConfirm(true, checked)}
      onCancel={() => answerConfirm(false, checked)}
    />
  );
}
