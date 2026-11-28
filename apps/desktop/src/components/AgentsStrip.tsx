import { ChevronRight, X } from "lucide-react";
import type { ChatState } from "../lib/protocol";
import { stripDismissAt, stripRetry } from "../lib/subagents";
import { termKey, useStore } from "../lib/store";
import { openAgents, openChanges } from "../lib/actions";
import { useStripView } from "../lib/useStripView";
import { AgentsStripSummary } from "./AgentsStripSummary";
import { cx } from "./ui";

/** The top row of the chat input (X42): the agents launched since the
 *  user's last message. Ended agents' dots pop and hide, and the row folds away
 *  once all are done. */
export function AgentsStrip({ host, id, st, visible, onSend }: { host: string; id: number; st: ChatState; visible: boolean; onSend: (text: string) => void }) {
  const dismissedAt = useStore((s) => s.stripDismissed[termKey(host, id)] ?? 0);
  const view = useStripView(st, visible, dismissedAt);
  if (!view) return null;
  return (
    <div aria-label="Agents" aria-hidden={view.collapsed} inert={view.collapsed} className={cx("agents-strip", view.collapsed && "collapsed")}>
      <div className="flex h-full items-center gap-2.5 pl-3.5 pr-2 ui-text-12.5">
        <AgentsStripSummary view={view} />
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
          <button className="flex h-6 shrink-0 items-center gap-0.5 rounded-md pl-2 pr-1.5 text-muted hover:bg-hover hover:text-fg" onClick={() => openAgents()}>
            Agents
            <ChevronRight size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
