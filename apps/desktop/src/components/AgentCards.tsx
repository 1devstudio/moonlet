import type { ChatItem, PermissionAsk } from "../lib/protocol";
import { type AgentNote, type AgentRow, type AgentRowState, agentAskTitle, agentMs, clock, launchedRows } from "../lib/subagents";
import { sesKey, useStore } from "../lib/store";
import { Markdown } from "./AgentView";
import { Button, StateGlyph, cx } from "./ui";

// Conversation cards for subagents (X42): what was launched, who asks, and what finished.

const GLYPH = { needs: "blocked", running: "working", failed: "error", done: "done", stopped: "idle" } as const;
const LABEL_CLS: Record<AgentRowState, string> = { needs: "text-blocked", running: "text-muted", failed: "text-error", done: "text-faint", stopped: "text-faint" };

const openAgents = (agentDetail: string | null = null) => useStore.setState({ rightOpen: true, rightTab: "agents", agentDetail });

/** "Launched N agents", one row per Agent call. */
export function LaunchedCard({ tools, rows }: { tools: ChatItem[]; rows: AgentRow[] }) {
  const list = launchedRows(tools, rows);
  return (
    <div className="my-2 overflow-hidden rounded-xl border border-border bg-panel">
      <div className="flex h-9 items-center border-b border-border px-3.5 ui-text-13">
        <span className="font-medium text-fg">Launched {list.length === 1 ? "1 agent" : `${list.length} agents`}</span>
        <button className="ml-auto ui-text-12.5 text-accent hover:text-accent-2" onClick={() => openAgents()}>
          Show in panel
        </button>
      </div>
      {list.map((r) => (
        <div
          key={r.key}
          role="button"
          className="flex h-8 cursor-default items-center gap-2.5 px-3.5 hover:bg-panel-2"
          onClick={() => r.agent && openAgents(r.agent)}
        >
          <StateGlyph state={r.state ? GLYPH[r.state] : "idle"} size={12} />
          <span className="min-w-0 flex-1 truncate ui-text-13 text-fg">{r.description}</span>
          {r.state && <span className={cx("shrink-0 ui-text-12.5", LABEL_CLS[r.state])}>{r.label}</span>}
          <span className="w-10 shrink-0 text-right font-mono ui-text-12 tabular-nums text-faint">{r.elapsed}</span>
        </div>
      ))}
    </div>
  );
}

/** A subagent's ask in the conversation: which agent asks for what. */
export function AgentAskCard({ ask, description, onAnswer }: { ask: PermissionAsk; description: string; onAnswer: (d: "allow" | "deny") => void }) {
  return (
    <div className="moonlet-card-in my-2 flex items-start gap-2.5 rounded-xl border border-[#5c4a1e] bg-[#1d1a12] px-3.5 py-2.5">
      <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-blocked" />
      {/* The whole command shows: the user approves what they read. */}
      <span className="selectable min-w-0 flex-1 whitespace-pre-wrap break-all ui-text-13 text-fg">{agentAskTitle(ask, description)}</span>
      <Button variant="primary" size="sm" onClick={() => onAnswer("allow")}>
        Allow
      </Button>
      <Button variant="ghost" size="sm" onClick={() => onAnswer("deny")}>
        Deny
      </Button>
    </div>
  );
}

/** An agent that finished or failed, or a whole batch that finished. */
export function AgentNoteView({ note, host, session }: { note: AgentNote; host: string; session?: string }) {
  const git = useStore((s) => (session ? s.git[sesKey(host, session)] : undefined));
  if (note.kind === "all") {
    return (
      <div className="my-2 flex h-10 items-center gap-2.5 rounded-xl border border-border bg-panel px-3.5 ui-text-13">
        <StateGlyph state="done" size={12} />
        <span className="text-fg">
          {note.count} agents finished <span className="text-faint">in {note.clock}</span>
        </span>
        {git && (git.additions > 0 || git.deletions > 0) && (
          <span className="font-mono ui-text-12 tabular-nums">
            <span className="text-add">+{git.additions}</span> <span className="text-del">−{git.deletions}</span>
          </span>
        )}
        <Button size="sm" className="ml-auto" onClick={() => useStore.setState({ rightOpen: true, rightTab: "changes" })}>
          Review changes
        </Button>
      </div>
    );
  }
  const a = note.agent;
  const failed = a.status === "failed";
  return (
    <div className="my-2">
      <div className="flex items-center gap-2.5 ui-text-13">
        <StateGlyph state={failed ? "error" : "done"} size={12} />
        <span className="min-w-0 truncate text-fg">{a.description}</span>
        <span className={failed ? "text-error" : "text-faint"}>{failed ? "failed" : "finished"}</span>
        <span className="ml-auto font-mono ui-text-12 tabular-nums text-faint">{clock(agentMs(a, a.ended_at ?? a.started_at))}</span>
      </div>
      {(failed ? a.error : a.report) && (
        <div className={cx("selectable ml-[5px] mt-1.5 border-l-2 border-border pl-4 ui-text-13 leading-[1.6]", failed && "text-error")}>
          {failed ? a.error : <Markdown text={a.report ?? ""} />}
        </div>
      )}
    </div>
  );
}
