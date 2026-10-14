import { useEffect, useState } from "react";
import { ChevronRight, X } from "lucide-react";
import type { ChatState } from "../lib/protocol";
import { AGENT_STATE, stripDismissAt, stripRetry, stripView } from "../lib/subagents";
import { termKey, useStore } from "../lib/store";
import { openAgents, openChanges } from "../lib/actions";
import { useNow } from "../lib/useNow";
import { cx } from "./ui";

/** The top row of the chat input (X42): the agents launched since the
 *  user's last message. Finished dots pop and hide, and the row folds away
 *  once all are done. */
export function AgentsStrip({ host, id, st, onSend }: { host: string; id: number; st: ChatState; onSend: (text: string) => void }) {
  const dismissedAt = useStore((s) => s.stripDismissed[termKey(host, id)] ?? 0);
  const active = (st.subagents ?? []).some((a) => a.status === "running");
  // The clock ticks while agents run; `woke` moves the animation along between ticks.
  const [woke, setWoke] = useState(0);
  const now = Math.max(useNow(active), woke);
  const view = stripView(st, now, dismissedAt);
  const wake = view?.wake ?? null;
  useEffect(() => {
    if (wake === null) return;
    const t = setTimeout(() => setWoke(Date.now()), Math.max(0, wake - Date.now()));
    return () => clearTimeout(t);
  }, [wake]);
  if (!view) return null;
  return (
    <div aria-label="Agents" aria-hidden={view.collapsed} inert={view.collapsed} className={cx("agents-strip", view.collapsed && "collapsed")}>
      <div className="flex h-full items-center gap-2.5 pl-3.5 pr-2 ui-text-12.5">
        <span role="img" aria-label={view.counts.map((c) => c.text).join(", ") || view.title} className="-mr-1 flex shrink-0 items-center">
          {view.dots.map((d) => (
            <span key={d.key} className={cx("agents-dot", AGENT_STATE[d.state].dot, d.state === "running" && "pulse", d.phase !== "on" && d.phase)} />
          ))}
        </span>
        <span className="min-w-0 truncate text-muted">
          {view.finished ? (
            <span className="agents-fade-in inline-flex items-center gap-2 text-fg">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="agents-check shrink-0 text-done">
                <path d="M3 7.4 5.8 10 11 4" />
              </svg>
              {view.title}
            </span>
          ) : (
            <span className="text-fg">{view.title}</span>
          )}
          {view.counts.map((c) => (
            <span key={c.state} className={cx(c.state === "done" && "agents-done-count", c.state === "done" && view.flash && "text-done")}>
              {` · ${c.text}`}
            </span>
          ))}
          {view.alert && <span className={cx("agents-fade-in", view.alert.tone === "blocked" ? "text-blocked" : "text-error")}> · {view.alert.text}</span>}
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
          <button className="flex h-6 shrink-0 items-center gap-0.5 rounded-md pl-2 pr-1.5 text-muted hover:bg-hover hover:text-fg" onClick={() => openAgents()}>
            Agents
            <ChevronRight size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
