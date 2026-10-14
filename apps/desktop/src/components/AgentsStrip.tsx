import { ChevronRight, X } from "lucide-react";
import type { ChatState } from "../lib/protocol";
import { AGENT_STATE, stripDismissAt, stripRetry, stripView } from "../lib/subagents";
import { termKey, useStore } from "../lib/store";
import { openAgents, openChanges } from "../lib/actions";
import { useNow } from "../lib/useNow";
import { cx } from "./ui";

/** Above the chat input (X42): the agents launched since the user's last message. */
export function AgentsStrip({ host, id, st, onSend }: { host: string; id: number; st: ChatState; onSend: (text: string) => void }) {
  const dismissedAt = useStore((s) => s.stripDismissed[termKey(host, id)] ?? 0);
  const active = (st.subagents ?? []).some((a) => a.status === "running");
  const now = useNow(active);
  const view = stripView(st, now, dismissedAt);
  if (!view) return null;
  return (
    <div aria-label="Agents" className="mb-1.5 flex h-9 items-center gap-2.5 rounded-[10px] border border-border-strong bg-panel px-3.5 ui-text-12.5">
      <span className="flex shrink-0 gap-1">
        {view.dots.map((d, i) => (
          <span key={i} className={cx("h-1.5 w-1.5 rounded-full", AGENT_STATE[d].dot)} />
        ))}
      </span>
      <span className="min-w-0 truncate text-muted">
        <span className="text-fg">{view.title}</span>
        {view.detail && ` · ${view.detail}`}
        {view.alert && <span className={view.alert.tone === "blocked" ? "text-blocked" : "text-error"}> · {view.alert.text}</span>}
      </span>
      <span className="ml-auto shrink-0 font-mono ui-text-12 tabular-nums text-faint">{view.clock}</span>
      {view.button === "review" && (
        <button className="shrink-0 text-accent hover:text-accent-2" onClick={openChanges}>
          Review changes
        </button>
      )}
      {view.button === "retry" && (
        <button className="shrink-0 text-accent hover:text-accent-2" onClick={() => {
            const text = stripRetry(st);
            if (text) onSend(text);
          }}>
          Retry
        </button>
      )}
      {view.dismissible ? (
        <button
          title="Hide"
          className="shrink-0 rounded p-0.5 text-muted hover:bg-hover hover:text-fg"
          onClick={() =>
            useStore.setState((s) => ({ stripDismissed: { ...s.stripDismissed, [termKey(host, id)]: stripDismissAt(st) } }))
          }
        >
          <X size={13} />
        </button>
      ) : (
        <button className="flex shrink-0 items-center gap-0.5 text-muted hover:text-fg" onClick={() => openAgents()}>
          Agents
          <ChevronRight size={13} />
        </button>
      )}
    </div>
  );
}
