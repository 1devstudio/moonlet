import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DiffEditor, type DiffOnMount } from "@monaco-editor/react";
import { ArrowLeft, Check, ChevronDown, ChevronRight, FileDiff, Folder, FolderOpen, List, ListTree, Minus, MessageSquarePlus, Plus, RotateCcw, SquareDot, SquareMinus, SquarePlus, Undo2 } from "lucide-react";
import "../lib/monaco";

/** Pending diff-model cleanups per session, cancelled if the panel reopens. */
const modelCleanup = new Map<string, number>();
import { editorOptions, monaco, useEditorLanguage } from "../lib/monaco";
import { rpc } from "../lib/daemon";
import { commentPrompt, hunkPatch, parseFileDiff, type FileDiff as ParsedDiff } from "../lib/patch";
import { changeCount, changeList, changeTree, type ChangeNode } from "../lib/changes";
import { M, type FileChange, type FileVersions, type GitStatus, type Session } from "../lib/protocol";
import { errorToast, refreshGit, toast, useStore, sesKey } from "../lib/store";
import { sendToAgent } from "../lib/actions";
import { askConfirm } from "../lib/confirm";
import { editorFont } from "../lib/uiScale";
import { Button, DiffStat, Empty, IconButton, Kbd, cx } from "./ui";

type Mode = "base" | "head";
type FileAction = "stage" | "unstage" | "revert";

function StatusBox({ status }: { status: FileChange["status"] }) {
  const p = { size: 14, strokeWidth: 1.5 };
  if (status === "added" || status === "untracked") return <SquarePlus {...p} className="shrink-0 text-add" />;
  if (status === "deleted" || status === "conflicted") return <SquareMinus {...p} className="shrink-0 text-del" />;
  return <SquareDot {...p} className="shrink-0 text-blocked" />;
}

function SummaryLine({ status }: { status: GitStatus }) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-5 py-3 ui-text-14 text-muted">
      <span>
        {status.files.length} file{status.files.length === 1 ? "" : "s"} changed
      </span>
      {status.base_missing && (
        <span className="ui-text-12 text-blocked" title={`"${status.base_missing}" was not found (not fetched?), so only uncommitted changes against HEAD are shown.`}>
          base not found · showing HEAD
        </span>
      )}
      <span className="ml-auto font-mono ui-text-12.5 tabular-nums">
        <span className="text-add">+{status.additions}</span> <span className="text-del">−{status.deletions}</span>
      </span>
    </div>
  );
}

/** Left padding of a tree row at `depth`, and how far each level indents (X28). */
const PAD = 12;
const INDENT = 18;

/** A changed file's row: status, name, counts, and stage/unstage/discard on hover. */
function FileRow({ f, depth = 0, children, onSelect, onAction }: { f: FileChange; depth?: number; children: ReactNode; onSelect: (path: string) => void; onAction: (f: FileChange, a: FileAction) => void }) {
  return (
    <div
      role="button"
      title={f.old_path ? `${f.old_path} → ${f.path}` : f.path}
      className="group mx-2 flex h-[34px] cursor-default items-center gap-3 rounded-md pr-3 text-left hover:bg-raised"
      style={{ paddingLeft: PAD + depth * INDENT }}
      onClick={() => onSelect(f.path)}
    >
      <span className={cx("flex min-w-0 flex-1 ui-text-14", f.status === "deleted" && "line-through")}>{children}</span>
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
      <span className="flex shrink-0 items-center gap-2 group-hover:hidden">
        <span className="font-mono ui-text-12 tabular-nums">
          {changeCount(f)
            .split(" ")
            .map((c) => (
              <span key={c} className={cx("ml-1.5", c.startsWith("+") ? "text-add" : c.startsWith("−") ? "text-del" : "text-muted")}>
                {c}
              </span>
            ))}
        </span>
        <StatusBox status={f.status} />
      </span>
    </div>
  );
}

