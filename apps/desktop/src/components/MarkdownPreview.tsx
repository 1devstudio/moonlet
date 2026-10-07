import { useEffect, useMemo, useState } from "react";
import { previewDocument, renderMarkdown } from "../lib/markdown";
import { useStore } from "../lib/store";
import { uiScale } from "../lib/uiScale";
import { Empty } from "./ui";

/** Rendered Markdown (M1, M2) in a sandboxed frame, inside a file's tab (X26). */
export function MarkdownPreview({ text }: { text: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scale = useStore((s) => uiScale(s.settings.term.fontSize));
  const doc = useMemo(() => (html === null ? null : previewDocument(html, scale)), [html, scale]);
  useEffect(() => {
    let live = true;
    renderMarkdown(text)
      .then((h) => {
        if (!live) return;
        setHtml(h);
        setError(null);
      })
      .catch((e) => live && setError(String(e?.message ?? e)));
    return () => {
      live = false;
    };
  }, [text]);
  if (error) return <Empty title="Cannot render">{error}</Empty>;
  return <iframe title="Markdown preview" sandbox="" srcDoc={doc ?? ""} className="h-full w-full border-0 bg-bg" />;
}
