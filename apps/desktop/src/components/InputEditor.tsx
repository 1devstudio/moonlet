import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FolderOpen, GitBranch } from "lucide-react";
import { rpc, sendInput } from "../lib/daemon";
import { M, type DirEntry } from "../lib/protocol";
import { commonPrefix, firstWord, historyFor, rememberCommand, suggest } from "../lib/suggest";
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
  focused,
}: {
  host: string;
  terminal: number;
  cwd: string;
  home: string | null;
  branch?: string;
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
  const [hint, setHint] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const draft = useRef("");

  useEffect(() => {
    void historyFor(host).then(setHistory);
  }, [host]);

  // Typing into the terminal while the editor is up lands here instead.
  useEffect(() => {
    // Child effects run before the pane's own; getEntry creates it if needed.
    const entry = getEntry(host, terminal);
    entry.redirect = (ch) => {
      setText((t) => t + ch);
      ta.current?.focus();
    };
    return () => {
      entry.redirect = undefined;
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

  const run = () => {
    const cmd = text;
    setText("");
    setWalk(null);
    setHint(null);
    if (cmd.trim()) {
      rememberCommand(host, cmd.trim());
      setHistory((h) => [...h.filter((x) => x !== cmd.trim()), cmd.trim()]);
    }
    // One bracketed paste so newlines, tabs and other control characters
    // arrive as text instead of acting as keys (a tab would complete).
    const body = /[\x00-\x1f\x7f]/.test(cmd) ? `\x1b[200~${cmd}\x1b[201~` : cmd;
    void sendInput(host, terminal, body + "\r");
  };

  const completePath = async () => {
    const asked = text;
    const m = /(\S*)$/.exec(text);
    const word = m ? m[1] : "";
    const slash = word.lastIndexOf("/");
    const dirPart = slash >= 0 ? word.slice(0, slash + 1) : "";
    const stem = slash >= 0 ? word.slice(slash + 1) : word;
    const base = dirPart.startsWith("/") ? dirPart : dirPart.startsWith("~/") && home ? home + dirPart.slice(1) : `${cwd}/${dirPart}`;
    try {
      const entries = await rpc<DirEntry[]>(host, M.fsList, { path: base || cwd, show_ignored: true });
      const hits = entries.filter((e) => e.name.startsWith(stem) && (stem.startsWith(".") || !e.name.startsWith(".")));
      if (!hits.length) return;
      const names = hits.map((e) => e.name + (e.is_dir ? "/" : ""));
      const completion = hits.length === 1 ? names[0] + (hits[0].is_dir ? "" : " ") : commonPrefix(names);
      // The user may have kept typing while the listing loaded.
      if (completion.length > stem.length) setText((cur) => (cur === asked ? asked.slice(0, asked.length - stem.length) + completion : cur));
      setHint(hits.length > 1 ? names.slice(0, 12).join("  ") + (names.length > 12 ? "  …" : "") : null);
    } catch {
      /* directory unreadable */
    }
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
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      run();
    } else if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      if (ghost) setText(text + ghost);
      else void completePath();
    } else if (e.key === "ArrowRight" && ghost && atEnd() && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      setText(text + (e.altKey ? firstWord(ghost) : ghost));
    } else if (e.key === "ArrowUp" && !e.shiftKey && !e.altKey && !el.value.slice(0, el.selectionStart).includes("\n")) {
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
      setHint(null);
      findEntry(host, terminal)?.focus();
    } else if (walk !== null && e.key.length === 1) {
      setWalk(null);
    }
  };

  return (
    <div className="shrink-0 border-t border-border bg-bg px-7 pb-3 pt-2.5" onMouseDown={(e) => e.stopPropagation()}>
      <div className="mb-1.5 flex items-center gap-3 font-mono text-[11.5px] text-muted">
        <span className="flex min-w-0 shrink items-center gap-1.5">
          <FolderOpen size={12} className="shrink-0 text-faint" />
          <span className="truncate">{shortPath(cwd, home)}</span>
        </span>
        {branch && (
          <span className="flex min-w-0 max-w-[45%] shrink-0 items-center gap-1.5">
            <GitBranch size={12} className="shrink-0 text-faint" />
            <span className="truncate">{branch}</span>
          </span>
        )}
        <span className="ml-auto shrink-0 whitespace-nowrap text-faint">{ghost ? "→ accept" : "⇧↵ new line"}</span>
        <button
          className="shrink-0 rounded px-1.5 text-faint hover:bg-hover hover:text-fg"
          title="Show the shell's own prompt and type into the terminal"
          onClick={() => void setClassic(host, terminal, true)}
        >
          Classic
        </button>
      </div>
      <div className="relative font-mono text-[13.5px] leading-[20px]">
        {/* Mirror of the text with the ghost suggestion after it. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 whitespace-pre-wrap break-words text-transparent">
          {text}
          {ghost && <span className="text-faint">{ghost}</span>}
        </div>
        <textarea
          ref={ta}
          rows={1}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          value={text}
          placeholder="Type a command…"
          onChange={(e) => {
            setText(e.target.value);
            setHint(null);
          }}
          onKeyDown={onKeyDown}
          className="relative block w-full resize-none overflow-hidden whitespace-pre-wrap break-words bg-transparent text-fg caret-accent outline-none placeholder:text-faint"
        />
      </div>
      {hint && <div className="mt-1.5 truncate font-mono text-[12px] text-muted">{hint}</div>}
    </div>
  );
}
