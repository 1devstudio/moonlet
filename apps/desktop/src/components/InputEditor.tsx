import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { File, FileDiff, Folder, FolderOpen, GitBranch, Hexagon, SquareTerminal } from "lucide-react";
import { type CandidateKind, type Completion, completionInsert, completionModel, moveHighlight } from "../lib/completion";
import { type Chip, chipModel } from "../lib/chips";
import { rpc, sendInput } from "../lib/daemon";
import { M, type DirEntry, type FileChange } from "../lib/protocol";
import { firstWord, historyFor, knownCommands, rememberCommand, suggest } from "../lib/suggest";
import { type TokenKind, tokenize } from "../lib/shellTokens";
import { findEntry, getEntry, shortPath } from "../lib/terminals";
import { setClassic } from "../lib/actions";

const drafts = new Map<string, string>();

/**
 * Warp-style command input (T6): a real text editor at the shell prompt with
 * mouse placement, selection, multi-line editing and history ghost text.
 */
export function InputEditor({
  host,
  terminal,
  cwd,
  home,
  branch,
  nodeVersion,
  files,
  focused,
}: {
  host: string;
  terminal: number;
  cwd: string;
  home: string | null;
  branch?: string;
  nodeVersion?: string;
  /** The session's git status, for the uncommitted-changes chip. */
  files?: FileChange[];
  focused: boolean;
}) {
  // The draft survives the editor unmounting (Classic mode, a full-screen program).
  const draftKey = `${host}:${terminal}`;
  const [text, setTextState] = useState(() => drafts.get(draftKey) ?? "");
  const setText = (v: string | ((cur: string) => string)) =>
    setTextState((cur) => {
      const next = typeof v === "function" ? v(cur) : v;
      if (next) drafts.set(draftKey, next);
      else drafts.delete(draftKey);
      return next;
    });
  const [history, setHistory] = useState<string[]>([]);
  const [walk, setWalk] = useState<number | null>(null); // index into history while browsing with ↑/↓
  /** Tab completion popup (T8): every candidate, the text before the stem,
   * the directory listed (empty for commands) and the highlighted row. */
  const [popup, setPopup] = useState<{ all: { name: string; kind: CandidateKind }[]; head: string; dir: string; highlight: number } | null>(null);
  /** Command of the selected block, for the send-to-agent hint (T8). */
  const [selectedCmd, setSelectedCmd] = useState<string | null>(null);
  /** Command of the newest finished block, which ⌘↵ sends with nothing typed. */
  const [newestCmd, setNewestCmd] = useState<string | null>(null);
  const sendCmd = selectedCmd ?? (text.trim() ? null : newestCmd);
  const ta = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const draft = useRef("");

  useEffect(() => {
    void historyFor(host).then(setHistory);
  }, [host]);
  const [known, setKnown] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    // A slower answer for a previous terminal never replaces this one's.
    let live = true;
    void knownCommands(host, terminal).then((names) => live && setKnown(names));
    return () => {
      live = false;
    };
  }, [host, terminal]);

  // Typing into the terminal while the editor is up lands here instead.
  useEffect(() => {
    // Child effects run before the pane's own; getEntry creates it if needed.
    const entry = getEntry(host, terminal);
    entry.redirect = (ch) => {
      setText((t) => t + ch);
      ta.current?.focus();
    };
    entry.focusEditor = () => ta.current?.focus();
    entry.onSelect = (b) => setSelectedCmd(b?.command ?? null);
    setSelectedCmd(entry.selected?.command ?? null);
    entry.onBlockFinished = (b) => setNewestCmd(b.command ?? null);
    setNewestCmd(entry.newestFinished()?.command ?? null);
    return () => {
      entry.redirect = undefined;
      entry.focusEditor = undefined;
      entry.onSelect = undefined;
      entry.onBlockFinished = undefined;
    };
  }, [host, terminal]);

  useEffect(() => {
    if (focused) ta.current?.focus();
  }, [focused]);

  // Grow with content, up to ~10 lines.
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [text]);

  const ghost = walk === null ? suggest(history, text) : null;
  const atEnd = () => {
    const el = ta.current;
    return !!el && el.selectionStart === el.selectionEnd && el.selectionEnd === text.length;
  };

  // The latest text, and a counter that makes slower completion requests
  // stale once another starts or the command runs.
  const textNow = useRef(text);
  textNow.current = text;
  const request = useRef(0);

  const run = () => {
    request.current++;
    const cmd = text;
    setText("");
    setWalk(null);
    setPopup(null);
    if (cmd.trim()) {
      rememberCommand(host, cmd.trim());
      setHistory((h) => [...h.filter((x) => x !== cmd.trim()), cmd.trim()]);
    }
    // One bracketed paste so newlines, tabs and other control characters
    // arrive as text instead of acting as keys (a tab would complete).
    const body = /[\x00-\x1f\x7f]/.test(cmd) ? `\x1b[200~${cmd}\x1b[201~` : cmd;
    void sendInput(host, terminal, body + "\r");
  };

  // Rows of the open popup, narrowed by what has been typed since (T8).
  const stemNow = popup && text.startsWith(popup.head) ? text.slice(popup.head.length) : null;
  const rows: Completion[] = popup && stemNow !== null && !/\s/.test(stemNow) ? completionModel(popup.all, stemNow) : [];
  const highlight = rows.length ? Math.min(popup?.highlight ?? 0, rows.length - 1) : 0;
  const accept = (row: Completion) => {
    if (!popup) return;
    setText(popup.head + row.insert);
    setPopup(null);
    ta.current?.focus();
  };

  /** Tab without a suggestion (T6, T8): the first word completes as a
   * command, later words as paths in the shell's directory. One match is
   * completed in place; several extend to their common prefix and open the
   * popup. */
  const complete = async () => {
    const id = ++request.current;
    const asked = text;
    const m = /(\S*)$/.exec(text);
    const word = m ? m[1] : "";
    const isCommand = text.trim() === word && !word.includes("/");
    const slash = word.lastIndexOf("/");
    const dirPart = slash >= 0 ? word.slice(0, slash + 1) : "";
    const stem = slash >= 0 ? word.slice(slash + 1) : word;
    const base = dirPart.startsWith("/") ? dirPart : dirPart.startsWith("~/") && home ? home + dirPart.slice(1) : `${cwd}/${dirPart}`;
    let all: { name: string; kind: CandidateKind }[];
    try {
      all = isCommand
        ? [...(await knownCommands(host, terminal))].map((name) => ({ name, kind: "command" as const }))
        : (await rpc<DirEntry[]>(host, M.fsList, { path: base || cwd, show_ignored: true })).map((e) => ({ name: e.name, kind: e.is_dir ? ("dir" as const) : ("file" as const) }));
    } catch {
      return; // directory unreadable
    }
    // The user may have kept typing, or run the command, while it loaded.
    if (request.current !== id || textNow.current !== asked) return;
    const hits = completionModel(all, stem);
    if (!hits.length) return;
    const head = asked.slice(0, asked.length - stem.length);
    const insert = completionInsert(all, stem);
    if (insert.length > stem.length) setText(head + insert);
    setPopup(hits.length > 1 ? { all, head, dir: isCommand ? "" : base.replace(/\/+$/, ""), highlight: 0 } : null);
  };

  const browse = (dir: -1 | 1) => {
    if (!history.length) return;
    if (walk === null) {
      if (dir === 1) return;
      draft.current = text;
      setWalk(history.length - 1);
      setText(history[history.length - 1]);
      return;
    }
    const next = walk + dir;
    if (next >= history.length) {
      setWalk(null);
      setText(draft.current);
    } else if (next >= 0) {
      setWalk(next);
      setText(history[next]);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (e.nativeEvent.isComposing) return;
    // Shift-modified keys keep their editing meaning (new line, selection).
    if (rows.length && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && ["ArrowDown", "ArrowUp", "Tab", "Enter", "Escape"].includes(e.key)) {
      e.preventDefault();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") setPopup((p) => p && { ...p, highlight: moveHighlight(rows.length, highlight, e.key === "ArrowDown" ? 1 : -1) });
      else if (e.key === "Escape") setPopup(null);
      else accept(rows[highlight]);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      run();
    } else if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      if (ghost) setText(text + ghost);
      else void complete();
    } else if (e.key === "ArrowRight" && ghost && atEnd() && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      setText(text + (e.altKey ? firstWord(ghost) : ghost));
    } else if (e.key === "ArrowUp" && e.metaKey && !e.shiftKey && !e.altKey && !text.includes("\n")) {
      // ⌘↑ selects the newest block (T8); multi-line input keeps the native move.
      e.preventDefault();
      findEntry(host, terminal)?.stepSelection(-1);
    } else if (e.key === "ArrowUp" && !e.metaKey && !e.shiftKey && !e.altKey && !el.value.slice(0, el.selectionStart).includes("\n")) {
      e.preventDefault();
      browse(-1);
    } else if (e.key === "ArrowDown" && !e.shiftKey && !e.altKey && walk !== null && !el.value.slice(el.selectionEnd).includes("\n")) {
      e.preventDefault();
      browse(1);
    } else if (e.key === "c" && e.ctrlKey) {
      e.preventDefault();
      if (text) {
        setText("");
        setWalk(null);
      } else void sendInput(host, terminal, "\x03");
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      findEntry(host, terminal)?.term.clear();
      void sendInput(host, terminal, "\x0c");
    } else if (e.key === "d" && e.ctrlKey && !text) {
      e.preventDefault();
      void sendInput(host, terminal, "\x04");
    } else if (e.key === "Escape") {
      e.preventDefault();
      findEntry(host, terminal)?.focus();
    } else if (walk !== null && e.key.length === 1) {
      setWalk(null);
    }
  };

  return (
    <div className="relative shrink-0 border-t border-border bg-bg px-7 pb-3 pt-2.5" onMouseDown={(e) => e.stopPropagation()}>
      {rows.length > 0 && popup && <CompletionPopup rows={rows} highlight={highlight} dir={popup.dir} home={home} onPick={accept} />}
      {/* One row, as in Warp: the directory chip gives way first, and Classic
          sits outside the chips so a narrow pane never hides it. */}
      <div className="mb-2 flex items-center gap-1.5 font-mono text-[11.5px] text-muted">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          {chipModel({ cwd, home, nodeVersion, branch, files }).map((c) => (
            <ChipBox key={c.kind} chip={c} />
          ))}
        </div>
        <button
          className="shrink-0 rounded p-1 text-faint hover:bg-hover hover:text-fg"
          title="Classic: show the shell's own prompt and type into the terminal"
          onClick={() => void setClassic(host, terminal, true)}
        >
          <SquareTerminal size={13} />
        </button>
      </div>
      <div className="relative font-mono text-[13.5px] leading-[20px]">
        {/* Mirror of the text, coloured (T8), with the ghost suggestion after
            it. The textarea above it has transparent text and shows the caret
            and the selection. */}
        <div ref={mirror} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-fg">
          {tokenize(text).map((t, i) => (
            <span key={i} className={tokenClass(t.kind, t.kind === "command" && known.has(t.text))}>
              {t.text}
            </span>
          ))}
          {ghost && (
            <>
              <span className="text-faint">{ghost}</span>
              <kbd className="ml-1.5 rounded border border-border-strong px-1 align-[1px] font-mono text-[10px] text-faint">→</kbd>
            </>
          )}
        </div>
        <textarea
          ref={ta}
          // Past its height cap the textarea scrolls; the coloured mirror follows.
          onScroll={(e) => mirror.current && (mirror.current.scrollTop = e.currentTarget.scrollTop)}
          rows={1}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          value={text}
          placeholder="Type a command…"
          onChange={(e) => {
            setText(e.target.value);
            // Editing a command means ⌘↵ is about it, not a selected block (T8).
            const entry = findEntry(host, terminal);
            if (entry?.selected) entry.select(null);
          }}
          onKeyDown={onKeyDown}
          className="relative block w-full resize-none overflow-hidden whitespace-pre-wrap break-words bg-transparent text-transparent caret-accent outline-none placeholder:text-faint selection:bg-accent/30"
        />
      </div>
      {sendCmd && (
        <div className="mt-1.5 truncate font-mono text-[11px] text-faint">
          ⌘↵ send <span className="text-muted">`{sendCmd}`</span> to the agent · ⇧⌘↵ new agent tab
        </div>
      )}
    </div>
  );
}

