import { useMemo } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { codeToCopy, openableUrl, renderChatMarkdown } from "@desktop/lib/markdown";

/** Agent Markdown, rendered and sanitised as on the desktop; links open in the browser. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => renderChatMarkdown(text), [text]);
  return (
    <div
      className={`chat-md selectable text-[14.5px] leading-[1.5] ${className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        // A code block's copy control (X87).
        const code = codeToCopy(e.target as Element);
        if (code !== null) {
          void navigator.clipboard?.writeText(code).catch(console.error);
          return;
        }
        const a = (e.target as HTMLElement).closest("a");
        if (!a) return;
        e.preventDefault();
        const url = openableUrl(a.getAttribute("href"));
        if (url) void openUrl(url);
      }}
    />
  );
}
