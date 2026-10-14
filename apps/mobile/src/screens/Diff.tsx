// Diff review (X40, D2, D3): a file's hunks with line numbers, staging and
// discarding, and a long-pressed line's comment sent to the agent.

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Check, ChevronDown, ChevronLeft, ChevronUp, Undo2 } from "lucide-react";
import { rpc } from "@desktop/lib/daemon";
import { latestOnly } from "@desktop/lib/prStack";
import { commentPrompt, hunkPatch, parseFileDiff } from "@desktop/lib/patch";
import { M } from "@desktop/lib/protocol";
import { showScreen, useApp } from "../lib/app";
import { sessionChat } from "../lib/chatView";
import { DIFF_LINE } from "../lib/palette";
import { type DiffRow, diffRows, editsDiff, folderGroups } from "../lib/diffView";
import { forget, useGitStatus } from "../lib/rowDetails";
import { useBusy } from "../lib/busy";
import { AgentIcon, Btn, DiffStat, cx } from "../components/ui";
import { Sheet } from "../components/Sheet";

function useLongPress(onLong: () => void) {
  const timer = useRef<number | undefined>(undefined);
  const cancel = () => window.clearTimeout(timer.current);
  return {
    onPointerDown: () => {
      cancel();
      timer.current = window.setTimeout(onLong, 450);
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerMove: cancel,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      cancel();
      onLong();
    },
  };
}

function Line({ row, commenting, onComment }: { row: Extract<DiffRow, { kind: "line" }>; commenting: boolean; onComment: () => void }) {
  const press = useLongPress(onComment);
  return (
    <div
      {...press}
      className={cx(
        "flex min-h-[22px] font-mono text-[12px] leading-[22px] select-none",
        row.sign === "+" && DIFF_LINE.add,
        row.sign === "-" && DIFF_LINE.del,
        commenting && "outline outline-1 outline-accent",
      )}
    >
      <span className="w-9 flex-none pr-1 text-right text-faint">{row.old ?? ""}</span>
      <span className="w-9 flex-none pr-1 text-right text-faint">{row.new ?? ""}</span>
      <span className="w-4 flex-none text-center">{row.sign === " " ? "" : row.sign}</span>
      <span className="min-w-0 flex-1 pr-2 break-all whitespace-pre-wrap">{row.text || " "}</span>
    </div>
  );
}

