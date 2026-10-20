// The phone's conversation rows (X40): the desktop's chat model (X6, X14)
// drawn for touch.

import { useState } from "react";
import {
  Ban,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  FilePen,
  FileText,
  Globe,
  ListTodo,
  Loader2,
  MessageCircleQuestion,
  Search,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { type ChatBlock, diffStat, planOf, thinkingPreview, toolCommand, toolGroupLabel, toolGroupStatus } from "@desktop/lib/chat";
import type { ChatItem, ToolCall } from "@desktop/lib/protocol";
import { AGENT_STATE, type AgentRow, agentCount, isActive, launchedRows, modelLabel } from "@desktop/lib/subagents";
import { DIFF_LINE } from "../lib/palette";
import { Markdown } from "./Markdown";
import { Btn, StateGlyph, cx } from "./ui";

function toolIcon(name: string) {
  const n = name.toLowerCase();
  if (n === "bash" || n === "shell") return Terminal;
  if (n === "read") return FileText;
  if (["edit", "write", "multiedit", "notebookedit"].includes(n)) return FilePen;
  if (n === "grep" || n === "glob") return Search;
  if (n.startsWith("web")) return Globe;
  if (n === "task" || n === "agent") return Bot;
  if (n === "todowrite") return ListTodo;
  if (n === "askuserquestion") return MessageCircleQuestion;
  if (n === "exitplanmode") return ClipboardList;
  return Wrench;
}

export function StatusMark({ status }: { status: ToolCall["status"] }) {
  if (status === "running") return <Loader2 size={14} className="animate-spin text-muted" />;
  if (status === "ok") return <Check size={14} className="text-faint" />;
  if (status === "denied") return <Ban size={14} className="text-blocked" />;
  return <X size={14} className="text-error" />;
}

/** Unified diff lines, coloured. */
export function DiffLines({ diff }: { diff: string }) {
  return (
    <pre className="selectable scroll m-0 max-h-[320px] rounded-[8px] bg-panel py-1 font-mono text-[11.5px] leading-[1.5]">
      {diff.split("\n").map((l, i) => (
        <div
          key={i}
          className={cx(
            "px-2 whitespace-pre-wrap break-all",
            l.startsWith("+") && !l.startsWith("+++") && DIFF_LINE.add,
            l.startsWith("-") && !l.startsWith("---") && DIFF_LINE.del,
            l.startsWith("@@") && "text-faint",
          )}
        >
          {l || " "}
        </div>
      ))}
    </pre>
  );
}

const rel = (path: string, cwd: string) => (cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path);

export function ToolRow({ tool, cwd }: { tool: ToolCall; cwd: string }) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(tool.name);
  const stat = tool.diff ? diffStat(tool.diff) : null;
  const command = toolCommand(tool);
  const plan = planOf({ tool: tool.name, input: tool.input });
  const expandable = !!(tool.diff || tool.output || command || plan);
  return (
    <div>
      <button type="button" onClick={() => expandable && setOpen(!open)} className="flex min-h-9 w-full min-w-0 items-center gap-2 text-left text-[13.5px]">
        <Icon size={15} className="shrink-0 text-muted" />
        <span className="shrink-0 font-medium">{tool.name}</span>
        <span className={cx("min-w-0 truncate font-mono text-[12.5px]", tool.status === "denied" ? "text-faint line-through" : "text-muted")}>{rel(tool.summary, cwd)}</span>
        {stat && (stat.add > 0 || stat.del > 0) && (
          <span className="shrink-0 font-mono text-[12px]">
            <span className="text-add">+{stat.add}</span> <span className="text-del">−{stat.del}</span>
          </span>
        )}
        <span className="ml-auto shrink-0">
          <StatusMark status={tool.status} />
        </span>
      </button>
      {open && (
        <div className="mt-1 mb-2 ml-6">
          {tool.diff ? (
            <DiffLines diff={tool.diff} />
          ) : plan ? (
            <div className="rounded-[8px] bg-panel p-3">
              <Markdown text={plan.plan} />
            </div>
          ) : (
            <pre className="selectable scroll m-0 max-h-[300px] rounded-[8px] bg-panel p-2.5 font-mono text-[11.5px] leading-[1.5] break-all whitespace-pre-wrap text-muted">
              {command && <span className="text-fg">$ {command}\n</span>}
              {tool.output?.trim()}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function ToolGroup({ tools, cwd }: { tools: ChatItem[]; cwd: string }) {
  const [open, setOpen] = useState(false);
  const status = toolGroupStatus(tools);
  if (tools.length === 1 && tools[0].tool) return <ToolRow tool={tools[0].tool} cwd={cwd} />;
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-h-9 items-center gap-1.5 text-[13.5px] text-muted">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {toolGroupLabel(tools.length)}
        {status !== "ok" && <StatusMark status={status} />}
      </button>
      {open && <div className="ml-2">{tools.map((t) => t.tool && <ToolRow key={t.id} tool={t.tool} cwd={cwd} />)}</div>}
    </div>
  );
}

function Thinking({ item }: { item: ChatItem }) {
  const [open, setOpen] = useState(false);
  if (item.partial) return <div className="text-[13.5px] text-muted italic">Thinking…</div>;
  if (!item.text.trim()) return null;
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-h-9 w-full min-w-0 items-center gap-2 text-left text-[13.5px]">
        <Brain size={15} className="shrink-0 text-muted" />
        <span className="shrink-0 font-medium">Thinking</span>
        {!open && <span className="min-w-0 truncate text-muted">{thinkingPreview(item.text)}</span>}
      </button>
      {open && <div className="selectable mb-2 ml-6 border-l border-border pl-3 text-[13.5px] leading-relaxed whitespace-pre-wrap text-muted italic">{item.text}</div>}
    </div>
  );
}

/** "Agent <name>" over an ask a subagent makes (X42). */
export function AskerLine({ name }: { name: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted">
      <Bot size={13} className="shrink-0" />
      <span className="shrink-0">Agent</span>
      <span className="min-w-0 truncate text-fg">{name}</span>
    </div>
  );
}

/** "Launched 3 agents": a run of Agent calls, each with its live state (X42). */
function LaunchedCard({ tools, rows, onOpen }: { tools: ChatItem[]; rows: AgentRow[]; onOpen: (row: AgentRow) => void }) {
  const list = launchedRows(tools, rows);
  return (
    <div className="flex-none overflow-hidden rounded-[12px] border border-border bg-panel">
      <div className="flex h-10 items-center border-b border-border px-3.5 text-[13.5px] font-medium">Launched {agentCount(list.length)}</div>
      {list.map((r) => {
        const row = rows.find((x) => x.agent.tool_use_id === r.key);
        return (
          <button key={r.key} type="button" disabled={!row} onClick={() => row && onOpen(row)} className="flex min-h-11 w-full items-center gap-2.5 px-3.5 text-left">
            <StateGlyph state={r.state ? AGENT_STATE[r.state].glyph : "idle"} size={12} />
            <span className="min-w-0 flex-1 truncate text-[14px]">{r.description}</span>
            {r.state && <span className={cx("shrink-0 text-[12.5px]", AGENT_STATE[r.state].text)}>{r.label}</span>}
            <span className="w-10 shrink-0 text-right font-mono text-[12px] text-faint tabular-nums">{r.elapsed}</span>
          </button>
        );
      })}
    </div>
  );
}

/** One subagent: what it was asked, what it does or reported, and Stop while it works (X42). */
export function AgentDetail({ row, onStop }: { row: AgentRow; onStop: () => void }) {
  const a = row.agent;
  return (
    <div className="scroll flex flex-col gap-3 px-4 pb-2">
      <div className="flex items-center gap-2">
        <StateGlyph state={AGENT_STATE[row.state].glyph} />
        <span className="min-w-0 flex-1 text-[16px] font-medium">{a.description}</span>
        <span className="font-mono text-[12.5px] text-faint tabular-nums">{row.elapsed}</span>
      </div>
      <div className={cx("text-[13px]", AGENT_STATE[row.state].text)}>
        {[AGENT_STATE[row.state].label, a.kind, a.model && modelLabel(a.model)].filter(Boolean).join(" · ")}
      </div>
      {row.line && <div className={cx("text-[13.5px]", row.line.tone === "error" ? "text-error" : row.line.tone === "muted" ? "text-muted" : "text-fg")}>{row.line.text}</div>}
      <div className="eyebrow">Prompt</div>
      <div className="selectable rounded-[10px] bg-raised px-3 py-2.5 text-[13.5px] leading-[1.45] whitespace-pre-wrap">{a.prompt}</div>
      {a.report && (
        <>
          <div className="eyebrow">Report</div>
          <Markdown text={a.report} />
        </>
      )}
      {isActive(row.state) && (
        <Btn tone="secondary" onClick={onStop}>
          Stop agent
        </Btn>
      )}
    </div>
  );
}

export function ChatBlockView({ block, cwd, agents = [], onAgent = () => {} }: { block: ChatBlock; cwd: string; agents?: AgentRow[]; onAgent?: (row: AgentRow) => void }) {
  if (block.kind === "agents") return <LaunchedCard tools={block.tools} rows={agents} onOpen={onAgent} />;
  if (block.kind === "tools") return <ToolGroup tools={block.tools} cwd={cwd} />;
  const it = block.item;
  switch (it.kind) {
    case "user":
      return <div className="selectable self-end rounded-[14px] rounded-br-[4px] bg-raised px-3.5 py-2.5 text-[14.5px] leading-[1.45] whitespace-pre-wrap">{it.text}</div>;
    case "thinking":
      return <Thinking item={it} />;
    case "tool":
      return it.tool ? <ToolRow tool={it.tool} cwd={cwd} /> : null;
    case "error":
      return <div className="rounded-[10px] border border-[rgba(239,95,95,0.3)] px-3 py-2 text-[13.5px] text-error">{it.text}</div>;
    case "system":
      return <div className="text-center text-[12.5px] text-faint">{it.text}</div>;
    default:
      return <Markdown text={it.text} />;
  }
}
