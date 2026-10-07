import { useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { editorOptions, monaco, useEditorLanguage } from "../lib/monaco";
import { rpc } from "../lib/daemon";
import { M, type FileContent } from "../lib/protocol";
import { errorToast, toast, useStore } from "../lib/store";
import { editorFont } from "../lib/uiScale";
import { Empty, cx } from "./ui";
import { MarkdownPreview } from "./MarkdownPreview";

/**
 * A file in an editor tab of the main window (X26): writable at once, ⌘S
 * saves. A change on disk shows when there are no unsaved edits.
 */
export default function FileEditor({ host, wsId, path, line, visible }: { host: string; wsId: string; path: string; line?: number; visible: boolean }) {
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editor = useRef<Parameters<OnMount>[0] | null>(null);
  /** The text last read or saved; the tab is unsaved while the editor differs. */
  const saved = useRef("");
  const fontSize = useStore((s) => s.settings.term.fontSize);
  const root = useStore((s) => s.sessions[host]?.find((w) => w.id === wsId)?.path ?? null);
  const fsVersion = useStore((s) => (root ? (s.fsVersion[`${host}|${root}`] ?? 0) : 0));
  const language = useEditorLanguage(path);
  const key = `${host}|${path}`;
  const readOnly = !file || file.truncated;
  const markdown = /\.(md|markdown|mdx)$/i.test(path);
  /** The editor's text while a markdown file shows rendered; null shows the source. */
  const [preview, setPreview] = useState<string | null>(null);

  const setDirty = (dirty: boolean) =>
    useStore.setState((s) => {
      // Unchanged: the same state, so no subscriber is notified.
      if (!!s.dirtyFiles[key] === dirty) return s;
      const dirtyFiles = { ...s.dirtyFiles };
      if (dirty) dirtyFiles[key] = true;
      else delete dirtyFiles[key];
      return { dirtyFiles };
    });

  // Watch the worktree so changes on disk arrive while the right panel is closed.
  useEffect(() => {
    if (!root) return;
    void rpc(host, M.fsWatch, { path: root }).catch(() => {});
    return () => void rpc(host, M.fsUnwatch, { path: root }).catch(() => {});
  }, [host, root]);

  useEffect(() => {
    let live = true;
    void rpc<FileContent>(host, M.fsRead, { path })
      .then((f) => {
        if (!live) return;
        const model = editor.current?.getModel();
        if (!model || model.getValue() === f.content) saved.current = f.content;
        else if (model.getValue() === saved.current && !f.binary) {
          // No unsaved edits: show what is on disk, undoably. The user's
          // unsaved text is otherwise kept.
          saved.current = f.content;
          model.pushEditOperations([], [{ range: model.getFullModelRange(), text: f.content }], () => null);
        }
        setFile(f);
      })
      // Once open, a failed re-read (the file was deleted, say) keeps the
      // editor and its text; saving writes the file again.
      .catch((e) => live && !editor.current && setError(String(e.message ?? e)));
    return () => {
      live = false;
    };
  }, [host, path, fsVersion]);

  const save = async () => {
    const value = editor.current?.getValue();
    if (value === undefined || readOnly) return;
    try {
      await rpc(host, M.fsWrite, { path, content: value });
      saved.current = value;
      setDirty(false);
      toast(`Saved ${path.split("/").pop()}`);
    } catch (e) {
      errorToast(e);
    }
  };
  // The ⌘S command is registered once; it calls the latest save.
  const saveRef = useRef(save);
  saveRef.current = save;

  const reveal = (ed: Parameters<OnMount>[0], at: number | undefined) => {
    if (!at) return;
    ed.revealLineInCenter(at);
    ed.setPosition({ lineNumber: at, column: 1 });
  };

  const onMount: OnMount = (ed) => {
    editor.current = ed;
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current());
    reveal(ed, line);
    if (visible) ed.focus();
  };

  // Opened again at another line, from a terminal link (F3).
  useEffect(() => {
    if (editor.current) reveal(editor.current, line);
  }, [line]);

  useEffect(() => {
    if (visible) editor.current?.focus();
  }, [visible]);

  const rel = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  return (
    <div className="flex h-full flex-col bg-[#121212]">
      <div className="flex h-[30px] shrink-0 items-center gap-2 border-b border-border px-4 ui-text-12">
        <span className="truncate font-mono text-muted" title={path}>
          {rel}
        </span>
        {file?.truncated && <span className="text-blocked">truncated · read-only</span>}
        {markdown && file && !file.binary && (
          <div className="ml-auto flex rounded-md border border-border-strong p-0.5 ui-text-11.5">
            {(["Source", "Preview"] as const).map((m) => (
              <button
                key={m}
                className={cx("rounded px-2 py-px", (m === "Preview") === (preview !== null) ? "bg-raised text-fg" : "text-muted hover:text-fg")}
                onClick={() => setPreview(m === "Preview" ? (editor.current?.getValue() ?? file.content) : null)}
              >
                {m}
              </button>
            ))}
          </div>
        )}
      </div>
      {preview !== null && (
        <div className="min-h-0 flex-1">
          <MarkdownPreview text={preview} />
        </div>
      )}
      {/* Hidden, not unmounted, while previewing: it keeps unsaved edits and undo. */}
      <div className={cx("min-h-0 flex-1", preview !== null && "hidden")}>
        {error ? (
          <Empty title="Cannot open file">{error}</Empty>
        ) : file?.binary ? (
          <Empty title="Binary file">{(file.size / 1024).toFixed(1)} KB</Empty>
        ) : file && language ? (
          <Editor
            theme="jaunt"
            language={language}
            defaultValue={file.content}
            onMount={onMount}
            onChange={(v) => {
              setDirty((v ?? "") !== saved.current);
              // A change on disk while previewing shows at once.
              setPreview((p) => (p === null ? null : (v ?? "")));
            }}
            options={{ ...editorOptions, ...editorFont(fontSize), readOnly, domReadOnly: readOnly }}
          />
        ) : null}
      </div>
    </div>
  );
}