/** Colours of the command line (T8), from the terminal palette. An unknown
 * command stays plain: aliases and functions are invisible to the daemon. */
function tokenClass(kind: TokenKind, known: boolean): string {
  switch (kind) {
    case "command":
      return known ? "text-[#8fd18e]" : "";
    case "subcommand":
      return "text-[#7aa7ff]";
    case "flag":
      return "text-muted";
    case "string":
      return "text-[#e8c46b]";
    case "operator":
      return "text-faint";
    default:
      return "";
  }
}

/** Tab completion rows above the input, with the highlighted row's full
 * path beside them (T8). */
function CompletionPopup({ rows, highlight, dir, home, onPick }: { rows: Completion[]; highlight: number; dir: string; home: string | null; onPick: (row: Completion) => void }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.children[highlight]?.scrollIntoView({ block: "nearest" });
  }, [highlight]);
  const current = rows[highlight];
  const icon = (kind: CandidateKind) => (kind === "dir" ? <Folder size={13} /> : kind === "file" ? <File size={13} /> : <SquareTerminal size={13} />);
  return (
    <div className="absolute bottom-full left-7 z-30 mb-1.5 flex items-start gap-2 font-mono text-[12.5px]" onMouseDown={(e) => e.preventDefault()}>
      <div ref={list} role="listbox" className="max-h-[220px] w-[320px] overflow-y-auto rounded-md border border-border-strong bg-panel py-1 shadow-lg">
        {rows.map((r, i) => (
          <div
            key={r.kind + r.name}
            id={`jaunt-completion-${i}`}
            role="option"
            aria-selected={i === highlight}
            className={`flex cursor-default items-center gap-2 px-2.5 py-1 ${i === highlight ? "bg-accent/20 text-fg" : "text-muted hover:bg-hover"}`}
            onClick={() => onPick(r)}
          >
            <span className="shrink-0 text-faint">{icon(r.kind)}</span>
            <span className="truncate">
              <b className="font-semibold text-fg">{r.name.slice(0, r.match)}</b>
              {r.name.slice(r.match)}
              {r.kind === "dir" ? "/" : ""}
            </span>
            <span className="ml-auto shrink-0 font-sans text-[11px] text-faint">{r.label}</span>
          </div>
        ))}
      </div>
      {/* Focus stays in the textarea; the highlighted row is announced here. */}
      <div aria-live="polite" className="sr-only">
        {current ? `${current.name}, ${current.label}, ${highlight + 1} of ${rows.length}` : ""}
      </div>
      {current && (
        <div className="max-w-[320px] rounded-md border border-border-strong bg-panel px-3 py-2 shadow-lg">
          <div className="break-all font-semibold text-fg">
            {current.kind === "command" ? current.name : shortPath(`${dir}/${current.name}`, home) + (current.kind === "dir" ? "/" : "")}
          </div>
          <div className="mt-0.5 font-sans text-[11px] text-faint">{current.label}</div>
        </div>
      )}
    </div>
  );
}

