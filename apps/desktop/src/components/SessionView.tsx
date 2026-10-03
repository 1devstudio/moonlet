import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, GitPullRequest, Plus, X } from "lucide-react";
import { rpc } from "../lib/daemon";
import { leaves } from "../lib/layout";
import { M, type ProjectConfig, type Session } from "../lib/protocol";
import { focusTerminal, getLayout, projectOf, termKey, setLayout, useStore, sesKey } from "../lib/store";
import { newAgentTab, newTab, sendToAgent, split } from "../lib/actions";
import { PaneTree } from "./PaneTree";
import { AgentIcon, Kbd, cx } from "./ui";
import { agentLabel } from "../lib/agents";


function AddMenu({ host, ws }: { host: string; ws: Session }) {
  const [open, setOpen] = useState(false);
  const repo = useStore((s) => projectOf(s, host, ws));
  const [agents, setAgents] = useState<string[]>(["claude", "codex"]);
  useEffect(() => {
    if (!open || !repo) return;
    void rpc<ProjectConfig>(host, M.projectConfig, { id: repo.id })
      .then((c) => setAgents(["claude", "codex", ...Object.keys(c.agents ?? {}).filter((a) => a !== "claude" && a !== "codex")]))
      .catch(() => {});
  }, [open, host, repo]);
  const item = (key: string, content: ReactNode, run: () => void, kbd?: string) => (
    <button
      key={key}
      className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] hover:bg-hover"
      onClick={() => {
        setOpen(false);
        run();
      }}
    >
      {content}
      {kbd && (
        <span className="ml-auto">
          <Kbd>{kbd}</Kbd>
        </span>
      )}
    </button>
  );
  return (
    <div className="no-drag relative flex items-center">
      <button title="New terminal (⌘T)" className="flex h-8 items-center rounded-l-md pl-2.5 pr-1 text-muted hover:bg-raised hover:text-fg" onClick={() => void newTab()}>
        <Plus size={15} strokeWidth={1.75} />
      </button>
      <button title="New agent or split" className="flex h-8 items-center rounded-r-md pl-0.5 pr-2 text-muted hover:bg-raised hover:text-fg" onClick={() => setOpen(!open)}>
        <ChevronDown size={13} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-9 z-40 w-56 overflow-hidden rounded-lg border border-border-strong bg-panel-2 py-1 shadow-2xl">
            {agents.map((a) =>
              item(
                a,
                <>
                  <AgentIcon agent={a} size={13} /> {agentLabel(a)}
                </>,
                () => void newAgentTab(a),
              ),
            )}
            <div className="my-1 border-t border-border" />
            {item("term", <>Terminal</>, () => void newTab(), "⌘T")}
            {item("split-r", <>Split right</>, () => void split("row"), "⌘D")}
            {item("split-d", <>Split down</>, () => void split("col"), "⌥⌘D")}
          </div>
        </>
      )}
    </div>
  );
}

function Tab({ host, ws, id, ids, active }: { host: string; ws: Session; id: string; ids: number[]; active: boolean }) {
  const info = useStore((s) => s.terminals[host]?.[ids[0]]);
  const unread = useStore((s) => ids.some((x) => s.unread[termKey(host, x)]));
  const state = info?.kind === "agent" && !info.exit ? info.agent_state : null;
  const name = info ? (info.agent ?? info.title) : "…";
  return (
    <div
      className={cx(
        "no-drag group relative flex h-full w-[172px] shrink-0 cursor-default items-center gap-2.5 px-4 text-[14px]",
        active ? "bg-raised text-fg" : "text-muted hover:text-fg",
      )}
      onMouseDown={() => setLayout(host, ws.id, { ...getLayout(host, ws.id), active: id, focused: ids[0] })}
    >
      <AgentIcon agent={info?.kind === "agent" ? info.agent : null} size={15} />
      <span className={cx("truncate", unread && "font-semibold text-fg")}>{name}</span>
      {ids.length > 1 && <span className="font-mono text-[11px] text-faint">+{ids.length - 1}</span>}
      {state === "blocked" && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blocked" title="needs input" />}
      {state === "working" && (
        <span className="jaunt-dots shrink-0" title="working">
          <i />
          <i />
          <i />
        </span>
      )}
      {info?.exit && <span className="font-mono text-[11px] text-faint">exited</span>}
      <button
        className="ml-auto rounded p-0.5 text-faint opacity-0 hover:bg-hover hover:text-fg group-hover:opacity-100"
        title="Close tab"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => {
          for (const x of ids) void rpc(host, M.terminalKill, { id: x, remove: true });
        }}
      >
        <X size={12} />
      </button>
    </div>
  );
}

