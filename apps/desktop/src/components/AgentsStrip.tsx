import { ChevronRight, X } from "lucide-react";
import type { ChatState } from "../lib/protocol";
import { type AgentRowState, batchOf, retryMessage, stripView } from "../lib/subagents";
import { termKey, useStore, sesKey } from "../lib/store";
import { useNow } from "../lib/useNow";
import { cx } from "./ui";

const DOT: Record<AgentRowState, string> = { done: "bg-done", running: "bg-accent", needs: "bg-blocked", failed: "bg-error", stopped: "bg-idle" };

/** Above the chat input (X42): the agents launched since the user's last message. */
export function AgentsStrip({ host, id, session, st, onSend }: { host: string; id: number; session?: string; st: ChatState; onSend: (text: string) => void }) {
  const dismissedAt = useStore((s) => s.stripDismissed[termKey(host, id)] ?? 0);
  const git = useStore((s) => (session ? s.git[sesKey(host, session)] : undefined));
  const active = (st.subagents ?? []).some((a) => a.status === "running");
  const now = useNow(active);
  const view = stripView(st, now, git ? { additions: git.additions, deletions: git.deletions, files: git.files.length } : null, dismissedAt);
  if (!view) return null;
  const openAgents = () => useStore.setState({ rightOpen: true, rightTab: "agents", agentDetail: null });
  return (
    <div aria-label="Agents" className="mb-1.5 flex h-9 items-center gap-2.5 rounded-[10px] border border-border-strong bg-panel px-3.5 ui-text-12.5">
      <span className="flex shrink-0 gap-1">
        {view.dots.map((d, i) => (
          <span key={i} className={cx("h-1.5 w-1.5 rounded-full", DOT[d])} />
        ))}
      </span>
      <span className="min-w-0 truncate text-muted">
        <span className="text-fg">{view.title}</span>
        {view.detail && ` · ${view.detail}`}
        {view.alert && <span className={view.alert.tone === "blocked" ? "text-blocked" : "text-error"}> · {view.alert.text}</span>}
      </span>
      <span className="ml-auto shrink-0 font-mono ui-text-12 tabular-nums text-faint">{view.clock}</span>
      {view.button === "review" && (
        <button className="shrink-0 text-accent hover:text-accent-2" onClick={() => useStore.setState({ rightOpen: true, rightTab: "changes" })}>
          Review changes
        </button>
      )}
      {view.button === "retry" && (
        <button className="shrink-0 text-accent hover:text-accent-2" onClick={() => onSend(retryMessage(batchOf(st).filter((a) => a.status === "failed")))}>
          Retry
        </button>
      )}
      {view.dismissible ? (
        <button
          title="Hide"
          className="shrink-0 rounded p-0.5 text-muted hover:bg-hover hover:text-fg"
          onClick={() =>
            useStore.setState((s) => ({ stripDismissed: { ...s.stripDismissed, [termKey(host, id)]: Math.max(...batchOf(st).map((a) => a.started_at)) } }))
          }
        >
          <X size={13} />
        </button>
      ) : (
        <button className="flex shrink-0 items-center gap-0.5 text-muted hover:text-fg" onClick={openAgents}>
          Agents
          <ChevronRight size={13} />
        </button>
      )}
    </div>
  );
}
