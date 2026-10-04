import { type CSSProperties, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Ban,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FilePen,
  FileText,
  Globe,
  ListTodo,
  Loader2,
  MessageCircleQuestionMark,
  MoreHorizontal,
  Search,
  ShieldAlert,
  Square,
  SquareTerminal,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { rpc } from "../lib/daemon";
import { BYPASS_MODE, CLAUDE_MODELS, CLAUDE_MODES, DEFAULT_MODE, EFFORTS, agentLabel, nextMode } from "../lib/agents";
import {
  type QuestionPick,
  activeToken,
  askQuestions,
  chatKey,
  diffStat,
  elapsed,
  fuzzyFilter,
  loadChat,
  promptHistory,
  questionAnswers,
  rememberPrompt,
  tokens,
  transcript,
  useChat,
} from "../lib/chat";
import { linkToOpen, linkToolbarPosition, openableUrl, renderChatMarkdown } from "../lib/markdown";
import { type ChatItem, type ChatState, M, type PermissionAsk, type TerminalInfo, type ToolCall } from "../lib/protocol";
import { firstWord, suggest } from "../lib/suggest";
import { errorToast, getLayout, setLayout, toast, useStore } from "../lib/store";
import { addTab, tabOf } from "../lib/layout";
import { chatScale } from "../lib/terminals";
import { Menu, type MenuItem } from "./Menu";
import { ModeMenu, useModeMenu } from "./ModeMenu";
import { AgentIcon, Button, cx, inputCls } from "./ui";

// ------------------------------------------------------------ messages

/** Paths inside the session's worktree are shown relative to it. */
function rel(text: string, cwd: string): string {
  return cwd.length > 1 ? text.split(cwd + "/").join("") : text;
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderChatMarkdown(text), [text]);
  const [link, setLink] = useState<{ url: string; rect: DOMRect } | null>(null);
  const hideTimer = useRef<number>(undefined);
  const keep = () => window.clearTimeout(hideTimer.current);
  const hide = () => {
    keep();
    hideTimer.current = window.setTimeout(() => setLink(null), 150);
  };
  useEffect(() => {
    if (!link) return;
    // The toolbar is fixed; any scroll would leave it behind.
    const close = () => setLink(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [link]);
  useEffect(() => keep, []);
  // New text replaces the anchors, so a stored URL may no longer be shown.
  useEffect(() => setLink(null), [html]);
  const open = (url: string) => void openUrl(url).catch(errorToast);
  const anchorOf = (e: React.MouseEvent) => (e.target as HTMLElement).closest("a");
  return (
    <>
      <div
        className="chat-md selectable"
        // Sanitized: markdown-it with HTML disabled, then DOMPurify.
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={(e) => {
          const a = anchorOf(e);
          if (!a) return;
          // Links never navigate the app window; ⌘-click or Enter (a click
          // with detail 0) opens the browser.
          e.preventDefault();
          const url = linkToOpen(a.getAttribute("href"), { metaKey: e.metaKey, keyboard: e.detail === 0 });
          if (url) open(url);
        }}
        onMouseOver={(e) => {
          const a = anchorOf(e);
          const url = a && openableUrl(a.getAttribute("href"));
          if (!a || !url) return;
          keep();
          setLink({ url, rect: a.getBoundingClientRect() });
        }}
        onMouseOut={(e) => {
          const a = anchorOf(e);
          if (a && !a.contains(e.relatedTarget as Node | null)) hide();
        }}
      />
      {link &&
        createPortal(
          <div
            className="fixed z-[60] flex items-center gap-0.5 rounded-lg border border-border-strong bg-[#232323] p-0.5 shadow-2xl"
            style={linkToolbarPosition(link.rect, { width: window.innerWidth, height: window.innerHeight })}
            onMouseEnter={keep}
            onMouseLeave={hide}
          >
            <button
              title="Open in browser (⌘-click)"
              className="flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg"
              onClick={() => {
                open(link.url);
                setLink(null);
              }}
            >
              <ExternalLink size={13} />
            </button>
            <button
              title="Copy link"
              className="flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg"
              onClick={() => {
                navigator.clipboard.writeText(link.url).then(() => {
                  toast("Copied link");
                  setLink(null);
                }, errorToast);
              }}
            >
              <Copy size={13} />
            </button>
          </div>,
          document.body,
        )}
    </>
  );
});

function toolIcon(name: string) {
  const n = name.toLowerCase();
  if (n === "bash" || n === "shell") return Terminal;
  if (n === "read") return FileText;
  if (["edit", "write", "multiedit", "notebookedit"].includes(n)) return FilePen;
  if (n === "grep" || n === "glob") return Search;
  if (n.startsWith("web")) return Globe;
  if (n === "task" || n === "agent") return Bot;
  if (n === "todowrite") return ListTodo;
  if (n === "askuserquestion") return MessageCircleQuestionMark;
  return Wrench;
}

export function StatusMark({ status }: { status: ToolCall["status"] }) {
  if (status === "running") return <Loader2 size={13} className="spin text-muted" />;
  if (status === "ok") return <Check size={13} className="text-faint" />;
  if (status === "denied") return <Ban size={13} className="text-blocked" />;
  return <X size={13} className="text-error" />;
}

export function DiffBlock({ diff }: { diff: string }) {
  return (
    <pre className="selectable max-h-[340px] overflow-auto rounded-md border border-border bg-[#161616] py-1.5 font-mono chat-text-12 leading-[1.55]">
      {diff.replace(/\n$/, "").split("\n").map((l, i) => {
        if (l.startsWith("---") || l.startsWith("+++")) return null;
        const cls = l.startsWith("+") ? "bg-[#14301d] text-[#9fe0b0]" : l.startsWith("-") ? "bg-[#3a1719] text-[#f2a7a7]" : l.startsWith("@@") ? "text-faint" : "text-muted";
        return (
          <div key={i} className={cx("whitespace-pre-wrap break-all px-3", cls)}>
            {l || " "}
          </div>
        );
      })}
    </pre>
  );
}

export function ToolRow({ tool, cwd }: { tool: ToolCall; cwd: string }) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(tool.name);
  const stat = tool.diff ? diffStat(tool.diff) : null;
  const expandable = !!(tool.diff || tool.output);
  return (
    <div className="group">
      <button
        className={cx("flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left chat-text-13", expandable && "hover:bg-hover")}
        onClick={() => expandable && setOpen(!open)}
      >
        <Icon size={14} className="shrink-0 text-muted" />
        <span className="shrink-0 font-medium text-fg">{tool.name}</span>
        <span className={cx("min-w-0 truncate font-mono chat-text-12.5", tool.status === "denied" ? "text-faint line-through" : "text-muted")}>{rel(tool.summary, cwd)}</span>
        {stat && (stat.add > 0 || stat.del > 0) && (
          <span className="shrink-0 font-mono chat-text-12">
            <span className="text-add">+{stat.add}</span> <span className="text-del">−{stat.del}</span>
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {expandable && (open ? <ChevronDown size={13} className="text-faint" /> : <ChevronRight size={13} className="text-faint opacity-0 group-hover:opacity-100" />)}
          <StatusMark status={tool.status} />
        </span>
      </button>
      {open && (
        <div className="mb-2 ml-6 mt-1">
          {tool.diff ? (
            <DiffBlock diff={tool.diff} />
          ) : (
            <pre className="selectable max-h-[300px] overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-[#161616] px-3 py-2 font-mono chat-text-12 leading-[1.5] text-muted">
              {tool.output?.trim() || "(no output)"}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function Thinking({ item }: { item: ChatItem }) {
  const [open, setOpen] = useState(false);
  if (item.partial) return <div className="chat-shimmer px-2 py-1 chat-text-13">Thinking…</div>;
  if (!item.text.trim()) return null;
  return (
    <div>
      <button className="flex items-center gap-1.5 rounded-md px-2 py-1 chat-text-13 text-faint hover:text-muted" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Thought
      </button>
      {open && <div className="selectable ml-6 whitespace-pre-wrap border-l border-border pl-3 chat-text-13 italic leading-relaxed text-muted">{item.text}</div>}
    </div>
  );
}

export const ChatItemView = memo(function Item({ item, cwd }: { item: ChatItem; cwd: string }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex justify-end py-1">
          <div className="selectable max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-raised px-3.5 py-2 chat-text-14 leading-relaxed">{item.text}</div>
        </div>
      );
    case "assistant":
      return item.text ? (
        <div className="px-2 py-1">
          <Markdown text={item.text} />
        </div>
      ) : null;
    case "thinking":
      return <Thinking item={item} />;
    case "tool":
      return item.tool ? <ToolRow tool={item.tool} cwd={cwd} /> : null;
    case "error":
      return <div className="selectable my-1 whitespace-pre-wrap rounded-md border border-[#5a2a2e] bg-[#2a1416] px-3 py-2 chat-text-13 text-[#f2a7a7]">{item.text}</div>;
    default:
      return <div className="py-1 text-center chat-text-12 text-faint">{item.text}</div>;
  }
});

/** An AskUserQuestion with questions we can render; anything else gets the plain card. */
const isQuestion = (ask: PermissionAsk) => ask.tool === "AskUserQuestion" && askQuestions(ask.input).length > 0;

export function PermissionCard({ ask, cwd, onAnswer }: { ask: PermissionAsk; cwd: string; onAnswer: (decision: "allow" | "always" | "deny") => void }) {
  const Icon = toolIcon(ask.tool);
  const detail = ask.diff || ["Bash", "Write", "Edit", "MultiEdit", "Read"].includes(ask.tool) ? null : JSON.stringify(ask.input, null, 2);
  return (
    <div className="jaunt-card-in my-2 rounded-xl border border-[#5c4a1e] bg-[#1d1a12] p-3">
      <div className="mb-2 flex items-center gap-2 chat-text-13">
        <ShieldAlert size={15} className="text-blocked" />
        <span className="font-medium">Allow {ask.tool}?</span>
      </div>
      <div className="mb-2 flex min-w-0 items-start gap-2 rounded-md bg-[#141414] px-2.5 py-2">
        <Icon size={14} className="mt-[2px] shrink-0 text-muted" />
        <code className="selectable min-w-0 whitespace-pre-wrap break-all font-mono chat-text-12.5 text-fg">{rel(ask.summary, cwd) || ask.tool}</code>
      </div>
      {ask.diff && (
        <div className="mb-2">
          <DiffBlock diff={ask.diff} />
        </div>
      )}
      {detail && detail !== "{}" && <pre className="selectable mb-2 max-h-40 overflow-auto rounded-md bg-[#141414] px-2.5 py-2 font-mono chat-text-11.5 text-muted">{detail}</pre>}
      {ask.reason && !ask.summary.endsWith(ask.reason) && <div className="mb-2 chat-text-12.5 text-muted">{ask.reason}</div>}
      <div className="flex gap-1.5">
        <Button variant="primary" onClick={() => onAnswer("allow")}>
          Allow
        </Button>
        {ask.can_always && <Button onClick={() => onAnswer("always")}>Always allow</Button>}
        <Button variant="ghost" className="ml-auto" onClick={() => onAnswer("deny")}>
          Deny
        </Button>
      </div>
    </div>
  );
}

/** Claude's AskUserQuestion: pick options or type an answer, then Submit. */
export function QuestionCard({ ask, onAnswer }: { ask: PermissionAsk; onAnswer: (decision: "allow" | "deny", answers?: Record<string, string>) => void }) {
  const qs = useMemo(() => askQuestions(ask.input), [ask.input]);
  const [picks, setPicks] = useState<QuestionPick[]>(() => qs.map(() => ({ labels: [], other: "" })));
  const answers = questionAnswers(qs, picks);
  const set = (i: number, p: Partial<QuestionPick>) => setPicks((ps) => ps.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const pick = (i: number, label: string) => {
    const q = qs[i];
    const cur = picks[i].labels;
    if (!q.multiSelect) return set(i, { labels: [label], other: "" });
    // Keep the options' order.
    set(i, { labels: q.options.map((o) => o.label).filter((l) => (l === label ? !cur.includes(l) : cur.includes(l))) });
  };
  return (
    <div className="jaunt-card-in my-2 rounded-xl border border-[#5c4a1e] bg-[#1d1a12] p-3">
      <div className="mb-2 flex items-center gap-2 chat-text-13">
        <MessageCircleQuestionMark size={15} className="text-blocked" />
        <span className="font-medium">{qs.length > 1 ? `${agentLabel("claude")} has ${qs.length} questions` : `${agentLabel("claude")} has a question`}</span>
      </div>
      {qs.map((q, i) => (
        <div key={i} className="mb-3">
          <div className="mb-1.5 flex items-start gap-2">
            {q.header && <span className="mt-[1px] shrink-0 rounded bg-[#141414] px-1.5 py-0.5 chat-text-11 text-muted">{q.header}</span>}
            <span className="selectable chat-text-13 text-fg">{q.question}</span>
          </div>
          <div className="flex flex-col gap-1">
            {q.options.map((o) => {
              const on = picks[i].labels.includes(o.label);
              return (
                <button
                  key={o.label}
                  aria-pressed={on}
                  className={cx(
                    "flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors",
                    on ? "border-accent bg-hover" : "border-border-strong bg-[#141414] hover:bg-hover",
                  )}
                  onClick={() => pick(i, o.label)}
                >
                  <span
                    className={cx(
                      "mt-[3px] flex h-3 w-3 shrink-0 items-center justify-center border",
                      q.multiSelect ? "rounded-[3px]" : "rounded-full",
                      on ? "border-accent bg-accent" : "border-border-strong",
                    )}
                  >
                    {on && q.multiSelect && <Check size={9} className="text-bg" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block chat-text-12.5 text-fg">{o.label}</span>
                    {o.description && <span className="block chat-text-12 text-muted">{o.description}</span>}
                  </span>
                </button>
              );
            })}
            <input
              className={inputCls}
              value={picks[i].other}
              placeholder="Other…"
              aria-label={`Other answer: ${q.question}`}
              onChange={(e) => set(i, q.multiSelect ? { other: e.target.value } : { other: e.target.value, labels: [] })}
              onKeyDown={(e) => e.key === "Enter" && answers && onAnswer("allow", answers)}
            />
          </div>
        </div>
      ))}
      <div className="flex gap-1.5">
        <Button variant="primary" disabled={!answers} onClick={() => answers && onAnswer("allow", answers)}>
          Submit
        </Button>
        <Button variant="ghost" className="ml-auto" onClick={() => onAnswer("deny")}>
          Skip
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ editor

const fileCache = new Map<string, Promise<string[]>>();
function projectFiles(host: string, root: string): Promise<string[]> {
  const key = `${host}|${root}`;
  let p = fileCache.get(key);
  if (!p) {
    p = rpc<string[]>(host, M.fsFiles, { root }).catch(() => [] as string[]);
    fileCache.set(key, p);
    // Refresh on the next use after a while.
    setTimeout(() => fileCache.delete(key), 30_000);
  }
  return p;
}

function ChatEditor({
  host,
  root,
  commands,
  working,
  focused,
  onSend,
  onStop,
  onCycleMode,
  scale,
}: {
  host: string;
  root: string;
  commands: string[];
  working: boolean;
  focused: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  /** Shift+Tab; absent for agents without a permission mode. */
  onCycleMode?: () => void;
  /** Text scale (see chatScale): the height is re-measured when it changes. */
  scale: number;
}) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [files, setFiles] = useState<string[] | null>(null);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [walk, setWalk] = useState<number | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const history = promptHistory();

  useEffect(() => {
    if (focused) ta.current?.focus();
  }, [focused]);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 260) + "px";
  }, [text, scale]);

  const token = activeToken(text, caret);
  useEffect(() => {
    if (token?.kind === "@" && files === null) void projectFiles(host, root).then(setFiles);
  }, [token?.kind, files, host, root]);

  const options = useMemo(() => {
    if (!token || dismissed === token.start) return [];
    if (token.kind === "/") return fuzzyFilter(commands, token.query, 8).map((c) => "/" + c);
    return fuzzyFilter(files ?? [], token.query, 8).map((f) => "@" + f);
  }, [token, dismissed, commands, files]);
  useEffect(() => setSel(0), [options.length, token?.query]);

  const ghost = !options.length && walk === null && !text.includes("\n") ? suggest(history, text) : null;

  const set = (v: string, pos = v.length) => {
    setText(v);
    setCaret(pos);
    requestAnimationFrame(() => ta.current?.setSelectionRange(pos, pos));
  };

  const accept = (choice: string) => {
    if (!token) return;
    const before = text.slice(0, token.start) + choice + " ";
    set(before + text.slice(caret), before.length);
  };

  const send = () => {
    const t = text.trim();
    if (!t) return;
    rememberPrompt(t);
    onSend(t);
    setText("");
    setCaret(0);
    setWalk(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    const el = e.currentTarget;
    if (options.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => (s + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
        return;
      }
      if ((e.key === "Tab" && !e.shiftKey) || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        accept(options[sel]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(token?.start ?? null);
        return;
      }
    }
    if (e.key === "." && e.metaKey) {
      e.preventDefault();
      onStop();
    } else if (e.key === "Tab" && e.shiftKey && onCycleMode) {
      e.preventDefault();
      onCycleMode();
    } else if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      send();
    } else if ((e.key === "Tab" || (e.key === "ArrowRight" && el.selectionStart === text.length)) && ghost) {
      e.preventDefault();
      set(text + (e.key === "ArrowRight" && e.altKey ? firstWord(ghost) : ghost));
    } else if (e.key === "ArrowUp" && !el.value.slice(0, el.selectionStart).includes("\n") && (text === "" || walk !== null)) {
      e.preventDefault();
      const next = walk === null ? history.length - 1 : walk - 1;
      if (next >= 0) {
        setWalk(next);
        set(history[next]);
      }
    } else if (e.key === "ArrowDown" && walk !== null && !el.value.slice(el.selectionEnd).includes("\n")) {
      e.preventDefault();
      const next = walk + 1;
      if (next >= history.length) {
        setWalk(null);
        set("");
      } else {
        setWalk(next);
        set(history[next]);
      }
    } else if (e.key === "Escape" && working && !text) {
      e.preventDefault();
      onStop();
    }
  };

  return (
    <div className="relative">
      {options.length > 0 && (
        <div className="absolute bottom-full left-0 z-30 mb-2 w-full max-w-[520px] overflow-hidden rounded-xl border border-border-strong bg-[#232323] p-1 shadow-2xl">
          {options.map((o, i) => (
            <button
              key={o}
              className={cx("flex w-full items-center gap-2 truncate rounded-md px-2.5 py-1.5 text-left font-mono chat-text-12.5", i === sel ? "bg-hover text-fg" : "text-muted")}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(o);
              }}
            >
              {o.startsWith("@") ? <FileText size={13} className="shrink-0 text-faint" /> : <SquareTerminal size={13} className="shrink-0 text-faint" />}
              <span className="truncate">{o}</span>
            </button>
          ))}
        </div>
      )}
      <div className="relative rounded-xl border border-border-strong bg-panel px-3.5 py-2.5 focus-within:border-[#3a3a3a]">
        <div className="relative chat-text-14 leading-[1.5]">
          <div aria-hidden className="pointer-events-none absolute inset-0 whitespace-pre-wrap break-words text-transparent">
            {text}
            {ghost && <span className="text-faint">{ghost}</span>}
          </div>
          <textarea
            ref={ta}
            rows={1}
            spellCheck={false}
            value={text}
            placeholder={working ? "Queue a message…" : "Ask for a change, @ to mention a file, / for commands"}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart);
              setDismissed(null);
              if (walk !== null) setWalk(null);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            className="relative block w-full resize-none overflow-y-auto whitespace-pre-wrap break-words bg-transparent text-fg caret-accent outline-none placeholder:text-faint"
          />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ view

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

async function openInTerminal(host: string, info: TerminalInfo, st: ChatState) {
  const id = st.agent_session;
  if (!id) {
    toast("The conversation has not started yet");
    return;
  }
  // The TUI starts in the mode the footer shows (X7).
  const mode = st.mode && [...CLAUDE_MODES.map((m) => m.id), BYPASS_MODE.id].includes(st.mode) ? ["--permission-mode", st.mode] : [];
  const command = info.agent === "codex" ? ["codex", "resume", id] : ["claude", "--resume", id, ...mode];
  try {
    const t = await rpc<TerminalInfo>(host, M.terminalCreate, {
      cwd: info.cwd,
      session_id: info.session_id,
      kind: "agent",
      agent: info.agent,
      title: `${info.agent} (TUI)`,
      command,
      cols: 120,
      rows: 32,
    });
    if (info.session_id) {
      const layout = getLayout(host, info.session_id);
      const existing = tabOf(layout, t.id);
      setLayout(host, info.session_id, existing ? { ...layout, active: existing.id, focused: t.id } : addTab(layout, t.id));
    }
  } catch (e) {
    errorToast(e);
  }
}

export function AgentView({ host, id, wsId, focused, visible }: { host: string; id: number; wsId: string; focused: boolean; visible: boolean }) {
  const info = useStore((s) => s.terminals[host]?.[id]);
  const st = useChat((s) => s.chats[chatKey(host, id)]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const scale = useStore((s) => chatScale(s.settings.term.fontSize));

  useEffect(() => {
    if (!st) void loadChat(host, id).catch(errorToast);
  }, [host, id, st]);

  const working = st?.status === "working" || st?.status === "blocked";
  const now = useNow(working && visible);

  // Follow new output while the view is scrolled to the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [st?.items, st?.pending, visible]);

  const call = (method: string, params: object) => rpc(host, method, { id, ...params }).catch(errorToast);
  const send = (text: string) => {
    stick.current = true;
    void call(M.chatSend, { text });
  };
  const stop = () => void call(M.chatInterrupt, {});

  const agent = info?.agent ?? "claude";
  const modelLabel = agent === "claude" ? (CLAUDE_MODELS.find((m) => m.id === st?.model)?.label ?? st?.model ?? "Default") : (st?.model ?? "Default");
  const effortLabel = EFFORTS.find((e) => e.id === st?.effort)?.label;
  const settings: MenuItem[] = [
    ...(agent === "claude"
      ? [{ kind: "label" as const, label: "Model" }, ...CLAUDE_MODELS.map((m) => ({ label: m.label, checked: st?.model === m.id, onSelect: () => void call(M.chatSettings, { model: m.id }) }))]
      : []),
    { kind: "label", label: "Effort" },
    ...EFFORTS.filter((e) => agent === "claude" || ["low", "medium", "high"].includes(e.id)).map((e) => ({
      label: e.label,
      checked: st?.effort === e.id,
      onSelect: () => void call(M.chatSettings, { effort: e.id }),
    })),
  ];
  const modeMenu = useModeMenu(st?.mode ?? DEFAULT_MODE, (m) => void call(M.chatSettings, { mode: m }));
  const more: MenuItem[] = [
    { label: "Open in terminal", icon: <SquareTerminal size={14} />, onSelect: () => info && st && void openInTerminal(host, info, st) },
    {
      label: "Copy transcript",
      icon: <Copy size={14} />,
      onSelect: () => st && void navigator.clipboard.writeText(transcript(st.items)).then(() => toast("Copied transcript")),
    },
  ];

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden bg-bg chat-text-13.5"
      style={{ "--chat-scale": scale } as CSSProperties}
      onMouseDown={() => {
        const l = getLayout(host, wsId);
        if (l.focused !== id) setLayout(host, wsId, { ...l, focused: id });
      }}
    >
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        <div className="mx-auto flex max-w-[820px] flex-col gap-0.5 px-6 pb-4 pt-5">
          {!st ? (
            <div className="py-10 text-center chat-text-13 text-faint">Loading conversation…</div>
          ) : st.items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-muted">
              <AgentIcon agent={agent} size={22} />
              <div className="chat-text-14">{agentLabel(agent)} is ready</div>
              <div className="chat-text-12.5 text-faint">Describe a change, mention files with @, or run a / command.</div>
            </div>
          ) : (
            st.items.map((it) => <ChatItemView key={it.id} item={it} cwd={info?.cwd ?? ""} />)
          )}
          {st?.pending.map((ask) =>
            isQuestion(ask) ? (
              <QuestionCard
                key={ask.id}
                ask={ask}
                onAnswer={(decision, answers) => {
                  stick.current = true;
                  void call(M.chatPermission, { ask: ask.id, decision, answers, message: answers ? undefined : "The user declined to answer the questions." });
                }}
              />
            ) : (
              <PermissionCard
                key={ask.id}
                ask={ask}
                cwd={info?.cwd ?? ""}
                onAnswer={(decision) => {
                  stick.current = true;
                  void call(M.chatPermission, { ask: ask.id, decision });
                }}
              />
            ),
          )}
        </div>
      </div>
      <div className="mx-auto w-full max-w-[820px] shrink-0 px-6 pb-4">
        <div className="mb-1.5 flex h-6 items-center gap-2 px-1 chat-text-12 text-muted">
          {st?.status === "working" ? (
            <>
              <Loader2 size={12} className="spin text-accent" />
              <span className="chat-shimmer">Working</span>
              {st.turn_started_at && <span className="text-faint">{elapsed(now - st.turn_started_at)}</span>}
              <span className="text-faint">· esc to stop</span>
            </>
          ) : st?.status === "blocked" ? (
            <>
              <ShieldAlert size={12} className="text-blocked" />
              <span>{st.pending.length > 0 && st.pending.every(isQuestion) ? "Waiting for your answer" : "Waiting for your approval"}</span>
            </>
          ) : st && (st.cost_usd > 0 || st.input_tokens > 0) ? (
            <span className="text-faint">
              {st.cost_usd > 0 && `$${st.cost_usd.toFixed(st.cost_usd < 1 ? 3 : 2)} · `}
              {tokens(st.input_tokens)} in · {tokens(st.output_tokens)} out
            </span>
          ) : null}
          <span className="ml-auto flex items-center gap-0.5">
            {working && (
              <Button size="sm" variant="ghost" onClick={stop} title="Stop (⌘.)">
                <Square size={10} fill="currentColor" /> Stop
              </Button>
            )}
            {agent === "claude" && <ModeMenu menu={modeMenu} className="h-6 px-2" iconSize={12} />}
            <Menu
              side="top"
              align="right"
              width={200}
              items={settings}
              trigger={(open) => (
                <button className="flex h-6 items-center gap-1.5 rounded-md px-2 hover:bg-hover hover:text-fg" onClick={open}>
                  <AgentIcon agent={agent} size={12} />
                  <span>{modelLabel}</span>
                  {effortLabel && <span className="text-faint">{effortLabel}</span>}
                  <ChevronDown size={12} />
                </button>
              )}
            />
            <Menu
              side="top"
              align="right"
              width={200}
              items={more}
              trigger={(open) => (
                <button title="More" className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-hover hover:text-fg" onClick={open}>
                  <MoreHorizontal size={14} />
                </button>
              )}
            />
          </span>
        </div>
        <ChatEditor
          host={host}
          root={info?.cwd ?? "/"}
          commands={st?.slash_commands ?? []}
          working={working}
          focused={focused && visible}
          onSend={send}
          onStop={stop}
          onCycleMode={agent === "claude" ? () => modeMenu.pick(nextMode(modeMenu.mode, modeMenu.bypassOn)) : undefined}
          scale={scale}
        />
      </div>
    </div>
  );
}
