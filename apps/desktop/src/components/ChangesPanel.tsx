import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DiffEditor, type DiffOnMount } from "@monaco-editor/react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { Check, FileDiff, Minus, MessageSquarePlus, Plus, RotateCcw, Undo2 } from "lucide-react";
import "../lib/monaco";

/** Pending diff-model cleanups per session, cancelled if the panel reopens. */
const modelCleanup = new Map<string, number>();
import { editorOptions, languageFor, monaco } from "../lib/monaco";
import { rpc } from "../lib/daemon";
import { commentPrompt, hunkPatch, parseFileDiff, type FileDiff as ParsedDiff } from "../lib/patch";
import { M, type FileChange, type FileVersions, type Session } from "../lib/protocol";
import { errorToast, refreshGit, toast, useStore, sesKey } from "../lib/store";
import { sendToAgent } from "../lib/actions";
import { Button, DiffStat, Empty, IconButton, Kbd, cx } from "./ui";

const STATUS_LETTER: Record<FileChange["status"], [string, string]> = {
  added: ["A", "text-add"],
  untracked: ["U", "text-add"],
  modified: ["M", "text-blocked"],
  deleted: ["D", "text-del"],
  renamed: ["R", "text-accent"],
  conflicted: ["!", "text-error"],
};

type Mode = "base" | "head";

function FileRow({ f, active, onSelect, onAction }: { f: FileChange; active: boolean; onSelect: () => void; onAction: (a: "stage" | "unstage" | "revert") => void }) {
  const [letter, color] = STATUS_LETTER[f.status];
  const name = f.path.split("/").pop();
  const dir = f.path.slice(0, f.path.length - (name?.length ?? 0));
  return (
    <div
      className={cx("group flex cursor-default items-center gap-2 px-3 py-[3px] text-[12.5px]", active ? "bg-raised" : "hover:bg-panel-2")}
      onClick={onSelect}
      title={f.old_path ? `${f.old_path} → ${f.path}` : f.path}
    >
      <span className={cx("w-3 shrink-0 text-center font-mono text-[11px] font-semibold", color)}>{letter}</span>
      <span className="min-w-0 flex-1 truncate">
        <span className="text-fg">{name}</span> <span className="text-faint">{dir}</span>
      </span>
      {f.staged && <Check size={11} className="shrink-0 text-done" aria-label="staged" />}
      <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex" onClick={(e) => e.stopPropagation()}>
        {f.unstaged || f.status === "untracked" ? (
          <IconButton title="Stage file" onClick={() => onAction("stage")}>
            <Plus size={12} />
          </IconButton>
        ) : null}
        {f.staged && (
          <IconButton title="Unstage file" onClick={() => onAction("unstage")}>
            <Minus size={12} />
          </IconButton>
        )}
        <IconButton title="Discard changes" onClick={() => onAction("revert")}>
          <Undo2 size={12} />
        </IconButton>
      </span>
      {f.binary ? <span className="text-[10.5px] text-faint">bin</span> : <DiffStat add={f.additions} del={f.deletions} className="shrink-0 group-hover:hidden" />}
    </div>
  );
}

function CommentBar({ file, line, snippet, onDone }: { file: string; line: number; snippet: string; onDone: () => void }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const send = async () => {
    if (!text.trim()) return;
    if (await sendToAgent(commentPrompt(file, line, text, snippet))) {
      toast("Comment sent to the agent");
      onDone();
    }
  };
  return (
    <div className="border-t border-border bg-panel-2 p-2">
      <div className="mb-1 text-[11px] text-muted">
        Comment on <span className="font-mono text-fg">{file}:{line}</span> — sent to the agent as a prompt
      </div>
      <textarea
        ref={ref}
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || !e.shiftKey)) {
            e.preventDefault();
            void send();
          }
          if (e.key === "Escape") onDone();
        }}
        className="w-full resize-none rounded-md border border-border-strong bg-panel px-2 py-1 text-[12.5px] outline-none focus:border-accent"
        placeholder="What should change here?"
      />
      <div className="mt-1 flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" onClick={() => void send()} disabled={!text.trim()}>
          Send to agent
        </Button>
      </div>
    </div>
  );
}

