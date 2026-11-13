import { useEffect, useRef, useState } from "react";
import { GitBranch, GitPullRequest, X } from "lucide-react";
import { type Session } from "../lib/protocol";
import { focusTerminal, getLayout, useStore, sesKey } from "../lib/store";
import { newSessionAgentTab, newTab, sendToAgent } from "../lib/actions";
import { quietWhen } from "../lib/motion";
import { PaneTree } from "./PaneTree";
import { AgentIcon, Kbd, Pane, cx, TRAFFIC_LIGHTS } from "./ui";
import { agentLabel } from "../lib/agents";
import { TaskBar, useSessionTask } from "./tasks/SessionTask";
import { TabStrip } from "./SessionTabs";
import { CopyLine } from "./CopyLine";

/** A session without a task heads its column with its name and branch (X94). */
function SessionHeader({ ws }: { ws: Session }) {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  return (
    <header
      data-tauri-drag-region
      aria-label="Session"
      className="drag flex h-ui-44 shrink-0 items-center gap-2.5 pr-[6px]"
      // Clear of the traffic lights when the sidebar is closed.
      style={{ paddingLeft: sidebarOpen ? 12 : TRAFFIC_LIGHTS }}
    >
      <GitBranch size={14} strokeWidth={1.75} className="shrink-0 text-muted" />
      <h1 className="min-w-0 truncate ui-text-13.5 font-medium text-fg">{ws.name}</h1>
      {ws.branch && <span className="min-w-0 truncate font-mono ui-text-12 text-faint">{ws.branch}</span>}
    </header>
  );
}

/** `❯ ▌ Type a task for Claude…`: typed into the agent as one paste. */
function PromptLine({ host, ws }: { host: string; ws: Session }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const agent = useStore((s) => Object.values(s.terminals[host] ?? {}).find((x) => x.session_id === ws.id && x.kind === "agent" && !x.exit));
  // Structured agents have their own editor (X6).
  const chatOpen = useStore((s) => {
    const f = getLayout(host, ws.id).focused;
    return f !== null && !!s.terminals[host]?.[f]?.chat;
  });
  if (!agent || agent.chat || chatOpen) return null;
  const submit = async () => {
    if (!text.trim()) return;
    if (await sendToAgent(text.trim())) setText("");
  };
  return (
    <div className="mx-7 flex shrink-0 items-start gap-3 border-t border-border py-4 font-mono ui-text-13" onClick={() => ref.current?.focus()}>
      <span className="select-none text-faint">❯</span>
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={`Type a task for ${agentLabel(agent.agent)}…`}
        className="max-h-32 min-h-[calc(20px*var(--ui-scale,1))] flex-1 resize-none bg-transparent leading-[calc(20px*var(--ui-scale,1))] text-fg caret-accent outline-none placeholder:text-faint"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
      />
    </div>
  );
}

function fmtDuration(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Floating card when an agent in this workspace finishes or needs input. */
function AgentCard({ host, ws }: { host: string; ws: Session }) {
  const card = useStore((s) => (s.card && s.card.host === host && s.card.session === ws.id ? s.card : null));
  const git = useStore((s) => s.git[sesKey(host, ws.id)]);
  useEffect(() => {
    if (!card || card.state === "blocked") return;
    const t = setTimeout(() => useStore.setState((s) => (s.card?.at === card.at ? { card: null } : {})), 12_000);
    return () => clearTimeout(t);
  }, [card]);
  if (!card) return null;
  const status =
    card.state === "blocked" ? "needs input" : card.state === "error" ? "failed" : `finished${card.workedMs ? ` · worked for ${fmtDuration(card.workedMs)}` : ""}`;
  return (
    <div className="moonlet-card-in absolute bottom-5 right-7 z-20 w-[440px] overflow-hidden rounded-xl border border-border-strong bg-[#171717] shadow-2xl">
      <div role="button" className="block w-full cursor-default px-5 pb-4 pt-4 text-left" onClick={() => focusTerminal(host, card.terminal)}>
        <div className="mb-2 flex items-center gap-2.5 ui-text-14">
          <AgentIcon agent={card.agent} size={15} />
          <span className="font-semibold">{card.agent ?? "agent"}</span>
          <span className={cx("ui-text-13", card.state === "blocked" ? "text-blocked" : card.state === "error" ? "text-error" : "text-muted")}>{status}</span>
          <button
            title="Dismiss"
            className="ml-auto rounded p-0.5 text-faint hover:bg-hover hover:text-fg"
            onClick={(e) => {
              e.stopPropagation();
              useStore.setState({ card: null });
            }}
          >
            <X size={13} />
          </button>
        </div>
        {card.message && <div className="line-clamp-3 ui-text-14 leading-snug text-[#dcdcdc]">{card.message}</div>}
      </div>
      {git && git.files.length > 0 && (
        <div className="flex items-center gap-2 border-t border-border px-5 py-3 font-mono ui-text-12.5 text-muted">
          <GitPullRequest size={13} strokeWidth={1.75} />
          {git.files.length} file{git.files.length === 1 ? "" : "s"}
          <span className="text-add">+{git.additions}</span>
          <span className="text-del">−{git.deletions}</span>
          <button
            className="ml-auto rounded-full border border-border-strong px-3.5 py-1 font-sans ui-text-13 text-fg hover:bg-hover"
            onClick={() => useStore.setState({ card: null, rightTab: "changes", rightOpen: true })}
          >
            Preview
          </button>
        </div>
      )}
    </div>
  );
}

export function SessionView({ host, ws }: { host: string; ws: Session }) {
  const layout = useStore((s) => s.layouts[sesKey(host, ws.id)]);
  const hostInfo = useStore((s) => s.hosts[host]);
  const task = useSessionTask(host, ws);
  return (
    <div className="flex h-full min-w-0 flex-col">
      {task ? <TaskBar host={host} ws={ws} linked={task} /> : <SessionHeader ws={ws} />}
      <TabStrip host={host} ws={ws} />
      <Pane className="flex flex-col">
      <CopyLine host={host} />
      {hostInfo && hostInfo.status !== "connected" && (
        <div className="shrink-0 bg-[#221d12] px-7 py-1.5 font-mono ui-text-12 text-blocked">
          {hostInfo.status === "reconnecting" || hostInfo.status === "connecting"
            ? `reconnecting to ${hostInfo.label}… agents keep running`
            : `${hostInfo.label}: ${hostInfo.message ?? hostInfo.status}`}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {layout?.tabs.map((t) => {
          const shown = t.id === layout.active;
          return (
            <div key={t.id} className="absolute inset-0" style={{ visibility: shown ? "visible" : "hidden" }} {...quietWhen(!shown)}>
              <PaneTree host={host} wsId={ws.id} tabId={t.id} node={t.root} path={[]} focused={layout.focused} visible={shown} />
            </div>
          );
        })}
        {(!layout || layout.tabs.length === 0) && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted">
            <div className="ui-text-14">No terminals in this session.</div>
            <div className="flex gap-2">
              <button className="rounded-md border border-border-strong px-3 py-1.5 ui-text-13 text-fg hover:bg-hover" onClick={() => void newSessionAgentTab()}>
                New agent <Kbd>⌘T</Kbd>
              </button>
              <button className="rounded-md border border-border-strong px-3 py-1.5 ui-text-13 text-fg hover:bg-hover" onClick={() => void newTab()}>
                New terminal <Kbd>⇧⌘T</Kbd>
              </button>
            </div>
          </div>
        )}
        <AgentCard host={host} ws={ws} />
      </div>
      <PromptLine host={host} ws={ws} />
      </Pane>
    </div>
  );
}
