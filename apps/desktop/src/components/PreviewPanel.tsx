import { useEffect, useState } from "react";
import { FileText, X } from "lucide-react";
import { rpc } from "../lib/daemon";
import { previewDocument, renderMarkdown } from "../lib/markdown";
import { M, type FileContent } from "../lib/protocol";
import { useStore } from "../lib/store";
import { Empty, IconButton } from "./ui";

/** Rendered Markdown with live reload on file changes (M1, M2). */
export function PreviewPanel() {
  const preview = useStore((s) => s.preview);
  const [doc, setDoc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Any change under a watched root bumps its version; a cheap re-read is fine.
  const version = useStore((s) => (preview ? Object.entries(s.fsVersion).reduce((n, [k, v]) => (k.startsWith(preview.host + "|") && preview.path.startsWith(k.split("|")[1]) ? n + v : n), 0) : 0));

  useEffect(() => {
    if (!preview) return;
    let live = true;
    void rpc<FileContent>(preview.host, M.fsRead, { path: preview.path })
      .then(async (f) => {
        if (!live) return;
        if (f.binary) throw new Error("Not a text file");
        const html = await renderMarkdown(f.content);
        if (live) {
          setDoc(previewDocument(html));
          setError(null);
        }
      })
      .catch((e) => live && setError(String(e?.message ?? e)));
    return () => {
      live = false;
    };
  }, [preview, version]);

  if (!preview) {
    return (
      <Empty icon={<FileText size={20} className="text-faint" />} title="No Markdown open">
        Open a <code>.md</code> file from Files, Changes or a terminal link (⌘-click).
      </Empty>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-[11.5px]">
        <FileText size={12} className="text-muted" />
        <span className="truncate font-mono text-fg" title={preview.path}>
          {preview.path.split("/").slice(-2).join("/")}
        </span>
        <IconButton title="Close preview" className="ml-auto" onClick={() => useStore.setState({ preview: null })}>
          <X size={12} />
        </IconButton>
      </div>
      {error ? (
        <Empty title="Cannot render">{error}</Empty>
      ) : (
        <iframe title="Markdown preview" sandbox="" srcDoc={doc ?? ""} className="min-h-0 flex-1 border-0 bg-[#0e0f12]" />
      )}
    </div>
  );
}