function TabStrip({ host, ws }: { host: string; ws: Session }) {
  const layout = useStore((s) => s.layouts[sesKey(host, ws.id)]);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  return (
    <div className="drag flex h-[52px] shrink-0 items-stretch bg-panel" style={{ paddingLeft: sidebarOpen ? 0 : 84 }}>
      <div className="flex min-w-0 items-stretch overflow-x-auto">
        {layout?.tabs.map((t) => (
          <Tab key={t.id} host={host} ws={ws} id={t.id} ids={leaves(t.root)} active={t.id === layout.active} />
        ))}
      </div>
      <div className="flex items-center px-2">
        <AddMenu host={host} ws={ws} />
      </div>
    </div>
  );
}

/** `❯ ▌ Type a task for Claude…`: typed into the agent as one paste. */
function PromptLine({ host, ws }: { host: string; ws: Session }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const agent = useStore((s) => Object.values(s.terminals[host] ?? {}).find((x) => x.session_id === ws.id && x.kind === "agent" && !x.exit));
  if (!agent) return null;
  const submit = async () => {
    if (!text.trim()) return;
    if (await sendToAgent(text.trim())) setText("");
  };
  return (
    <div className="mx-7 flex shrink-0 items-start gap-3 border-t border-border py-4 font-mono text-[13px]" onClick={() => ref.current?.focus()}>
      <span className="select-none text-faint">❯</span>
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={`Type a task for ${agentLabel(agent.agent)}…`}
        className="max-h-32 min-h-[20px] flex-1 resize-none bg-transparent leading-[20px] text-fg caret-accent outline-none placeholder:text-faint"
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
    <div className="jaunt-card-in absolute bottom-5 right-7 z-20 w-[440px] overflow-hidden rounded-xl border border-border-strong bg-[#171717] shadow-2xl">
      <div role="button" className="block w-full cursor-default px-5 pb-4 pt-4 text-left" onClick={() => focusTerminal(host, card.terminal)}>
        <div className="mb-2 flex items-center gap-2.5 text-[14px]">
          <AgentIcon agent={card.agent} size={15} />
          <span className="font-semibold">{card.agent ?? "agent"}</span>
          <span className={cx("text-[13px]", card.state === "blocked" ? "text-blocked" : card.state === "error" ? "text-error" : "text-muted")}>{status}</span>
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
        {card.message && <div className="line-clamp-3 text-[14px] leading-snug text-[#dcdcdc]">{card.message}</div>}
      </div>
      {git && git.files.length > 0 && (
        <div className="flex items-center gap-2 border-t border-border px-5 py-3 font-mono text-[12.5px] text-muted">
          <GitPullRequest size={13} strokeWidth={1.75} />
          {git.files.length} file{git.files.length === 1 ? "" : "s"}
          <span className="text-add">+{git.additions}</span>
          <span className="text-del">−{git.deletions}</span>
          <button
            className="ml-auto rounded-full border border-border-strong px-3.5 py-1 font-sans text-[13px] text-fg hover:bg-hover"
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
  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      <TabStrip host={host} ws={ws} />
      {hostInfo && hostInfo.status !== "connected" && (
        <div className="shrink-0 bg-[#221d12] px-7 py-1.5 font-mono text-[12px] text-blocked">
          {hostInfo.status === "reconnecting" || hostInfo.status === "connecting"
            ? `reconnecting to ${hostInfo.label}… agents keep running`
            : `${hostInfo.label}: ${hostInfo.message ?? hostInfo.status}`}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {layout?.tabs.map((t) => (
          <div key={t.id} className="absolute inset-0" style={{ visibility: t.id === layout.active ? "visible" : "hidden" }}>
            <PaneTree host={host} wsId={ws.id} tabId={t.id} node={t.root} path={[]} focused={layout.focused} visible={t.id === layout.active} />
          </div>
        ))}
        {(!layout || layout.tabs.length === 0) && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted">
            <div className="text-[14px]">No terminals in this session.</div>
            <button className="rounded-md border border-border-strong px-3 py-1.5 text-[13px] text-fg hover:bg-hover" onClick={() => void newTab()}>
              New terminal <Kbd>⌘T</Kbd>
            </button>
          </div>
        )}
        <AgentCard host={host} ws={ws} />
      </div>
      <PromptLine host={host} ws={ws} />
    </div>
  );
}
