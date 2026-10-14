// The Terminal tab (X40): a session's shells as command blocks (or the raw
// terminal), a command line, and the keys a phone keyboard lacks.

import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ChevronDown, Copy, CornerDownLeft, Play, Plus, RotateCcw, SquareTerminal } from "lucide-react";
import { registerSink, rpc, sendInput } from "@desktop/lib/daemon";
import { chatDraft, joinDraft, saveChatDraft } from "@desktop/lib/chat";
import { blockForAgent, blockHeader, rerunInput, shortPath } from "@desktop/lib/blockText";
import { M, type Session, type TerminalInfo } from "@desktop/lib/protocol";
import { THEME } from "@desktop/lib/terminalTheme";
import { showScreen, useApp } from "../lib/app";
import { type Block, BlockReader } from "../lib/blocks";
import { sessionChat, shellTerminals } from "../lib/chatView";
import { KEYS, ctrlBytes, keyBytes } from "../lib/keyBar";
import { StatusMark } from "../components/chat";
import { AgentIcon, cx } from "../components/ui";

/** Attaches to a terminal (without resizing it) and feeds its output to `onData`. */
function useAttach(host: string, t: TerminalInfo, onReset: (d: Uint8Array) => void, onData: (d: Uint8Array) => void) {
  useEffect(() => {
    const off = registerSink(host, t.id, { reset: onReset, write: onData });
    void rpc(host, M.terminalAttach, { id: t.id }).catch(console.error);
    return () => {
      off();
      void rpc(host, M.terminalDetach, { id: t.id }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, t.id]);
}

const MAX_LINES = 300;

function BlockCard({ b, home, branch, worktree, onAgent, onRerun }: { b: Block; home: string | null; branch: string; worktree: string; onAgent: () => void; onRerun: () => void }) {
  const h = blockHeader({ cwd: b.cwd ?? undefined, exit: b.exit ?? undefined, startedAt: b.startedAt, endedAt: b.endedAt, end: b.running ? undefined : true }, { home, worktree, branch });
  const lines = b.output.split("\n");
  const failed = !b.running && !!b.exit;
  return (
    <div className={cx("flex flex-col gap-1.5 border-b border-border px-4 py-3", failed && "bg-[rgba(239,95,95,0.04)]")}>
      <div className="flex items-center gap-2 font-mono text-[11.5px] text-faint">
        <span className="truncate">{shortPath(b.cwd ?? "", home)}</span>
        <span className="flex-1" />
        {h.duration && <span>{h.duration.replace(/[()]/g, "")}</span>}
        {failed ? <span className="text-error">exit {b.exit}</span> : b.running ? <StatusMark status="running" /> : <StatusMark status="ok" />}
      </div>
      <div className="font-mono text-[13px] font-semibold break-all whitespace-pre-wrap">{b.command}</div>
      {b.output && (
        <pre className="selectable m-0 font-mono text-[12px] leading-[1.45] break-all whitespace-pre-wrap text-muted">
          {lines.length > MAX_LINES && <span className="text-faint">… {lines.length - MAX_LINES} earlier lines{"\n"}</span>}
          {lines.slice(-MAX_LINES).join("\n")}
        </pre>
      )}
      {failed && (
        <div className="mt-1 flex gap-2">
          <button type="button" onClick={onAgent} className="flex h-8 items-center gap-1.5 rounded-[8px] bg-raised px-2.5 text-[12.5px]">
            <AgentIcon agent="claude" size={13} /> Send to Claude
          </button>
          <button type="button" onClick={onRerun} className="flex h-8 items-center gap-1.5 rounded-[8px] border border-border-strong px-2.5 text-[12.5px]">
            <RotateCcw size={12} /> Re-run
          </button>
          <button type="button" onClick={() => void navigator.clipboard.writeText(b.output)} className="flex h-8 items-center gap-1.5 rounded-[8px] border border-border-strong px-2.5 text-[12.5px]">
            <Copy size={12} /> Copy
          </button>
        </div>
      )}
    </div>
  );
}

function BlocksView({ host, session, t }: { host: string; session: Session; t: TerminalInfo }) {
  const home = useApp((s) => s.hosts[host]?.home ?? null);
  const d = useApp((s) => s.data[host]);
  const reader = useMemo(() => new BlockReader(t.cols, t.rows), [t.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [blocks, setBlocks] = useState<Block[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const refresh = () => setBlocks(reader.blocks());
  useAttach(
    host,
    t,
    (data) => {
      void reader.reset();
      void reader.resize(t.cols, t.rows);
      void reader.write(data).then(refresh);
    },
    (data) => void reader.write(data).then(refresh),
  );
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [blocks]);
  const chat = d ? sessionChat(d, session.id) : null;
  return (
    <div ref={scroller} className="scroll h-full">
      {blocks.length === 0 && <div className="p-6 text-[14px] text-muted">No commands yet. This shell may not report command blocks; switch to Raw to see it.</div>}
      {blocks.map((b, i) => (
        <BlockCard
          key={i}
          b={b}
          home={home}
          branch={session.branch}
          worktree={session.path}
          onAgent={() => {
            if (chat === null) return;
            saveChatDraft(host, chat, joinDraft(chatDraft(host, chat), blockForAgent(b)));
            showScreen({ kind: "session", host, id: session.id, tab: "chat" });
          }}
          onRerun={() => {
            const input = rerunInput(b.command);
            if (input) void sendInput(host, t.id, input);
          }}
        />
      ))}
    </div>
  );
}

function RawView({ host, t }: { host: string; t: TerminalInfo }) {
  const el = useRef<HTMLDivElement>(null);
  // Made and disposed by the effect, so a second mount (StrictMode) gets a
  // fresh terminal instead of a disposed one.
  const term = useRef<XTerm | null>(null);
  useEffect(() => {
    if (!el.current) return;
    const x = new XTerm({ cols: t.cols, rows: t.rows, fontFamily: "JetBrains Mono, SF Mono, Menlo, monospace", fontSize: 10, theme: THEME, disableStdin: true, scrollback: 3000 });
    x.open(el.current);
    // The PTY keeps the Mac's size: fit its columns to the phone's width.
    x.options.fontSize = Math.max(6, Math.min(12, Math.floor((el.current.clientWidth / t.cols) * 1.6)));
    term.current = x;
    return () => {
      term.current = null;
      x.dispose();
    };
  }, [t.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useAttach(
    host,
    t,
    (data) => {
      const x = term.current;
      if (!x) return;
      x.reset();
      x.resize(t.cols, t.rows);
      x.write(data);
    },
    (data) => term.current?.write(data),
  );
  return <div ref={el} className="h-full overflow-auto bg-bg px-1 pt-1" />;
}

function CommandLine({ host, t, session }: { host: string; t: TerminalInfo; session: Session }) {
  const home = useApp((s) => s.hosts[host]?.home ?? null);
  const [text, setText] = useState("");
  const [ctrl, setCtrl] = useState(false);
  const send = (bytes: string) => void sendInput(host, t.id, bytes);
  const run = () => {
    send(`${text}\r`);
    setText("");
  };
  return (
    <div className="flex flex-col border-t border-border bg-panel">
      <div className="flex items-center gap-2 px-4 pt-2 font-mono text-[11.5px] text-faint">
        <span className="truncate">{shortPath(t.reported_cwd ?? t.cwd, home)}</span>
        <span className="text-accent-2">{session.branch}</span>
      </div>
      <div className="flex items-center gap-2 px-3 py-2">
        <label htmlFor="cmd" className="font-mono text-[15px] text-accent">
          ›
        </label>
        <input
          id="cmd"
          value={text}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => {
            const v = e.target.value;
            if (ctrl && v.length === text.length + 1) {
              const b = ctrlBytes(v.slice(-1));
              if (b) send(b);
              setCtrl(false);
              return;
            }
            setText(v);
          }}
          onKeyDown={(e) => e.key === "Enter" && run()}
          placeholder="Type a command"
          className="h-10 min-w-0 flex-1 bg-transparent font-mono text-[14px] outline-none"
        />
        <button type="button" aria-label="Run command" onClick={run} className="flex h-9 w-9 items-center justify-center rounded-full bg-fg text-bg">
          <CornerDownLeft size={16} />
        </button>
      </div>
      <div className="flex gap-1.5 overflow-x-auto px-3 pb-2">
        {KEYS.map((k) => (
          <button
            key={k.name}
            type="button"
            aria-label={k.name}
            onClick={() => (k.name === "ctrl" ? setCtrl(!ctrl) : send(keyBytes(k.name)))}
            className={cx("h-9 min-w-10 flex-none rounded-[8px] px-2.5 font-mono text-[13px]", k.name === "ctrl" && ctrl ? "bg-accent text-bg" : "bg-raised")}
          >
            {k.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function TerminalTab({ host, session }: { host: string; session: Session }) {
  const d = useApp((s) => s.data[host]);
  const terms = d ? shellTerminals(d, session.id) : [];
  const [current, setCurrent] = useState<number | null>(null);
  const [raw, setRaw] = useState(false);
  const t = terms.find((x) => x.id === current) ?? terms[0];
  const add = async () => {
    const info = await rpc<TerminalInfo>(host, M.terminalCreate, { cwd: session.path, session_id: session.id, cols: 100, rows: 30 }).catch(console.error);
    if (info) setCurrent(info.id);
  };
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 overflow-x-auto border-b border-border px-3 py-2">
        {terms.map((x) => (
          <button key={x.id} type="button" onClick={() => setCurrent(x.id)} className={cx("flex h-8 flex-none items-center gap-1.5 rounded-[8px] px-2.5 text-[13px]", x.id === t?.id ? "bg-raised text-fg" : "text-muted")}>
            {x.kind === "run" ? <Play size={12} /> : <SquareTerminal size={13} />}
            {x.title}
          </button>
        ))}
        <button type="button" aria-label="New terminal" onClick={() => void add()} className="flex h-8 w-8 flex-none items-center justify-center text-muted">
          <Plus size={16} />
        </button>
        <span className="flex-1" />
        <button type="button" onClick={() => setRaw(!raw)} className="flex h-8 flex-none items-center gap-1 rounded-[8px] border border-border-strong px-2.5 text-[12.5px] text-muted">
          {raw ? "Raw" : "Blocks"} <ChevronDown size={12} />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {!t ? (
          <div className="p-6 text-[14px] text-muted">No terminal in this session. Tap + for a shell.</div>
        ) : raw ? (
          <RawView key={t.id} host={host} t={t} />
        ) : (
          <BlocksView key={t.id} host={host} session={session} t={t} />
        )}
      </div>
      {t && <CommandLine host={host} t={t} session={session} />}
    </div>
  );
}
