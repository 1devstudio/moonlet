import { useCallback, useEffect, useRef, useState } from "react";
import { DiffEditor, type DiffOnMount } from "@monaco-editor/react";
import { MessageSquarePlus, Plus, Undo2 } from "lucide-react";
import { editorOptions, monaco, useEditorLanguage } from "../lib/monaco";
import { rpc } from "../lib/daemon";
import type { DiffMode } from "../lib/layout";
import { isMarkdownPath } from "../lib/markdown";
import { commentPrompt, hunkPatch, parseFileDiff, type FileDiff as ParsedDiff } from "../lib/patch";
import { M, type FileVersions } from "../lib/protocol";
import { errorToast, refreshGit, toast, useStore } from "../lib/store";
import { sendToAgent } from "../lib/actions";
import { askConfirm } from "../lib/confirm";
import { editorFont } from "../lib/uiScale";
import { Button, Empty, IconButton, Kbd, cx } from "./ui";
import { MarkdownPreview } from "./MarkdownPreview";

/** Pending diff-model cleanups per tab, cancelled if the tab mounts again. */
const modelCleanup = new Map<string, number>();

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

/**
 * A changed file's diff in a tab of the main window (X77): split or inline,
 * hunk staging on uncommitted changes, comments to the agent, and for a
 * Markdown file a Preview of its new version.
 */