/** One boxed chip above the input (T8). */
function ChipBox({ chip }: { chip: Chip }) {
  const icon = { node: <Hexagon size={11} />, dir: <FolderOpen size={11} />, branch: <GitBranch size={11} />, changes: <FileDiff size={11} /> }[chip.kind];
  const title = { node: "Node.js on PATH", dir: "Current directory", branch: "Session branch", changes: "Files with uncommitted changes" }[chip.kind];
  return (
    <span
      title={title}
      className={`flex min-w-0 items-center gap-1 rounded border border-border bg-raised px-1.5 py-0.5 ${chip.kind === "dir" ? "shrink" : "shrink-0"} ${chip.kind === "branch" ? "max-w-[40%] text-done" : ""}`}
    >
      <span className="shrink-0 opacity-80">{icon}</span>
      {chip.kind === "changes" ? (
        // Warp's `5 • +113 -30`, the line counts in green and red.
        <span className="whitespace-nowrap">
          {chip.files} • <span className="text-done">+{chip.additions}</span> <span className="text-error">-{chip.deletions}</span>
        </span>
      ) : chip.kind === "dir" ? (
        // Cut from the left, as Warp does, so the end of the path stays.
        <span className="truncate [direction:rtl]">
          <bdi>{chip.text}</bdi>
        </span>
      ) : (
        <span className="truncate">{chip.text}</span>
      )}
    </span>
  );
}
