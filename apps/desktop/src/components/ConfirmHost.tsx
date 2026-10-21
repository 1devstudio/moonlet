import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { answerConfirm, confirmView, type PendingConfirm } from "../lib/confirm";
import type { UnpushedView } from "../lib/gitSettings";
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
      alt={o.alt}
      onAlt={() => answerConfirm(true, checked, true)}
      width={o.unpushed ? 520 : undefined}
      onConfirm={() => answerConfirm(true, checked)}
      onCancel={() => answerConfirm(false, checked)}
    >
      {o.code && <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-[#1a1a1a] px-3 py-2 font-mono ui-text-12.5 text-fg">{o.code}</pre>}
      {o.unpushed && <UnpushedBox view={o.unpushed} />}
    </ConfirmDialog>
  );
}

/** Uncommitted files and unpushed commits the archive would take (X55). */
function UnpushedBox({ view }: { view: UnpushedView }) {
  return (
    <div role="group" aria-label={view.heading} className="mt-3 flex flex-col gap-2 rounded-lg border border-[#4a3b17] bg-[#2a2210] px-3 py-2.5">
      <span className="flex items-center gap-2 ui-text-12.5 font-medium text-blocked">
        <ShieldAlert size={14} />
        {view.heading}
      </span>
      {view.files.length > 0 && (
        <div className="flex flex-col gap-0.5 font-mono ui-text-12 text-fg">
          {view.files.map((f) => (
            <span key={f.path} className="truncate whitespace-pre">
              <span className={f.status === "?" || f.status === "A" ? "text-add" : "text-blocked"}>{f.status}</span>
              {"  "}
              {f.path}
            </span>
          ))}
          {view.more > 0 && <span className="font-sans text-muted">and {view.more} more</span>}
        </div>
      )}
      <span className="ui-text-12 text-muted">{view.summary}</span>
    </div>
  );
}