export default function DiffView({ host, wsId, path, mode }: { host: string; wsId: string; path: string; mode: DiffMode }) {
  const ws = useStore((s) => s.sessions[host]?.find((w) => w.id === wsId));
  const fontSize = useStore((s) => s.settings.term.fontSize);
  const fsVersion = useStore((s) => (ws ? (s.fsVersion[`${host}|${ws.path}`] ?? 0) : 0));
  const language = useEditorLanguage(path);
  const [versions, setVersions] = useState<FileVersions | null>(null);
  const [diff, setDiff] = useState<ParsedDiff | null>(null);
  const [sideBySide, setSideBySide] = useState(true);
  const [preview, setPreview] = useState(false);
  const [comment, setComment] = useState<{ line: number; snippet: string } | null>(null);
  // Loads that finish after the tab closed stay quiet.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const wsPath = ws?.path;
  const base = mode === "base" ? ws?.base : undefined;
  // One model pair per tab, released with it. The mode is in the name: the
  // same file against the base and uncommitted are two different pairs.
  const modelPath = (side: "original" | "modified") => `moonlet-diff://${wsId}/${mode}/${side}/${path}`;
  useEffect(() => {
    const key = `moonlet-diff://${wsId}/${mode}/${path}`;
    const uris = (["original", "modified"] as const).map((side) => monaco.Uri.parse(`moonlet-diff://${wsId}/${mode}/${side}/${path}`).toString());
    // Mounted again before a pending cleanup ran: its models are in use again.
    window.clearTimeout(modelCleanup.get(key));
    return () => {
      // After the editor itself has unmounted.
      modelCleanup.set(
        key,
        window.setTimeout(() => {
          modelCleanup.delete(key);
          for (const m of monaco.editor.getModels()) if (uris.includes(m.uri.toString())) m.dispose();
        }, 0),
      );
    };
  }, [wsId, mode, path]);

  // Watch the worktree so changes on disk arrive while the right panel is closed.
  useEffect(() => {
    if (!wsPath) return;
    void rpc(host, M.fsWatch, { path: wsPath }).catch(() => {});
    return () => void rpc(host, M.fsUnwatch, { path: wsPath }).catch(() => {});
  }, [host, wsPath]);

  const load = useCallback(async () => {
    if (!wsPath) return;
    try {
      const [v, d] = await Promise.all([
        rpc<FileVersions>(host, M.gitFileVersions, { path: wsPath, file: path, base }),
        rpc<string>(host, M.gitDiff, { path: wsPath, file: path, base: undefined }),
      ]);
      if (!live.current) return;
      setVersions(v);
      setDiff(parseFileDiff(d));
    } catch (e) {
      if (live.current) errorToast(e);
    }
  }, [host, wsPath, path, base]);

  useEffect(() => {
    void load();
  }, [load, fsVersion]);

  const hunkAction = async (i: number, a: "stage" | "discard") => {
    if (!diff || !wsPath) return;
    if (a === "discard") {
      const ok = await askConfirm({ title: "Discard hunk", message: "Discard this hunk from the working tree?", action: "Discard", variant: "danger" });
      if (!ok) return;
    }
    try {
      await rpc(host, M.gitApplyPatch, { path: wsPath, patch: hunkPatch(diff, i), cached: a === "stage", reverse: a === "discard" });
      void refreshGit(host, wsId);
      void load();
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

  if (!ws) return <Empty title="Session not found">Its diff cannot be shown.</Empty>;
  const markdown = isMarkdownPath(path) && !!versions && !versions.binary && versions.modified !== null;
  const showPreview = preview && markdown;

  return (
    <div className="flex h-full flex-col bg-[#121212]">
      <div className="flex h-[30px] shrink-0 items-center gap-2 border-b border-border px-4 ui-text-12">
        <span className="truncate font-mono text-muted" title={path}>
          {path}
        </span>
        <span className="shrink-0 text-faint">{mode === "base" ? `against ${ws.base}` : "uncommitted"}</span>
        {/* Hunk staging works on uncommitted changes only. */}
        {mode === "head" && !showPreview && diff && diff.hunks.length > 0 && (
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
        <span className="ml-auto flex items-center gap-2">
          {markdown && (
            <div className="flex rounded-md border border-border-strong p-0.5 ui-text-11.5">
              {(["Diff", "Preview"] as const).map((m) => (
                <button key={m} className={cx("rounded px-2 py-px", (m === "Preview") === preview ? "bg-raised text-fg" : "text-muted hover:text-fg")} onClick={() => setPreview(m === "Preview")}>
                  {m}
                </button>
              ))}
            </div>
          )}
          {!showPreview && (
            <>
              <IconButton title="Comment to agent (⇧⌘M)" onClick={() => setComment({ line: 1, snippet: "" })}>
                <MessageSquarePlus size={12} />
              </IconButton>
              <button className="rounded px-1.5 py-0.5 text-muted hover:bg-hover" onClick={() => setSideBySide(!sideBySide)}>
                {sideBySide ? "Split" : "Inline"}
              </button>
            </>
          )}
        </span>
      </div>
      {showPreview && (
        <div className="min-h-0 flex-1">
          <MarkdownPreview text={versions?.modified ?? ""} />
        </div>
      )}
      {/* Hidden, not unmounted, while previewing: it keeps the scroll and the models. */}
      <div className={cx("min-h-0 flex-1", showPreview && "hidden")}>
        {versions?.binary ? (
          <Empty title="Binary file">No text diff available.</Empty>
        ) : versions && language ? (
          <DiffEditor
            theme="moonlet"
            language={language}
            original={versions.original ?? ""}
            modified={versions.modified ?? ""}
            onMount={onMount}
            originalModelPath={modelPath("original")}
            modifiedModelPath={modelPath("modified")}
            keepCurrentOriginalModel
            keepCurrentModifiedModel
            options={{ ...editorOptions, ...editorFont(fontSize), readOnly: true, renderIndicators: false, renderMarginRevertIcon: false, renderSideBySide: sideBySide, originalEditable: false, renderOverviewRuler: false, hideUnchangedRegions: { enabled: true } }}
          />
        ) : null}
      </div>
      {comment && !showPreview && <CommentBar file={path} line={comment.line} snippet={comment.snippet} onDone={() => setComment(null)} />}
      {!showPreview && (
        <div className="shrink-0 border-t border-border px-3 py-1 ui-text-10.5 text-faint">
          Click the gutter or press <Kbd>⇧⌘M</Kbd> to comment a line to the agent.
        </div>
      )}
    </div>
  );
}