/** Changed files in path order, the folder dimmed and cut short before the name (X28). */
function ChangeListView({ files, onSelect, onAction }: { files: FileChange[]; onSelect: (path: string) => void; onAction: (f: FileChange, a: FileAction) => void }) {
  const rows = useMemo(() => changeList(files), [files]);
  return (
    <div className="py-2">
      {rows.map((f) => (
        <FileRow key={f.path} f={f} onSelect={onSelect} onAction={onAction}>
          <span className="min-w-0 truncate text-muted">{f.dir}</span>
          <span className={cx("max-w-full shrink-0 truncate", f.status === "deleted" ? "text-muted" : "text-fg")}>{f.name}</span>
        </FileRow>
      ))}
    </div>
  );
}

/** Changed files as a folder tree with indent guides; folders collapse (X28). */
function ChangeTreeView({ files, onSelect, onAction }: { files: FileChange[]; onSelect: (path: string) => void; onAction: (f: FileChange, a: FileAction) => void }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const tree = useMemo(() => changeTree(files), [files]);
  const render = (nodes: ChangeNode[], depth: number): ReactNode =>
    nodes.map((n) =>
      n.kind === "file" ? (
        <FileRow key={n.file.path} f={n.file} depth={depth} onSelect={onSelect} onAction={onAction}>
          <span className={cx("truncate", n.file.status === "deleted" ? "text-muted" : "text-fg")}>{n.name}</span>
        </FileRow>
      ) : (
        <div key={n.path}>
          <button
            className="mx-2 flex h-[34px] w-[calc(100%-16px)] items-center gap-1 rounded-md pr-3 text-left font-mono ui-text-13 text-muted hover:bg-raised hover:text-fg"
            style={{ paddingLeft: PAD + depth * INDENT }}
            title={n.path}
            onClick={() => setCollapsed((c) => ({ ...c, [n.path]: !c[n.path] }))}
          >
            <span className="flex w-[14px] shrink-0 justify-center">{collapsed[n.path] ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</span>
            {collapsed[n.path] ? <Folder size={14} strokeWidth={1.5} className="shrink-0" /> : <FolderOpen size={14} strokeWidth={1.5} className="shrink-0" />}
            <span className="ml-1 truncate">{n.name.split("/").join(" / ")}</span>
          </button>
          {!collapsed[n.path] && (
            <div className="relative">
              <span className="absolute bottom-0 top-0 w-px bg-border" style={{ left: 8 + PAD + depth * INDENT + 7 }} />
              {render(n.children, depth + 1)}
            </div>
          )}
        </div>
      ),
    );
  return <div className="py-2">{render(tree, 0)}</div>;
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
  const view = useStore((s) => s.changesView);
  const [mode, setMode] = useState<Mode>("base");
  // Diff models are kept per file while the panel is open, then released.
  useEffect(() => {
    const prefix = `moonlet-diff://${ws.id}/`;
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
      id: "moonlet.comment",
      label: "Comment to agent",
      contextMenuGroupId: "navigation",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyM],
      run: (ed) => open(ed.getPosition()?.lineNumber ?? 1),
    });
    let deco: string[] = [];
    modified.onMouseMove((e) => {
      const line = e.target.position?.lineNumber;
      deco = modified.deltaDecorations(deco, line ? [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: "moonlet-comment-glyph" } }] : []);
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
          {!selected && files.length > 0 && (
            <IconButton title={view === "tree" ? "Show as list" : "Show as tree"} onClick={() => useStore.setState({ changesView: view === "tree" ? "list" : "tree" })}>
              {view === "tree" ? <List size={12} /> : <ListTree size={12} />}
            </IconButton>
          )}
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
          {total && <SummaryLine status={total} />}
          {view === "tree" ? (
            <ChangeTreeView files={files} onSelect={setSelected} onAction={(f, a) => void fileAction(f, a)} />
          ) : (
            <ChangeListView files={files} onSelect={setSelected} onAction={(f, a) => void fileAction(f, a)} />
          )}
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
                theme="moonlet"
                language={language}
                original={versions.original ?? ""}
                modified={versions.modified ?? ""}
                onMount={onMount}
                // One model pair per file, reused across modes and disposed
                // when the panel closes (see the cleanup effect).
                originalModelPath={`moonlet-diff://${ws.id}/original/${selected}`}
                modifiedModelPath={`moonlet-diff://${ws.id}/modified/${selected}`}
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