export default function ChangesPanel({ host, ws }: { host: string; ws: Session }) {
  const status = useStore((s) => s.git[sesKey(host, ws.id)]);
  const [mode, setMode] = useState<Mode>("base");
  // Diff models are kept per file while the panel is open, then released.
  useEffect(() => {
    const prefix = `jaunt-diff://${ws.id}/`;
    // Reopened before a pending cleanup ran: its models are in use again.
    window.clearTimeout(modelCleanup.get(ws.id));
    return () => {
      // After the editor itself has unmounted.
      modelCleanup.set(
        ws.id,
        window.setTimeout(() => {
          modelCleanup.delete(ws.id);
          for (const m of monaco.editor.getModels()) if (m.uri.toString().startsWith(prefix)) m.dispose();
        }, 0),
      );
    };
  }, [ws.id]);
  const selected = useStore((s) => s.diffFile);
  const setSelected = (f: string | null) => useStore.setState({ diffFile: f });
  const [versions, setVersions] = useState<FileVersions | null>(null);
  const [diff, setDiff] = useState<ParsedDiff | null>(null);
  const [sideBySide, setSideBySide] = useState(true);
  const [comment, setComment] = useState<{ line: number; snippet: string } | null>(null);
  const [headStatus, setHeadStatus] = useState<typeof status>(undefined);
  const base = mode === "base" ? ws.base : undefined;
  const files = (mode === "base" ? status : headStatus)?.files ?? [];
  const fsVersion = useStore((s) => s.fsVersion[`${host}|${ws.path}`] ?? 0);
  // Loads that finish after the panel closed (session archived, say) stay quiet.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (mode !== "head") return;
    void rpc<NonNullable<typeof status>>(host, M.gitStatus, { path: ws.path }).then(setHeadStatus).catch(() => {});
  }, [mode, host, ws.path, fsVersion, status]);

  useEffect(() => {
    if (selected && !files.some((f) => f.path === selected)) setSelected(null);
    if (!selected && files.length) setSelected(files[0].path);
  }, [files, selected]);

  const load = useCallback(async () => {
    if (!selected) {
      setVersions(null);
      setDiff(null);
      return;
    }
    try {
      const [v, d] = await Promise.all([
        rpc<FileVersions>(host, M.gitFileVersions, { path: ws.path, file: selected, base }),
        rpc<string>(host, M.gitDiff, { path: ws.path, file: selected, base: undefined }),
      ]);
      setVersions(v);
      setDiff(parseFileDiff(d));
    } catch (e) {
      if (live.current) errorToast(e);
    }
  }, [host, ws.path, selected, base]);

  useEffect(() => {
    void load();
  }, [load, fsVersion]);

  const refresh = () => {
    void refreshGit(host, ws.id);
    void load();
  };

  const fileAction = async (f: FileChange, a: "stage" | "unstage" | "revert") => {
    if (a === "revert") {
      const ok = await confirm(`Discard all changes to ${f.path}? This cannot be undone.`, { title: "Discard changes", kind: "warning" });
      if (!ok) return;
    }
    const method = a === "stage" ? M.gitStage : a === "unstage" ? M.gitUnstage : M.gitRevert;
    try {
      await rpc(host, method, { path: ws.path, files: [f.path] });
      refresh();
    } catch (e) {
      errorToast(e);
    }
  };

  const hunkAction = async (i: number, a: "stage" | "discard") => {
    if (!diff) return;
    if (a === "discard") {
      const ok = await confirm("Discard this hunk from the working tree?", { title: "Discard hunk", kind: "warning" });
      if (!ok) return;
    }
    try {
      await rpc(host, M.gitApplyPatch, { path: ws.path, patch: hunkPatch(diff, i), cached: a === "stage", reverse: a === "discard" });
      refresh();
    } catch (e) {
      errorToast(e);
    }
  };

  const onMount: DiffOnMount = (editor) => {
    const modified = editor.getModifiedEditor();
    modified.updateOptions({ glyphMargin: true });
    const open = (line: number) => {
      const model = modified.getModel();
      const snippet = model ? model.getLineContent(Math.min(line, model.getLineCount())) : "";
      setComment({ line, snippet });
    };
    modified.addAction({
      id: "jaunt.comment",
      label: "Comment to agent",
      contextMenuGroupId: "navigation",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyM],
      run: (ed) => open(ed.getPosition()?.lineNumber ?? 1),
    });
    let deco: string[] = [];
    modified.onMouseMove((e) => {
      const line = e.target.position?.lineNumber;
      deco = modified.deltaDecorations(deco, line ? [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: "jaunt-comment-glyph" } }] : []);
    });
    modified.onMouseDown((e) => {
      if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && e.target.position) open(e.target.position.lineNumber);
    });
  };

  const current = useMemo(() => files.find((f) => f.path === selected), [files, selected]);
  const total = mode === "base" ? status : headStatus;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-[12px]">
        <div className="flex rounded-md border border-border-strong p-0.5">
          {(["base", "head"] as Mode[]).map((m) => (
            <button
              key={m}
              className={cx("rounded px-2 py-0.5", mode === m ? "bg-raised text-fg" : "text-muted hover:text-fg")}
              onClick={() => setMode(m)}
              title={m === "base" ? `Everything since branching from ${ws.base}` : "Uncommitted changes only"}
            >
              {m === "base" ? `Against ${ws.base}` : "Uncommitted"}
            </button>
          ))}
        </div>
        {total && <DiffStat add={total.additions} del={total.deletions} />}
        <span className="ml-auto flex items-center gap-1">
          <IconButton title="Refresh" onClick={refresh}>
            <RotateCcw size={12} />
          </IconButton>
          <Button size="sm" onClick={() => useStore.setState({ dialog: { kind: "commit" } })} disabled={!files.length}>
            Commit…
          </Button>
        </span>
      </div>
      {files.length === 0 ? (
        <Empty icon={<FileDiff size={20} className="text-faint" />} title="No changes yet">
          {mode === "base" ? `Nothing differs from ${ws.base}.` : "The working tree is clean."}
        </Empty>
      ) : (
        <>
          <div className="max-h-[38%] shrink-0 overflow-y-auto border-b border-border py-1">
            {files.map((f) => (
              <FileRow key={f.path} f={f} active={f.path === selected} onSelect={() => setSelected(f.path)} onAction={(a) => void fileAction(f, a)} />
            ))}
          </div>
          {current && (
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-[11.5px] text-muted">
              <span className="truncate font-mono text-fg">{current.path}</span>
              {/* Hunk staging works on uncommitted changes only. */}
              {mode !== "base" && diff && diff.hunks.length > 0 && (
                <span className="flex items-center gap-1">
                  {diff.hunks.map((h, i) => (
                    <span key={i} className="flex items-center rounded border border-border-strong">
                      <span className="px-1 font-mono text-[10.5px] text-faint" title={h.header}>
                        @{h.newStart}
                      </span>
                      <button className="px-1 hover:text-add" title="Stage hunk" onClick={() => void hunkAction(i, "stage")}>
                        <Plus size={11} />
                      </button>
                      <button className="px-1 hover:text-del" title="Discard hunk" onClick={() => void hunkAction(i, "discard")}>
                        <Undo2 size={11} />
                      </button>
                    </span>
                  ))}
                </span>
              )}
              <span className="ml-auto flex items-center gap-1">
                <IconButton title="Comment to agent (⇧⌘M)" onClick={() => setComment({ line: 1, snippet: "" })}>
                  <MessageSquarePlus size={12} />
                </IconButton>
                <button className="rounded px-1.5 py-0.5 hover:bg-hover" onClick={() => setSideBySide(!sideBySide)}>
                  {sideBySide ? "Split" : "Inline"}
                </button>
              </span>
            </div>
          )}
          <div className="min-h-0 flex-1">
            {versions?.binary ? (
              <Empty title="Binary file">No text diff available.</Empty>
            ) : versions && selected ? (
              <DiffEditor
                key={selected + mode}
                theme="jaunt"
                language={languageFor(selected)}
                original={versions.original ?? ""}
                modified={versions.modified ?? ""}
                onMount={onMount}
                // One model pair per file, reused across modes and disposed
                // when the panel closes (see the cleanup effect).
                originalModelPath={`jaunt-diff://${ws.id}/original/${selected}`}
                modifiedModelPath={`jaunt-diff://${ws.id}/modified/${selected}`}
                keepCurrentOriginalModel
                keepCurrentModifiedModel
                options={{ ...editorOptions, readOnly: true, renderIndicators: false, renderMarginRevertIcon: false, renderSideBySide: sideBySide, originalEditable: false, renderOverviewRuler: false, hideUnchangedRegions: { enabled: true } }}
              />
            ) : null}
          </div>
          {comment && selected && <CommentBar file={selected} line={comment.line} snippet={comment.snippet} onDone={() => setComment(null)} />}
        </>
      )}
      <div className="shrink-0 border-t border-border px-3 py-1 text-[10.5px] text-faint">
        Click the gutter or press <Kbd>⇧⌘M</Kbd> to comment a line to the agent.
      </div>
    </div>
  );
}
