import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DiffEditor, type DiffOnMount } from "@monaco-editor/react";
import { ArrowLeft, ArrowRight, Check, ChevronDown, ChevronRight, FileDiff, Minus, MessageSquarePlus, Plus, RotateCcw, SquareDot, SquareMinus, SquarePlus, Undo2 } from "lucide-react";
import "../lib/monaco";

/** Pending diff-model cleanups per session, cancelled if the panel reopens. */
const modelCleanup = new Map<string, number>();
import { editorOptions, monaco, useEditorLanguage } from "../lib/monaco";
import { rpc } from "../lib/daemon";
import { commentPrompt, hunkPatch, parseFileDiff, type FileDiff as ParsedDiff } from "../lib/patch";
import { changeCount, groupByDir } from "../lib/changes";
import { M, type FileChange, type FileVersions, type GitStatus, type Session } from "../lib/protocol";
import { errorToast, refreshGit, toast, useStore, sesKey } from "../lib/store";
import { sendToAgent } from "../lib/actions";
import { askConfirm } from "../lib/confirm";
import { editorFont } from "../lib/uiScale";
import { Button, DiffStat, Empty, IconButton, Kbd, cx } from "./ui";

type Mode = "base" | "head";
type FileAction = "stage" | "unstage" | "revert";

function StatusBox({ status }: { status: FileChange["status"] }) {
  const p = { size: 14, strokeWidth: 1.5, className: "shrink-0 text-muted" };
  if (status === "added" || status === "untracked") return <SquarePlus {...p} />;
  if (status === "deleted") return <SquareMinus {...p} />;
  return <SquareDot {...p} />;
}

function SummaryLine({ status, against }: { status: GitStatus; against: string }) {
  return (
    <div className="flex items-center gap-2 px-5 pb-1 pt-4 font-mono ui-text-12.5 text-muted">
      <span className="text-add">+{status.additions}</span>
      <span className="text-del">−{status.deletions}</span>
      <span className="text-faint">·</span>
      <span>
        {status.files.length} file{status.files.length === 1 ? "" : "s"}
      </span>
      <span className="text-faint">·</span>
      <ArrowRight size={12} />
      <span className="rounded bg-raised px-1.5 py-0.5 text-fg">{against}</span>
      {status.base_missing && (
        <span className="text-blocked" title={`"${status.base_missing}" was not found (not fetched?), so only uncommitted changes against HEAD are shown.`}>
          base not found · showing HEAD
        </span>
      )}
    </div>
  );
}