export function DiffScreen({ host, id, path, against }: { host: string; id: string; path: string; against: "base" | "head" }) {
  const d = useApp((s) => s.data[host]);
  const session = d?.sessions.find((s) => s.id === id);
  const [status, reloadStatus] = useGitStatus(host, session, against);
  const [text, setText] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [comment, setComment] = useState<{ row: number; text: string } | null>(null);
  const { busy, run } = useBusy();
  const [confirm, setConfirm] = useState<{ title: string; run: () => Promise<unknown> } | null>(null);
  // Hunks against the base include committed lines (X40): staging and
  // discarding happen in the diff against HEAD only.
  const editable = editsDiff(against);
  const [latest] = useState(latestOnly);
  const order = useMemo(() => folderGroups(status?.files ?? []).flatMap((g) => g.files), [status]);
  const index = order.findIndex((f) => f.path === path);
  const file = order[index];

  useEffect(() => {
    if (!session) return;
    setText(null);
    setComment(null);
    // A reply for a file shown before this one is dropped: its hunks would
    // show, and be staged or discarded, under this file's name.
    const isLatest = latest.start();
    void rpc<string>(host, M.gitDiff, { path: session.path, file: path, ...(against === "base" ? { base: session.base } : {}) })
      .then((t) => isLatest() && setText(t))
      .catch((e) => isLatest() && setText(`Cannot show this diff: ${e instanceof Error ? e.message : String(e)}`));
  }, [host, session?.path, path, against, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const diff = useMemo(() => (text ? parseFileDiff(text) : null), [text]);
  const rows = useMemo(() => (diff ? diffRows(diff) : []), [diff]);
  if (!session) return null;
  const back = () => showScreen({ kind: "session", host, id, tab: "changes" });
  const go = (i: number) => order[i] && showScreen({ kind: "diff", host, id, path: order[i].path, against });
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dir = path.slice(0, Math.max(0, path.lastIndexOf("/")));
  const act = (f: () => Promise<unknown>) =>
    run(f, () => {
      forget(`git:${host}:${id}`);
      reloadStatus();
      setTick((t) => t + 1);
    });
  const sendComment = async (row: Extract<DiffRow, { kind: "line" }>, body: string) => {
    const chat = d ? sessionChat(d, id) : null;
    if (chat === null) return;
    await rpc(host, M.chatSend, { id: chat, text: commentPrompt(path, row.new ?? row.old ?? 0, body, row.text), images: [] });
    showScreen({ kind: "session", host, id, tab: "chat" });
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-1 border-b border-border px-2 pb-2" style={{ paddingTop: "calc(var(--safe-top) + 6px)" }}>
        <button type="button" aria-label="Back to changes" onClick={back} className="flex h-10 w-10 items-center justify-center text-muted">
          <ChevronLeft size={24} />
        </button>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[15.5px] font-semibold">{name}</span>
          <span className="flex items-center gap-2 text-[12px] text-muted">
            <span className="truncate font-mono">{dir || "."}</span>
            {file && <DiffStat add={file.additions} del={file.deletions} />}
          </span>
        </div>
        {index >= 0 && (
          <span className="px-1 text-[12.5px] text-muted">
            {index + 1} / {order.length}
          </span>
        )}
        <button type="button" aria-label="Previous file" disabled={index <= 0} onClick={() => go(index - 1)} className="flex h-10 w-9 items-center justify-center text-muted disabled:opacity-30">
          <ChevronUp size={20} />
        </button>
        <button type="button" aria-label="Next file" disabled={index < 0 || index >= order.length - 1} onClick={() => go(index + 1)} className="flex h-10 w-9 items-center justify-center text-muted disabled:opacity-30">
          <ChevronDown size={20} />
        </button>
      </header>
      <main className="scroll min-h-0 flex-1 pb-4">
        {text === null && <div className="p-6 text-[14px] text-muted">Loading the diff…</div>}
        {text !== null && rows.length === 0 && <div className="p-6 text-[14px] text-muted">{text.startsWith("Cannot") ? text : "No textual changes."}</div>}
        {rows.map((r, i) =>
          r.kind === "hunk" ? (
            <div key={i} className="mt-2 flex items-center gap-2 border-y border-border bg-panel px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-faint">{r.header}</span>
              {editable && (
                <>
                  <button type="button" disabled={busy || !diff} onClick={() => void act(() => rpc(host, M.gitApplyPatch, { path: session.path, patch: hunkPatch(diff!, r.index), cached: true }))} className="h-7 rounded-[7px] border border-border-strong px-2 text-[12px]">
                    Stage hunk
                  </button>
                  <button
                    type="button"
                    aria-label="Discard hunk"
                    disabled={busy || !diff}
                    onClick={() => setConfirm({ title: "Discard this hunk? The change is lost.", run: () => rpc(host, M.gitApplyPatch, { path: session.path, patch: hunkPatch(diff!, r.index), reverse: true }) })}
                    className="flex h-7 w-7 items-center justify-center text-muted"
                  >
                    <Undo2 size={15} />
                  </button>
                </>
              )}
            </div>
          ) : (
            <div key={i}>
              <Line row={r} commenting={comment?.row === i} onComment={() => setComment({ row: i, text: "" })} />
              {comment?.row === i && (
                <div className="flex flex-col gap-2 border-y border-border bg-panel px-3 py-2.5">
                  <label htmlFor="cm" className="flex items-center gap-1.5 text-[12.5px] text-muted">
                    <AgentIcon agent="claude" size={13} /> Comment to Claude on line {r.new ?? r.old}
                  </label>
                  <textarea id="cm" autoFocus rows={2} value={comment.text} onChange={(e) => setComment({ row: i, text: e.target.value })} className="rounded-[10px] border border-border-strong bg-bg p-2.5 text-[14.5px] outline-none" />
                  <div className="flex justify-end gap-2">
                    <Btn tone="ghost" onClick={() => setComment(null)}>
                      Cancel
                    </Btn>
                    <Btn tone="primary" disabled={!comment.text.trim()} onClick={() => void sendComment(r, comment.text)}>
                      <ArrowUp size={15} /> Send to Claude
                    </Btn>
                  </div>
                </div>
              )}
            </div>
          ),
        )}
      </main>
      <div className="flex items-center gap-2 border-t border-border px-4 pt-2.5" style={{ paddingBottom: "max(var(--safe-bottom), 10px)" }}>
        <span className="flex-1 text-[12px] text-faint">Long-press a line to comment</span>
        {!editable ? (
          <Btn onClick={() => showScreen({ kind: "diff", host, id, path, against: "head" })}>Stage or discard vs HEAD</Btn>
        ) : (
          <>
            <Btn tone="ghost" disabled={busy} onClick={() => setConfirm({ title: `Discard every change to ${name}?`, run: () => rpc(host, M.gitRevert, { path: session.path, files: [path] }) })}>
              Discard file
            </Btn>
            {file?.staged && !file.unstaged ? (
              <Btn disabled={busy} onClick={() => void act(() => rpc(host, M.gitUnstage, { path: session.path, files: [path] }))}>
                <Check size={14} /> Staged
              </Btn>
            ) : (
              <Btn tone="primary" disabled={busy} onClick={() => void act(() => rpc(host, M.gitStage, { path: session.path, files: [path] }))}>
                Stage file
              </Btn>
            )}
          </>
        )}
      </div>
      {confirm && (
        <Sheet label="Discard" onClose={() => setConfirm(null)}>
          <div className="flex flex-col gap-3 px-4 pb-2">
            <p className="m-0 text-[15px]">{confirm.title}</p>
            <div className="grid grid-cols-2 gap-2">
              <Btn tone="ghost" onClick={() => setConfirm(null)}>
                Cancel
              </Btn>
              <Btn
                className="text-error"
                onClick={() => {
                  const run = confirm.run;
                  setConfirm(null);
                  void act(run);
                }}
              >
                Discard
              </Btn>
            </div>
          </div>
        </Sheet>
      )}
    </div>
  );
}
