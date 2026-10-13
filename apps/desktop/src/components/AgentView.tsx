import { type Ref, createContext, memo, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Ban,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Copy,
  CornerDownLeft,
  ExternalLink,
  FilePen,
  FileText,
  Globe,
  Image as ImageIcon,
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
import { BYPASS_MODE, CLAUDE_MODELS, CLAUDE_MODES, DEFAULT_MODE, EFFORTS, type PlanApproveMode, agentLabel, nextMode, resolvePlanMode } from "../lib/agents";
import {
  type QuestionPick,
  activeToken,
  askQuestions,
  chatBlocks,
  chatDraft,
  chatKey,
  costLine,
  diffStat,
  elapsed,
  fuzzyFilter,
  joinDraft,
  loadChat,
  type PlanChoice,
  planAnswer,
  planApproveLabel,
  planOf,
  promptHistory,
  questionAnswers,
  rememberPrompt,
  saveChatDraft,
  thinkingPreview,
  toolCommand,
  toolGroupLabel,
  toolGroupStatus,
  transcript,
  turnFooter,
  turnRunning,
  useChat,
} from "../lib/chat";
import { diffRows } from "../lib/codeHighlight";
import { type OutputView, type Tone, toolOutputView } from "../lib/toolOutput";
import { fileToOpen, linkToOpen, linkToolbarPosition, openableUrl, renderChatMarkdown } from "../lib/markdown";
import { openFileTab } from "../lib/actions";
import { type ChatItem, type ChatState, M, type PermissionAsk, type TerminalInfo, type ToolCall, type TurnTime } from "../lib/protocol";
import { firstWord, suggest } from "../lib/suggest";
import { canMentionFiles, fileMention, isAttachShortcut, withMention, withSlashCommand } from "../lib/plusMenu";
import { type ChatImage, base64, splitAttachments } from "../lib/attachments";
import { callbackForward, isWebPage, pagesToOpen } from "../lib/oauthRedirect";
import { invoke } from "@tauri-apps/api/core";
import { errorToast, getLayout, setLayout, termKey, toast, useStore } from "../lib/store";
import { signInFor } from "../lib/profiles";
import { addTab, tabOf } from "../lib/layout";
import { type PlanView, planLabels, planView } from "../lib/plan";
import { uiScale } from "../lib/uiScale";
import { type ContextFiles, chatContextFiles, chipSection, newChatContext, otherChats, planContextFiles } from "../lib/chatContext";
import { shortPath } from "../lib/terminals";
import { ContextMeter } from "./ContextMeter";
import { Menu, type MenuItem } from "./Menu";
import { ModeMenu, useModeMenu } from "./ModeMenu";
import { PlusMenu } from "./PlusMenu";
import { AgentIcon, Button, cx, inputCls } from "./ui";
import { ClaudeAuthDialog } from "./Profiles";

// ------------------------------------------------------------ messages

/** Paths inside the session's worktree are shown relative to it. */
function rel(text: string, cwd: string): string {
  return cwd.length > 1 ? text.split(cwd + "/").join("") : text;
}

/** Where a file link in a message opens (X30): the main window's editor tabs, under the agent's worktree. */
export const FileLinks = createContext<{ host: string; wsId: string; cwd: string; exists: (path: string) => boolean } | null>(null);

/**
 * Whether a project-relative path is a file in `root` (X30), from the
 * daemon's list of non-ignored files. Nothing exists until the list loads;
 * a change of `reloadWhen` loads it again, so files an agent creates show up.
 */
export function useProjectFiles(host: string, root: string, reloadWhen: unknown): (path: string) => boolean {
  const [files, setFiles] = useState<Set<string> | null>(null);
  const loaded = useRef(false);
  useEffect(() => {
    if (!root) return;
    let live = true;
    // The first load may reuse the @ list; later ones look at the disk again.
    void projectFiles(host, root, loaded.current).then((list) => live && setFiles(new Set(list)));
    loaded.current = true;
    return () => {
      live = false;
    };
  }, [host, root, reloadWhen]);
  return useMemo(() => (path: string) => !!files?.has(path), [files]);
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const files = useContext(FileLinks);
  const html = useMemo(() => renderChatMarkdown(text, files?.exists), [text, files?.exists]);
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
          if (a.hasAttribute("data-file")) {
            // A file opens on a plain click (X30).
            const link = { file: a.getAttribute("data-file"), line: a.getAttribute("data-line") };
            const target = files && fileToOpen(link, files.cwd, { selecting: window.getSelection()?.isCollapsed === false });
            if (target) openFileTab(files.host, files.wsId, target.path, target.line);
            return;
          }
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
  if (n === "exitplanmode") return ClipboardList;
  return Wrench;
}

export function StatusMark({ status }: { status: ToolCall["status"] }) {
  if (status === "running") return <Loader2 size={13} className="spin text-muted" />;
  if (status === "ok") return <Check size={13} className="text-faint" />;
  if (status === "denied") return <Ban size={13} className="text-blocked" />;
  return <X size={13} className="text-error" />;
}

const DIFF_ROW = {
  add: { sign: "+", cls: "bg-[#14301d] text-[#9fe0b0]" },
  del: { sign: "-", cls: "bg-[#3a1719] text-[#f2a7a7]" },
  context: { sign: " ", cls: "text-muted" },
  hunk: { sign: "", cls: "text-faint" },
};

function DiffLines({ diff }: { diff: string }) {
  const rows = useMemo(() => diffRows(diff), [diff]);
  return rows.map((r, i) => (
    <div key={i} className={cx("whitespace-pre-wrap break-all px-3", DIFF_ROW[r.kind].cls)}>
      {DIFF_ROW[r.kind].sign}
      {/* Escaped by diffRows; only highlight.js spans remain. */}
      <span dangerouslySetInnerHTML={{ __html: r.html || (r.kind === "hunk" ? " " : "") }} />
    </div>
  ));
}

export function DiffBlock({ diff }: { diff: string }) {
  return (
    <pre className="code-hl selectable max-h-[340px] overflow-auto rounded-md border border-border bg-[#161616] py-1.5 font-mono ui-text-12 leading-[1.55]">
      <DiffLines diff={diff} />
    </pre>
  );
}

const TONE: Record<Tone, string> = { add: "text-add", del: "text-del", dim: "text-faint", error: "text-error", warn: "text-blocked", ok: "text-add" };

/** A shell or Grep call's output, coloured by its shape (X18). */
function CommandOutput({ output, view }: { output: string; view: OutputView }) {
  if (!view) return output.trim() || "(no output)";
  if (view.kind === "diff") return <div className="-mx-3"><DiffLines diff={view.diff} /></div>;
  if (view.kind === "code") {
    // Escaped by highlight.js; only its spans remain.
    return view.html.map((html, i) => <div key={i} dangerouslySetInnerHTML={{ __html: html || " " }} />);
  }
  return view.lines.map((line, i) => (
    <div key={i}>
      {line.map((seg, j) => (seg.tone ? <span key={j} className={TONE[seg.tone]}>{seg.text}</span> : seg.text))}
      {line.every((seg) => !seg.text) && " "}
    </div>
  ));
}

/** A Read's numbered lines with the numbers in a gutter and the code coloured (X17). */
function ReadBlock({ rows }: { rows: { n: number; html: string }[] }) {
  return (
    <pre className="code-hl selectable max-h-[300px] overflow-auto rounded-md border border-border bg-[#161616] py-2 font-mono ui-text-12 leading-[1.5] text-muted">
      {rows.map((r) => (
        <div key={r.n} className="flex">
          <span className="w-12 shrink-0 select-none pr-3 text-right text-faint">{r.n}</span>
          {/* Escaped by readRows; only highlight.js spans remain. */}
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-3" dangerouslySetInnerHTML={{ __html: r.html }} />
        </div>
      ))}
    </pre>
  );
}

export function ToolRow({ tool, cwd }: { tool: ToolCall; cwd: string }) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(tool.name);
  const stat = tool.diff ? diffStat(tool.diff) : null;
  const command = toolCommand(tool);
  const plan = planOf({ tool: tool.name, input: tool.input });
  const expandable = !!(tool.diff || tool.output || command || plan);
  const view = useMemo(() => (open ? toolOutputView(tool) : null), [open, tool]);
  return (
    <div className="group">
      <button
        className={cx("flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left ui-text-13", expandable && "hover:bg-hover")}
        onClick={() => expandable && setOpen(!open)}
      >
        <Icon size={14} className="shrink-0 text-muted" />
        <span className="shrink-0 font-medium text-fg">{tool.name}</span>
        <span className={cx("min-w-0 truncate font-mono ui-text-12.5", tool.status === "denied" ? "text-faint line-through" : "text-muted")}>{rel(tool.summary, cwd)}</span>
        {stat && (stat.add > 0 || stat.del > 0) && (
          <span className="shrink-0 font-mono ui-text-12">
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
          ) : plan ? (
            <>
              <div className="max-h-[420px] overflow-auto rounded-md border border-border bg-[#161616] px-3 py-2">
                <Markdown text={plan.plan} />
              </div>
              {tool.output?.trim() && (
                <pre className="selectable mt-1 max-h-[300px] overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-[#161616] px-3 py-2 font-mono ui-text-12 leading-[1.5] text-muted">
                  {tool.output.trim()}
                </pre>
              )}
            </>
          ) : view?.kind === "read" ? (
            <ReadBlock rows={view.rows} />
          ) : (
            <div className="overflow-hidden rounded-md border border-border bg-[#161616] font-mono ui-text-12 leading-[1.5]">
              {command && (
                <pre className={cx("selectable max-h-[200px] overflow-auto whitespace-pre-wrap break-all px-3 py-2 text-fg", (tool.output || tool.status !== "running") && "border-b border-border")}>
                  <span className="select-none text-faint">$ </span>
                  {command}
                </pre>
              )}
              {(tool.output || tool.status !== "running") && (
                <pre className="code-hl selectable max-h-[300px] overflow-auto whitespace-pre-wrap break-all px-3 py-2 text-muted">
                  <CommandOutput output={tool.output ?? ""} view={view} />
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A thought, shown in full: it carries the agent's reasoning. Click to fold it to one line. */
export function Thinking({ item }: { item: ChatItem }) {
  const [open, setOpen] = useState(true);
  if (item.partial) return <div className="chat-shimmer px-2 py-1 ui-text-13">Thinking…</div>;
  if (!item.text.trim()) return null;
  return (
    <div className="group">
      <button aria-expanded={open} className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left ui-text-13 hover:bg-hover" onClick={() => setOpen(!open)}>
        <Brain size={14} className="shrink-0 text-muted" />
        <span className="shrink-0 font-medium text-fg">Thinking</span>
        {!open && <span className="min-w-0 truncate text-muted">{thinkingPreview(item.text)}</span>}
        <span className="ml-auto flex shrink-0 items-center">
          {open ? <ChevronDown size={13} className="text-faint opacity-0 group-hover:opacity-100" /> : <ChevronRight size={13} className="text-faint" />}
        </span>
      </button>
      {open && <div className="selectable mb-2 ml-6 mt-1 whitespace-pre-wrap border-l border-border pl-3 ui-text-13 italic leading-relaxed text-muted">{item.text}</div>}
    </div>
  );
}

/** A run of tool calls folded into one row (X14); click to show the calls. */
export function ToolGroup({ tools, cwd }: { tools: ChatItem[]; cwd: string }) {
  const [open, setOpen] = useState(false);
  const status = toolGroupStatus(tools);
  const icons = [...new Set(tools.map((t) => toolIcon(t.tool?.name ?? "")))].slice(0, 4);
  return (
    <div>
      <button aria-expanded={open} className="flex items-center gap-1.5 rounded-md px-2 py-1 ui-text-13 text-muted hover:text-fg" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span>{toolGroupLabel(tools.length)}</span>
        {icons.map((Icon, i) => (
          <Icon key={i} size={13} className="text-faint" />
        ))}
        {status !== "ok" && <StatusMark status={status} />}
      </button>
      {open && (
        <div className="ml-2">
          {tools.map((t) => t.tool && <ToolRow key={t.id} tool={t.tool} cwd={cwd} />)}
        </div>
      )}
    </div>
  );
}

/** Response time, end time and copy under a turn's final message (X16). */
function TurnFooter({ turn, text }: { turn: TurnTime; text: string }) {
  return (
    <div className="mt-1.5 flex items-center gap-1.5 ui-text-12 text-faint">
      <span>{turnFooter(turn, Date.now())}</span>
      <button
        title="Copy final message"
        aria-label="Copy final message"
        className="flex h-5 w-5 items-center justify-center rounded-md hover:bg-hover hover:text-fg"
        onClick={() => void navigator.clipboard.writeText(text).then(() => toast("Copied message"), errorToast)}
      >
        <Copy size={12} />
      </button>
    </div>
  );
}

/** An agent's error. A failed login offers Sign in… for the workspace's Claude profile (X33). */
function ErrorItem({ item }: { item: ChatItem }) {
  const where = useContext(FileLinks);
  const host = where?.host ?? "";
  const ws = useStore((s) => s.workspaces[host]?.find((w) => w.id === where?.wsId));
  const profiles = useStore((s) => s.profiles[host]);
  const [auth, setAuth] = useState(false);
  const signIn = where ? signInFor(item, ws, profiles ?? []) : null;
  return (
    <div className="my-1 flex items-start gap-3 rounded-md border border-[#5a2a2e] bg-[#2a1416] px-3 py-2 ui-text-13 text-[#f2a7a7]">
      <div className="selectable min-w-0 flex-1 whitespace-pre-wrap">{item.text}</div>
      {signIn && (
        <Button size="sm" className="shrink-0" onClick={() => setAuth(true)}>
          Sign in…
        </Button>
      )}
      {auth && signIn && <ClaudeAuthDialog host={host} profile={signIn.profile} onClose={() => setAuth(false)} />}
    </div>
  );
}

export const ChatItemView = memo(function Item({ item, cwd }: { item: ChatItem; cwd: string }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex justify-end py-1">
          <div className="selectable max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-raised px-3.5 py-2 ui-text-14 leading-relaxed">{item.text}</div>
        </div>
      );
    case "assistant":
      return item.text ? (
        <div className="px-2 py-1">
          <Markdown text={item.text} />
          {item.turn && <TurnFooter turn={item.turn} text={item.text} />}
        </div>
      ) : null;
    case "thinking":
      return <Thinking item={item} />;
    case "tool":
      return item.tool ? <ToolRow tool={item.tool} cwd={cwd} /> : null;
    case "error":
      return <ErrorItem item={item} />;
    default:
      return <div className="py-1 text-center ui-text-12 text-faint">{item.text}</div>;
  }
});

/** An AskUserQuestion with questions we can render; anything else gets the plain card. */
const isQuestion = (ask: PermissionAsk) => ask.tool === "AskUserQuestion" && askQuestions(ask.input).length > 0;

export function PermissionCard({ ask, cwd, onAnswer }: { ask: PermissionAsk; cwd: string; onAnswer: (decision: "allow" | "always" | "deny") => void }) {
  const Icon = toolIcon(ask.tool);
  const detail = ask.diff || ["Bash", "Write", "Edit", "MultiEdit", "Read"].includes(ask.tool) ? null : JSON.stringify(ask.input, null, 2);
  return (
    <div className="moonlet-card-in my-2 rounded-xl border border-[#5c4a1e] bg-[#1d1a12] p-3">
      <div className="mb-2 flex items-center gap-2 ui-text-13">
        <ShieldAlert size={15} className="text-blocked" />
        <span className="font-medium">Allow {ask.tool}?</span>
      </div>
      <div className="mb-2 flex min-w-0 items-start gap-2 rounded-md bg-[#141414] px-2.5 py-2">
        <Icon size={14} className="mt-[2px] shrink-0 text-muted" />
        <code className="selectable min-w-0 whitespace-pre-wrap break-all font-mono ui-text-12.5 text-fg">{rel(ask.summary, cwd) || ask.tool}</code>
      </div>
      {ask.diff && (
        <div className="mb-2">
          <DiffBlock diff={ask.diff} />
        </div>
      )}
      {detail && detail !== "{}" && <pre className="selectable mb-2 max-h-40 overflow-auto rounded-md bg-[#141414] px-2.5 py-2 font-mono ui-text-11.5 text-muted">{detail}</pre>}
      {ask.reason && !ask.summary.endsWith(ask.reason) && <div className="mb-2 ui-text-12.5 text-muted">{ask.reason}</div>}
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

/** Colour of a plan's status (X24), shared with the Plan tab. */
export const PLAN_TONE_TEXT = { blocked: "text-blocked", accent: "text-accent", muted: "text-muted", done: "text-done" } as const;
export const PLAN_TONE_BG = { blocked: "bg-blocked", accent: "bg-accent", muted: "bg-muted", done: "bg-done" } as const;

/** Claude's latest plan (X20, X24): its status and title, the approval
 *  buttons while it waits, and a way to the Plan tab, which shows the text. */
export function PlanCard({
  view,
  approveMode,
  showOpen,
  onOpen,
  onChoose,
}: {
  view: PlanView;
  approveMode: PlanApproveMode;
  showOpen: boolean;
  onOpen: () => void;
  onChoose: (choice: PlanChoice) => void;
}) {
  const l = planLabels(view.status, view.mode);
  const waiting = view.status === "pending";
  return (
    <div
      className={cx(
        "moonlet-card-in my-2 flex flex-col gap-2.5 rounded-[10px] border bg-panel px-3.5 py-3",
        waiting ? "border-[color-mix(in_oklab,var(--color-blocked)_40%,var(--color-border))]" : "border-border",
      )}
    >
      <div className="flex items-center gap-2.5">
        <FileText size={15} className={cx("shrink-0", PLAN_TONE_TEXT[l.tone])} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className={cx("ui-text-12", PLAN_TONE_TEXT[l.tone])}>{l.card}</div>
          <div className="truncate font-semibold">{view.title}</div>
        </div>
        {showOpen && (
          <Button size="sm" variant="ghost" onClick={onOpen}>
            Open plan →
          </Button>
        )}
      </div>
      {waiting && view.askId && (
        <div className="flex items-center gap-1.5 border-t border-border pt-2.5">
          <Button size="sm" variant="primary" onClick={() => onChoose("approve")}>
            {planApproveLabel(approveMode)}
          </Button>
          <Button size="sm" onClick={() => onChoose("ask")}>
            Approve, ask before edits
          </Button>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => onChoose("keepPlanning")}>
            Keep planning
          </Button>
        </div>
      )}
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
    <div className="moonlet-card-in my-2 rounded-xl border border-[#5c4a1e] bg-[#1d1a12] p-3">
      <div className="mb-2 flex items-center gap-2 ui-text-13">
        <MessageCircleQuestionMark size={15} className="text-blocked" />
        <span className="font-medium">{qs.length > 1 ? `${agentLabel("claude")} has ${qs.length} questions` : `${agentLabel("claude")} has a question`}</span>
      </div>
      {qs.map((q, i) => (
        <div key={i} className="mb-3">
          <div className="mb-1.5 flex items-start gap-2">
            {q.header && <span className="mt-[1px] shrink-0 rounded bg-[#141414] px-1.5 py-0.5 ui-text-11 text-muted">{q.header}</span>}
            <span className="selectable ui-text-13 text-fg">{q.question}</span>
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
                    <span className="block ui-text-12.5 text-fg">{o.label}</span>
                    {o.description && <span className="block ui-text-12 text-muted">{o.description}</span>}
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
function projectFiles(host: string, root: string, fresh = false): Promise<string[]> {
  const key = `${host}|${root}`;
  let p = fresh ? undefined : fileCache.get(key);
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
  id,
  draftKey,
  root,
  commands,
  working,
  focused,
  onSend,
  onStop,
  onCycleMode,
  scale,
  placeholder,
  focusSignal = 0,
  onCancel,
  onAttach,
  handle,
}: {
  host: string;
  /** The chat terminal, whose unsent text survives a session switch. */
  id: number;
  /** Where text sent from elsewhere waits (`agentDrafts`, T8). */
  draftKey: string;
  root: string;
  commands: string[];
  working: boolean;
  focused: boolean;
  onSend: (text: string, images: ChatImage[]) => void;
  onStop: () => void;
  /** Shift+Tab; absent for agents without a permission mode. */
  onCycleMode?: () => void;
  /** Text scale (see uiScale): the height is re-measured when it changes. */
  scale: number;
  placeholder?: string;
  /** Focuses the editor each time it changes, such as Keep planning (X24). */
  focusSignal?: number;
  /** Escape in the empty editor, before it would stop the agent. */
  onCancel?: () => void;
  /** ⌘U: attach files (X29). */
  onAttach?: () => void;
  /** Lets the `+` menu edit the input (X29). */
  handle?: Ref<EditorHandle>;
}) {
  const [text, setTextState] = useState(() => chatDraft(host, id));
  const setText = (v: string) => {
    saveChatDraft(host, id, v);
    setTextState(v);
  };
  const [caret, setCaret] = useState(text.length);
  const [files, setFiles] = useState<string[] | null>(null);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [walk, setWalk] = useState<number | null>(null);
  const [images, setImages] = useState<ChatImage[]>([]);
  const ta = useRef<HTMLTextAreaElement>(null);
  const history = promptHistory();

  // A restored draft continues from its end.
  useLayoutEffect(() => {
    ta.current?.setSelectionRange(text.length, text.length);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (focused) ta.current?.focus();
  }, [focused]);

  useEffect(() => {
    if (focusSignal) ta.current?.focus();
  }, [focusSignal]);

  // A command block sent from a shell (T8) joins whatever is being typed.
  const draft = useStore((s) => s.agentDrafts[draftKey]);
  useEffect(() => {
    if (!draft) return;
    setText(joinDraft(text, draft));
    useStore.setState((s) => {
      const agentDrafts = { ...s.agentDrafts };
      delete agentDrafts[draftKey];
      return { agentDrafts };
    });
    ta.current?.focus();
  }, [draft, draftKey, text]);

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

  useImperativeHandle(handle, () => {
    const apply = (r: { text: string; caret: number }) => {
      set(r.text, r.caret);
      ta.current?.focus();
    };
    return {
      slashCommand: (name) => apply(withSlashCommand(text, name)),
      mention: (...ms) => apply(ms.reduce((r, m) => withMention(r.text, r.caret, m), { text, caret })),
      addImages: (more) => {
        setImages((cur) => [...cur, ...more]);
        ta.current?.focus();
      },
    };
  });

  const accept = (choice: string) => {
    if (!token) return;
    const before = text.slice(0, token.start) + choice + " ";
    set(before + text.slice(caret), before.length);
  };

  const send = () => {
    const t = text.trim();
    if (!t && !images.length) return;
    if (t) rememberPrompt(t);
    onSend(t, images);
    setImages([]);
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
    } else if (onAttach && isAttachShortcut(e)) {
      e.preventDefault();
      onAttach();
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
    } else if (e.key === "Escape" && onCancel && !text) {
      e.preventDefault();
      onCancel();
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
              className={cx("flex w-full items-center gap-2 truncate rounded-md px-2.5 py-1.5 text-left font-mono ui-text-12.5", i === sel ? "bg-hover text-fg" : "text-muted")}
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
      {images.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {images.map((img, i) => (
            <span key={`${img.name}-${i}`} className="flex items-center gap-1.5 rounded-md border border-border-strong bg-panel py-1 pl-2 pr-1 font-mono ui-text-12 text-muted">
              <ImageIcon size={12} />
              {img.name}
              <button title={`Remove ${img.name}`} className="rounded p-0.5 hover:bg-hover hover:text-fg" onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))}>
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative flex min-h-[52px] items-center gap-3 rounded-[14px] border border-border-strong bg-panel py-3 pl-4 pr-3.5 focus-within:border-[#3a3a3a]">
        <div className="relative min-w-0 flex-1 ui-text-14 leading-[1.5]">
          <div aria-hidden className="pointer-events-none absolute inset-0 whitespace-pre-wrap break-words text-transparent">
            {text}
            {ghost && <span className="text-faint">{ghost}</span>}
          </div>
          <textarea
            ref={ta}
            rows={1}
            spellCheck={false}
            value={text}
            placeholder={placeholder ?? (working ? "Queue a message…" : "Ask for a change, @ to mention a file, / for commands")}
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
        <button title="Send (↵)" className="flex shrink-0 self-end pb-0.5 text-faint hover:text-fg" onClick={send}>
          <CornerDownLeft size={18} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );
}

/** What the `+` menu may do to the chat input (X29). */
export interface EditorHandle {
  slashCommand: (name: string) => void;
  /** Inserts each mention at the caret, in order. */
  mention: (...mentions: string[]) => void;
  /** Adds images, sent with the next message. */
  addImages: (images: ChatImage[]) => void;
}

// ------------------------------------------------------------ new chat

/** Chips in the empty-state block; four, then "+N more". */
function ContextChips<T>({ label, rows, chip }: { label: string; rows: T[]; chip: (row: T) => React.ReactNode }) {
  const [all, setAll] = useState(false);
  const section = chipSection(rows, all);
  if (!section) return null;
  return (
    <>
      <div className="mt-2 ui-text-13">{label}</div>
      <div className="flex flex-wrap items-center gap-1.5">
        {section.shown.map(chip)}
        {section.more > 0 && (
          <button className="rounded-md px-2 py-1 ui-text-12.5 text-muted hover:bg-hover hover:text-fg" onClick={() => setAll(true)}>
            +{section.more} more
          </button>
        )}
      </div>
    </>
  );
}

function ContextChip({ icon, title, onClick }: { icon: React.ReactNode; title: string; onClick: () => void }) {
  return (
    <button title={title} className="flex max-w-[240px] items-center gap-1.5 rounded-md border border-border-strong px-2 py-1 ui-text-12.5 text-fg hover:bg-hover" onClick={onClick}>
      <span className="shrink-0 text-muted">{icon}</span>
      <span className="truncate">{title}</span>
    </button>
  );
}

/** An empty chat (X38): where it runs, and the session's other chats and
 * plans to start from. A chip writes its file and mentions it in the input. */
function NewChat({ host, sessionId, self, cwd, onMention }: { host: string; sessionId: string; self: number; cwd: string; onMention: (mention: string) => void }) {
  const terminals = useStore((s) => s.terminals[host]);
  const home = useStore((s) => s.hosts[host]?.home ?? null);
  const chats = useChat((s) => s.chats);
  const list = useMemo(() => Object.values(terminals ?? {}), [terminals]);
  const byId = useMemo(() => Object.fromEntries(list.map((t) => [t.id, chats[chatKey(host, t.id)]])), [list, chats, host]);
  const { transcripts, plans } = useMemo(() => newChatContext(list, byId, { session: sessionId, self, cwd }), [list, byId, sessionId, self, cwd]);

  // The other chats' conversations load when their tab is first shown.
  useEffect(() => {
    for (const t of otherChats(list, sessionId, self)) {
      if (!useChat.getState().chats[chatKey(host, t.id)]) void loadChat(host, t.id).catch(() => {});
    }
  }, [list, host, sessionId, self]);

  const add = async (files: ContextFiles) => {
    try {
      for (const w of files.writes) await rpc(host, M.fsWrite, w);
      onMention(files.mention);
    } catch (e) {
      errorToast(e);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 py-2 text-muted">
      {cwd && (
        <div className="ui-text-13">
          New chat in <span className="font-mono text-fg">{shortPath(cwd, home)}</span>.
        </div>
      )}
      <ContextChips
        label="Add chat transcripts:"
        rows={transcripts}
        chip={(c) => <ContextChip key={c.id} icon={<AgentIcon agent={c.agent} size={12} />} title={c.title} onClick={() => void add(chatContextFiles(cwd, c))} />}
      />
      <ContextChips
        label="Add plans:"
        rows={plans}
        chip={(p) => <ContextChip key={p.key} icon={<ClipboardList size={12} />} title={p.title} onClick={() => void add(planContextFiles(cwd, p))} />}
      />
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
  const toolCalls = useStore((s) => s.settings.toolCalls);
  const blocks = useMemo(() => (st ? chatBlocks(st.items, toolCalls) : []), [st?.items, toolCalls]);
  const scroller = useRef<HTMLDivElement>(null);
  const cwd = info?.cwd ?? "";
  const stick = useRef(true);
  const scale = useStore((s) => uiScale(s.settings.term.fontSize));

  useEffect(() => {
    if (!st) void loadChat(host, id).catch(errorToast);
  }, [host, id, st]);

  const working = turnRunning(st?.status);
  const exists = useProjectFiles(host, cwd, working);
  const fileLinks = useMemo(() => ({ host, wsId, cwd, exists }), [host, wsId, cwd, exists]);
  const now = useNow(working && visible);

  // Follow new output while the view is scrolled to the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [st?.items, st?.pending, visible]);

  const call = (method: string, params: object) => rpc(host, method, { id, ...params }).catch(errorToast);

  // The latest plan (X24): its card follows its transcript row, and its text
  // is in the Plan tab, which opens when a plan arrives on screen.
  const plan = useMemo(() => (st ? planView(st) : null), [st]);
  const approveMode = useStore((s) => resolvePlanMode(s.settings.planApproveMode));
  const planShown = useStore((s) => s.rightOpen && s.rightTab === "plan");
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!plan?.askId || !visible || opened.current === plan.askId) return;
    opened.current = plan.askId;
    useStore.setState({ rightOpen: true, rightTab: "plan" });
  }, [plan?.askId, visible]);
  // Keep planning: the composer's next message is the feedback on this ask.
  const [revise, setRevise] = useState<string | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const revising = revise !== null && revise === plan?.askId;
  const choosePlan = (choice: PlanChoice) => {
    if (!plan?.askId) return;
    if (choice === "keepPlanning") {
      setRevise(plan.askId);
      setFocusSignal((n) => n + 1);
      return;
    }
    stick.current = true;
    void call(M.chatPermission, { ask: plan.askId, ...planAnswer(choice, "", approveMode) });
  };
  const planCard = plan && (
    <PlanCard
      key={`plan-${plan.itemId ?? plan.askId}`}
      view={plan}
      approveMode={approveMode}
      showOpen={!planShown}
      onOpen={() => useStore.setState({ rightOpen: true, rightTab: "plan" })}
      onChoose={choosePlan}
    />
  );

  const send = (text: string, images: ChatImage[]) => {
    stick.current = true;
    if (revising) {
      setRevise(null);
      const answer = planAnswer("keepPlanning", text);
      if (answer) void call(M.chatPermission, { ask: revise, ...answer });
      return;
    }
    void call(M.chatSend, { text, images });
  };
  const stop = () => void call(M.chatInterrupt, {});
  const cost = st ? costLine(st) : null;
  const editor = useRef<EditorHandle>(null);
  // Attached images go with the next message, other files become @mentions (X29).
  const attach = async () => {
    const root = info?.cwd ?? "";
    const picked = await openDialog({ multiple: true, directory: false, defaultPath: root || undefined, title: "Attach files or images" });
    const { images, files } = splitAttachments(Array.isArray(picked) ? picked : picked ? [picked] : []);
    // Images are sent along; mentions of this Mac's files only work locally.
    if (files.length && !canMentionFiles(host)) toast(`Files on this Mac can't be mentioned in a session on ${host}. Type @ to mention a file there.`);
    else if (files.length) editor.current?.mention(...files.map((f) => fileMention(f, root)));
    const read: ChatImage[] = [];
    for (const img of images) {
      try {
        const bytes = await invoke<ArrayBuffer>("read_image", { path: img.path });
        read.push({ name: img.name, media_type: img.mediaType, data: base64(bytes) });
      } catch (e) {
        errorToast(e);
      }
    }
    if (read.length) editor.current?.addImages(read);
  };
  // MCP servers (X29): asked for each time the + menu opens.
  const [mcpError, setMcpError] = useState<string | null>(null);
  const mcpCall = (action: string, server?: string) =>
    rpc(host, M.chatMcp, { id, action, server }).then(
      () => setMcpError(null),
      (e) => setMcpError(String(e?.message ?? e)),
    );
  const refreshMcp = () => void mcpCall("refresh");
  const servers = st?.mcp_servers ?? null;
  const signingIn = !!servers?.some((s) => s.status === "authing");
  // While a server signs in, its status is asked for every 3 s.
  useEffect(() => {
    if (!signingIn || !visible) return;
    const t = setInterval(() => void mcpCall("refresh"), 3000);
    return () => clearInterval(t);
  }, [signingIn, visible]); // eslint-disable-line react-hooks/exhaustive-deps
  // A sign-in page opens in the browser when it arrives, only for a server
  // the user clicked Authenticate on here. On a remote host the browser's
  // return to localhost is forwarded there over SSH.
  const asked = useRef(new Set<string>());
  // Copy link before there is a page: the copy waits for it (X29).
  const copyOnly = useRef(new Map<string, (url: string) => void>());
  const forwards = useRef(new Map<string, { bind: string; port: number }>());
  const openPage = async (name: string, url: string) => {
    if (!isWebPage(url)) throw new Error(`not a web page: ${url}`);
    const fwd = host !== "local" ? callbackForward(url) : null;
    if (fwd && !forwards.current.has(name)) {
      await invoke("ssh_forward", { host, bind: fwd.bind, port: fwd.port, open: true });
      forwards.current.set(name, fwd);
    }
    await openUrl(url);
  };
  useEffect(() => {
    if (!servers) return;
    for (const page of pagesToOpen(servers, asked.current)) openPage(page.name, page.url).catch(errorToast);
    for (const [name, copy] of copyOnly.current) {
      const url = servers.find((s) => s.name === name && s.status === "authing")?.auth_url;
      if (!url) continue;
      copyOnly.current.delete(name);
      copy(url);
    }
    for (const [name, fwd] of forwards.current) {
      if (servers.some((s) => s.name === name && s.status === "authing")) continue;
      forwards.current.delete(name);
      void invoke("ssh_forward", { host, bind: fwd.bind, port: fwd.port, open: false }).catch(() => {});
    }
  }, [servers, host]);
  const mcpActions = {
    servers,
    error: mcpError,
    onReconnect: (name: string) => void mcpCall("reconnect", name),
    onAuth: (name: string) => {
      copyOnly.current.delete(name);
      // Signing in already (after Copy link): open its page.
      const s = servers?.find((x) => x.name === name);
      if (s?.status === "authing" && s.auth_url) openPage(name, s.auth_url).catch(errorToast);
      else {
        asked.current.add(name);
        void mcpCall("auth", name);
      }
    },
    onCancel: (name: string) => void mcpCall("cancel", name),
    onCopy: (name: string) => {
      const url = servers?.find((s) => s.name === name)?.auth_url;
      if (url) return navigator.clipboard.writeText(url);
      // No page yet: ask for one and copy it instead of opening it. WebKit
      // writes the clipboard only during the click, so the copy is started
      // now with the address to come.
      const page = new Promise<string>((resolve) => copyOnly.current.set(name, resolve));
      const copied = navigator.clipboard.write([new ClipboardItem({ "text/plain": page.then((u) => new Blob([u], { type: "text/plain" })) })]);
      void mcpCall("auth", name);
      return copied.then(() => toast("Copied sign-in link"));
    },
  };
  const addDir = async () => {
    const picked = await openDialog({ directory: true, multiple: false, defaultPath: info?.cwd, title: "Add directory" });
    if (typeof picked === "string") void call(M.chatAddDir, { path: picked });
  };

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
      className="flex h-full w-full flex-col overflow-hidden bg-bg ui-text-13.5"
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
        <FileLinks.Provider value={fileLinks}>
          <div className="flex flex-col gap-0.5 px-6 pb-4 pt-5">
            {!st ? (
              <div className="py-10 text-center ui-text-13 text-faint">Loading conversation…</div>
            ) : st.items.length === 0 ? (
              <NewChat host={host} sessionId={wsId} self={id} cwd={cwd} onMention={(m) => editor.current?.mention(m)} />
            ) : (
              blocks.map((b) => {
                const view =
                  b.kind === "tools" ? <ToolGroup key={b.id} tools={b.tools} cwd={info?.cwd ?? ""} /> : <ChatItemView key={b.item.id} item={b.item} cwd={info?.cwd ?? ""} />;
                const hasPlan = plan?.itemId && (b.kind === "tools" ? b.tools.some((t) => t.id === plan.itemId) : b.item.id === plan.itemId);
                return hasPlan ? [view, planCard] : view;
              })
            )}
            {plan && !plan.itemId && planCard}
            {st?.pending.map((ask) => {
              if (planOf(ask)) return null;
              return isQuestion(ask) ? (
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
              );
            })}
          </div>
        </FileLinks.Provider>
      </div>
      <div className="w-full shrink-0 px-6 pb-3">
        <ChatEditor
          host={host}
          id={id}
          draftKey={termKey(host, id)}
          root={info?.cwd ?? "/"}
          commands={st?.slash_commands ?? []}
          working={working}
          focused={focused && visible}
          onSend={send}
          onStop={stop}
          onCycleMode={agent === "claude" ? () => modeMenu.pick(nextMode(modeMenu.mode, modeMenu.bypassOn)) : undefined}
          scale={scale}
          placeholder={revising ? "What should change in the plan?" : undefined}
          focusSignal={focusSignal}
          onCancel={revising ? () => setRevise(null) : undefined}
          onAttach={() => void attach()}
          handle={editor}
        />
        {/* Under the input (X29, X34): +, context ring and cost on the left, status centred, settings on the right. */}
        <div className="mt-1.5 grid h-[34px] grid-cols-[1fr_auto_1fr] items-center px-1 ui-text-12.5 text-muted">
          <div className="flex items-center gap-1">
            <PlusMenu
              variant="chat"
              onAttach={() => void attach()}
              onAddDir={() => void addDir()}
              commands={st?.slash_commands ?? []}
              onCommand={(c) => editor.current?.slashCommand(c)}
              agents={st?.agents ?? []}
              onAgent={(a) => editor.current?.mention(`agent-${a}`)}
              onOpen={refreshMcp}
              mcp={mcpActions}
            />
            {/* Straight to the agent: while a plan is revised, send() answers the plan. */}
            {st?.context && <ContextMeter usage={st.context} onCompact={() => void call(M.chatSend, { text: "/compact", images: [] })} />}
            {cost && (
              <>
                {st?.context && <span className="mx-1 h-3.5 w-px bg-border-strong" />}
                <span className="whitespace-nowrap">{cost}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2 whitespace-nowrap">
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
            ) : null}
          </div>
          <div className="flex items-center justify-end gap-1 ui-text-13">
            {working && (
              <Button size="sm" variant="ghost" onClick={stop} title="Stop (⌘.)">
                <Square size={10} fill="currentColor" /> Stop
              </Button>
            )}
            <Menu
              side="top"
              align="right"
              width={200}
              items={settings}
              trigger={(open) => (
                <button className="flex h-7 items-center gap-1.5 rounded-md px-2 hover:bg-hover" onClick={open}>
                  {agent !== "claude" && <AgentIcon agent={agent} size={12} />}
                  <span className="text-fg">{modelLabel}</span>
                  {effortLabel && <span className="text-muted">{effortLabel}</span>}
                </button>
              )}
            />
            {agent === "claude" && <ModeMenu menu={modeMenu} className="h-7 px-2 text-fg" iconSize={12} />}
            <Menu
              side="top"
              align="right"
              width={200}
              items={more}
              trigger={(open) => (
                <button title="More" className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-hover hover:text-fg" onClick={open}>
                  <MoreHorizontal size={14} />
                </button>
              )}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
