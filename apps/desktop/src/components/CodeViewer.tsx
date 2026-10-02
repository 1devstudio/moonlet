import { useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { Lock, Pencil, Save, X } from "lucide-react";
import "../lib/monaco";
import { editorOptions, languageFor, monaco } from "../lib/monaco";
import { rpc } from "../lib/daemon";
import { M, type FileContent } from "../lib/protocol";
import { errorToast, toast } from "../lib/store";
import { Empty, IconButton, cx } from "./ui";

/** Read-mostly viewer with light editing (F2): editing is an explicit toggle. */
export default function CodeViewer({ host, path, line, onClose }: { host: string; path: string; line?: number; onClose: () => void }) {
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const editor = useRef<Parameters<OnMount>[0] | null>(null);

  useEffect(() => {
    void rpc<FileContent>(host, M.fsRead, { path })
      .then(setFile)
      .catch((e) => setError(String(e.message ?? e)));
  }, [host, path]);

  const save = async () => {
    const value = editor.current?.getValue();
    if (value === undefined) return;
    try {
      await rpc(host, M.fsWrite, { path, content: value });
      setDirty(false);
      toast(`Saved ${path.split("/").pop()}`);
    } catch (e) {
      errorToast(e);
    }
  };

  const onMount: OnMount = (ed) => {
    editor.current = ed;
    if (line) {
      ed.revealLineInCenter(line);
      ed.setPosition({ lineNumber: line, column: 1 });
    }
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save());
  };

  const readOnly = !editing || !!file?.truncated;
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-[11.5px]">
        <span className="truncate font-mono text-fg" title={path}>
          {path.split("/").pop()}
          {dirty && " •"}
        </span>
        {file?.truncated && <span className="text-blocked">truncated</span>}
        <span className="ml-auto flex items-center gap-0.5">
          {editing && (
            <IconButton title="Save (⌘S)" disabled={!dirty} onClick={() => void save()}>
              <Save size={12} />
            </IconButton>
          )}
          <IconButton
            title={editing ? "Stop editing" : "Edit"}
            disabled={!file || file.binary || file.truncated}
            className={cx(editing && "text-accent")}
            onClick={() => setEditing(!editing)}
          >
            {editing ? <Lock size={12} /> : <Pencil size={12} />}
          </IconButton>
          <IconButton title="Close file" onClick={onClose}>
            <X size={12} />
          </IconButton>
        </span>
      </div>
      <div className="min-h-0 flex-1">
        {error ? (
          <Empty title="Cannot open file">{error}</Empty>
        ) : file?.binary ? (
          <Empty title="Binary file">{(file.size / 1024).toFixed(1)} KB</Empty>
        ) : file ? (
          <Editor
            theme="jaunt"
            language={languageFor(path)}
            defaultValue={file.content}
            onMount={onMount}
            onChange={() => setDirty(true)}
            options={{ ...editorOptions, readOnly, domReadOnly: readOnly }}
          />
        ) : null}
      </div>
    </div>
  );
}
