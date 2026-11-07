import { useMemo, type SyntheticEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { codeToCopy, openableUrl, renderChatMarkdown } from "@desktop/lib/markdown";

/** Agent Markdown, rendered and sanitised as on the desktop; links open in the browser. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => renderChatMarkdown(text), [text]);
  /** Copies a code block when the event is on its copy control (X87). */
  const copyCode = (e: SyntheticEvent, key?: string) => {
    const code = codeToCopy(e.target as Element, key);
    if (code === null) return false;
    e.preventDefault();
    void navigator.clipboard?.writeText(code).catch(console.error);
    return true;
  };
  return (
    <div
      className={`chat-md selectable text-[14.5px] leading-[1.5] ${className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
      onKeyDown={(e) => copyCode(e, e.key)}
      onClick={(e) => {
        if (copyCode(e)) return;
        const a = (e.target as HTMLElement).closest("a");
        if (!a) return;
        e.preventDefault();
        const url = openableUrl(a.getAttribute("href"));
        if (url) void openUrl(url);
      }}
    />
  );
}
