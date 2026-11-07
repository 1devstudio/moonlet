import { useMemo, type SyntheticEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { codeToCopy, openableUrl, renderChatMarkdown, renderUserMarkdown } from "@desktop/lib/markdown";

/**
 * Agent Markdown, rendered and sanitised as on the desktop; links open in the
 * browser. `user` renders a message the user sent (X92), its newlines kept.
 */
export function Markdown({ text, className, user = false }: { text: string; className?: string; user?: boolean }) {
  const html = useMemo(() => (user ? renderUserMarkdown(text) : renderChatMarkdown(text)), [text, user]);
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
      className={`chat-md selectable text-[14.5px] leading-[1.5] ${user ? "user-md" : ""} ${className ?? ""}`}
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