/** Changed files grouped by folder (X25); a click opens the file's diff. */
function ChangedFiles({ files, onSelect, onAction }: { files: FileChange[]; onSelect: (path: string) => void; onAction: (f: FileChange, a: FileAction) => void }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => groupByDir(files), [files]);
  return (
    <div className="pb-4">
      {groups.map(({ dir, files }) => (
        <div key={dir} className="mt-3">
          <button
            className="flex w-full items-center gap-2 px-5 py-1.5 text-left font-mono ui-text-12 tracking-[0.06em] text-muted hover:text-fg"
            onClick={() => setCollapsed((c) => ({ ...c, [dir]: !c[dir] }))}
          >
            {collapsed[dir] ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            <span className="truncate">{dir}</span>
          </button>
          {!collapsed[dir] &&
            files.map((f) => (
              <div
                key={f.path}
                role="button"
                title={f.old_path ? `${f.old_path} → ${f.path}` : f.path}
                className="group flex h-[38px] w-full cursor-default items-center gap-3 pl-[34px] pr-5 text-left hover:bg-panel-2"
                onClick={() => onSelect(f.path)}
              >
                <StatusBox status={f.status} />
                <span className={cx("min-w-0 flex-1 truncate ui-text-14", f.status === "deleted" ? "text-muted line-through" : "text-fg")}>{f.name}</span>
                {f.staged && <Check size={12} className="shrink-0 text-done" aria-label="staged" />}
                <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex" onClick={(e) => e.stopPropagation()}>
                  {(f.unstaged || f.status === "untracked") && (
                    <IconButton title="Stage file" onClick={() => onAction(f, "stage")}>
                      <Plus size={12} />
                    </IconButton>
                  )}
                  {f.staged && (
                    <IconButton title="Unstage file" onClick={() => onAction(f, "unstage")}>
                      <Minus size={12} />
                    </IconButton>
                  )}
                  <IconButton title="Discard changes" onClick={() => onAction(f, "revert")}>
                    <Undo2 size={12} />
                  </IconButton>
                </span>
                <span className="shrink-0 font-mono ui-text-12 tabular-nums text-muted group-hover:hidden">{changeCount(f)}</span>
              </div>
            ))}
        </div>
      ))}
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
      <div className="mb-1 ui-text-11 text-muted">
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
        className="w-full resize-none rounded-md border border-border-strong bg-panel px-2 py-1 ui-text-12.5 outline-none focus:border-accent"
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
  const fontSize = useStore((s) => s.settings.term.fontSize);
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

  const fileAction = async (f: FileChange, a: FileAction) => {
    if (a === "revert") {
      const ok = await askConfirm({ title: "Discard changes", message: `Discard all changes to ${f.path}? This cannot be undone.`, action: "Discard", variant: "danger" });
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
      const ok = await askConfirm({ title: "Discard hunk", message: "Discard this hunk from the working tree?", action: "Discard", variant: "danger" });
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
  const language = useEditorLanguage(selected);
  const total = mode === "base" ? status : headStatus;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 ui-text-12">
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
        {total && selected && <DiffStat add={total.additions} del={total.deletions} />}
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
      ) : !selected ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {total && <SummaryLine status={total} against={mode === "base" ? ws.base : "HEAD"} />}
          <ChangedFiles files={files} onSelect={setSelected} onAction={(f, a) => void fileAction(f, a)} />
        </div>
      ) : (
        <>
          {current && (
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1 ui-text-11.5 text-muted">
              <IconButton title="Back to the changed files" onClick={() => setSelected(null)}>
                <ArrowLeft size={13} />
              </IconButton>
              <span className="truncate font-mono text-fg">{current.path}</span>
              {/* Hunk staging works on uncommitted changes only. */}
              {mode !== "base" && diff && diff.hunks.length > 0 && (
                <span className="flex items-center gap-1">
                  {diff.hunks.map((h, i) => (
                    <span key={i} className="flex items-center rounded border border-border-strong">
                      <span className="px-1 font-mono ui-text-10.5 text-faint" title={h.header}>
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
            ) : versions && selected && language ? (
              <DiffEditor
                key={selected + mode}
                theme="jaunt"
                language={language}
                original={versions.original ?? ""}
                modified={versions.modified ?? ""}
                onMount={onMount}
                // One model pair per file, reused across modes and disposed
                // when the panel closes (see the cleanup effect).
                originalModelPath={`jaunt-diff://${ws.id}/original/${selected}`}
                modifiedModelPath={`jaunt-diff://${ws.id}/modified/${selected}`}
                keepCurrentOriginalModel
                keepCurrentModifiedModel
                options={{ ...editorOptions, ...editorFont(fontSize), readOnly: true, renderIndicators: false, renderMarginRevertIcon: false, renderSideBySide: sideBySide, originalEditable: false, renderOverviewRuler: false, hideUnchangedRegions: { enabled: true } }}
              />
            ) : null}
          </div>
          {comment && selected && <CommentBar file={selected} line={comment.line} snippet={comment.snippet} onDone={() => setComment(null)} />}
        </>
      )}
      {selected && (
        <div className="shrink-0 border-t border-border px-3 py-1 ui-text-10.5 text-faint">
          Click the gutter or press <Kbd>⇧⌘M</Kbd> to comment a line to the agent.
        </div>
      )}
    </div>
  );
}
