import { useState } from "react";
import { Bot, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { rpc } from "../lib/daemon";
import { M } from "../lib/protocol";
import { errorToast, useStore } from "../lib/store";
import { tokens } from "../lib/chat";
import { AGENT_STATE, type AgentRow, agentKey, agentsHeader, isActive, modelLabel, retryMessage, stoppable } from "../lib/subagents";
import { Markdown, PermissionCard, StatusMark, rel, toolIcon } from "./AgentView";
import { Button, Empty, StateGlyph, cx } from "./ui";

const LINE = { fg: "text-fg", muted: "text-muted", error: "text-error" };

/** Opens the Agents tab, on its list or on one agent (`agentKey`). */
export const openAgents = (agentDetail: string | null = null) => useStore.setState({ rightOpen: true, rightTab: "agents", agentDetail });

/** The session's agent actions, each against the chat the agent belongs to. */
function actions(host: string) {
  const call = (chat: number, method: string, params: object) => rpc(host, method, { id: chat, ...params }).catch(errorToast);
  return {
    answer: (r: AgentRow, decision: "allow" | "always" | "deny") => r.ask && void call(r.chat, M.chatPermission, { ask: r.ask.id, decision }),
    stop: (r: AgentRow) => void call(r.chat, M.chatStopAgent, { agent: r.agent.id }),
    retry: (r: AgentRow) => void call(r.chat, M.chatSend, { text: retryMessage(r.agent), images: [] }),
  };
}

/** The Agents tab (X42): the subagents of the session's chats, or one in detail. */
export function AgentsPanel({ host, cwd, rows, now }: { host: string; cwd: string; rows: AgentRow[]; now: number }) {
  const detail = useStore((s) => s.agentDetail);
  const open = rows.find((r) => agentKey(r.chat, r.agent.id) === detail);
  const act = actions(host);
  if (open) return <AgentDetail row={open} cwd={cwd} act={act} />;
  if (!rows.length) {
    return (
      <Empty icon={<Bot size={20} />} title="No agents yet">
        Subagents Claude launches for parts of the task show here.
      </Empty>
    );
  }
  const head = agentsHeader(rows, now);
  return (
    <div className="flex flex-col">
      <div className="flex h-10 shrink-0 items-center border-b border-border px-4 ui-text-12 text-muted">
        <span className="tabular-nums">{head.text}</span>
        {head.running > 0 && (
          <button className="ml-auto hover:text-fg" onClick={() => stoppable(rows).forEach(act.stop)}>
            Stop all
          </button>
        )}
      </div>
      {rows.map((r) => (
        <div
          key={agentKey(r.chat, r.agent.id)}
          role="button"
          data-agent={r.agent.description}
          onClick={() => useStore.setState({ agentDetail: agentKey(r.chat, r.agent.id) })}
          className="cursor-default border-b border-border px-4 py-3 hover:bg-panel-2"
        >
          <div className="flex items-center gap-2.5">
            <StateGlyph state={AGENT_STATE[r.state].glyph} size={13} />
            <span className={cx("min-w-0 flex-1 truncate ui-text-13", r.state === "stopped" ? "text-muted" : "text-fg")}>{r.agent.description}</span>
            <span className="shrink-0 font-mono ui-text-12 tabular-nums text-faint">{r.elapsed}</span>
          </div>
          {r.line && (
            <div className="mt-1 flex items-center gap-2 pl-[23px]">
              <span className={cx("min-w-0 flex-1 truncate ui-text-12.5", LINE[r.line.tone])}>{r.line.text}</span>
              {r.state === "failed" && (
                <button
                  className="shrink-0 ui-text-12.5 text-accent hover:text-accent-2"
                  onClick={(e) => {
                    e.stopPropagation();
                    act.retry(r);
                  }}
                >
                  Retry
                </button>
              )}
            </div>
          )}
          {r.state === "needs" && (
            <div className="mt-2 flex gap-1.5 pl-[23px]" onClick={(e) => e.stopPropagation()}>
              <Button variant="primary" size="sm" onClick={() => act.answer(r, "allow")}>
                Allow
              </Button>
              <Button variant="ghost" size="sm" onClick={() => act.answer(r, "deny")}>
                Deny
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function AgentDetail({ row, cwd, act }: { row: AgentRow; cwd: string; act: ReturnType<typeof actions> }) {
  const [brief, setBrief] = useState(false);
  const a = row.agent;
  const look = AGENT_STATE[row.state];
  const meta = [a.model && modelLabel(a.model), row.elapsed, a.tokens ? `${tokens(a.tokens)} tokens` : null].filter(Boolean);
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <button className="-ml-1 mt-3 flex items-center gap-0.5 ui-text-12.5 text-muted hover:text-fg" onClick={() => useStore.setState({ agentDetail: null })}>
          <ChevronLeft size={14} />
          Agents
        </button>
        <div className="mt-3 flex items-center gap-2.5">
          <StateGlyph state={AGENT_STATE[row.state].glyph} size={13} />
          <span className="selectable min-w-0 flex-1 ui-text-14 font-medium text-fg">{a.description}</span>
        </div>
        <div className="mt-1 pl-[23px] ui-text-12.5 text-muted">
          <span className={cx("inline-block first-letter:uppercase", look.text)}>{look.label}</span>
          {meta.map((m) => ` · ${m}`)}
        </div>
        {a.prompt && (
          <div className="mt-4">
            <button className="flex w-full min-w-0 items-center gap-1 text-left ui-text-12.5 text-muted hover:text-fg" onClick={() => setBrief(!brief)}>
              {brief ? <ChevronDown size={13} className="shrink-0" /> : <ChevronRight size={13} className="shrink-0" />}
              <span className="truncate">Brief{brief ? "" : ` · ${a.prompt.split("\n")[0]}`}</span>
            </button>
            {brief && <div className="selectable mt-1.5 whitespace-pre-wrap rounded-md bg-panel-2 px-3 py-2 ui-text-12.5 text-muted">{a.prompt}</div>}
          </div>
        )}
        {a.tools.length > 0 && (
          <div className="mt-3 flex flex-col">
            {a.tools.map((t) => {
              const Icon = toolIcon(t.name);
              return (
                <div key={t.id} className="flex h-8 min-w-0 items-center gap-2">
                  <Icon size={14} className="shrink-0 text-muted" />
                  <span className="shrink-0 ui-text-13 text-fg">{t.name}</span>
                  <span className={cx("min-w-0 flex-1 truncate font-mono ui-text-12", t.status === "denied" ? "text-faint line-through" : "text-faint")}>{rel(t.summary, cwd)}</span>
                  {t.added != null && (
                    <span className="shrink-0 font-mono ui-text-12 tabular-nums">
                      <span className="text-add">+{t.added}</span> <span className="text-del">−{t.removed ?? 0}</span>
                    </span>
                  )}
                  <StatusMark status={t.status} />
                </div>
              );
            })}
          </div>
        )}
        {row.ask && <PermissionCard ask={row.ask} cwd={cwd} onAnswer={(d) => act.answer(row, d)} />}
        {row.state === "failed" && (
          <div className="mt-3 flex items-center gap-2 ui-text-12.5">
            <span className="min-w-0 flex-1 text-error">{a.error || "Failed"}</span>
            <button className="text-accent hover:text-accent-2" onClick={() => act.retry(row)}>
              Retry
            </button>
          </div>
        )}
        {a.report && (
          <div className="selectable mt-4 border-l-2 border-border pl-3 ui-text-13 leading-[1.6]">
            <Markdown text={a.report} />
          </div>
        )}
      </div>
      {isActive(row.state) && (
        <div className="flex h-11 shrink-0 items-center justify-end border-t border-border px-4">
          <button className="ui-text-12.5 text-muted hover:text-fg" onClick={() => act.stop(row)}>
            Stop
          </button>
        </div>
      )}
    </div>
  );
}
