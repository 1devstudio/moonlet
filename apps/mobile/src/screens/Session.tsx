// A session (X40): its header and the Chat, Terminal, Changes and PR tabs.

import { type ReactNode, useState } from "react";
import { Archive, ChevronLeft, MoreHorizontal } from "lucide-react";
import { rpc } from "@desktop/lib/daemon";
import { M } from "@desktop/lib/protocol";
import { type SessionTab, showScreen, useApp } from "../lib/app";
import { sessionState } from "../lib/inbox";
import { sessionLine, shellTerminals } from "../lib/chatView";
import { useGitStatus } from "../lib/lazy";
import { Sheet } from "../components/Sheet";
import { Btn, StateGlyph, cx } from "../components/ui";
import { ChatTab } from "./Chat";
import { TerminalTab } from "./Terminal";

const TABS: { id: SessionTab; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "terminal", label: "Terminal" },
  { id: "changes", label: "Changes" },
  { id: "pr", label: "PR" },
];

export function SessionScreen({ host, id, tab }: { host: string; id: string; tab: SessionTab }) {
  const d = useApp((s) => s.data[host]);
  const hostLabel = useApp((s) => s.hosts[host]?.label ?? host);
  const session = d?.sessions.find((s) => s.id === id);
  const [git] = useGitStatus(host, session);
  const [menu, setMenu] = useState(false);
  if (!d || !session) {
    return (
      <div className="p-6 text-muted" style={{ paddingTop: "calc(var(--safe-top) + 20px)" }}>
        <button type="button" onClick={() => showScreen(null)} className="mb-4 text-accent-2">
          Back
        </button>
        <p>This session is not available. Its host may be offline.</p>
      </div>
    );
  }
  const project = d.projects.find((p) => p.id === session.project_id);
  const badge: Partial<Record<SessionTab, ReactNode>> = {
    terminal: shellTerminals(d, id).length || null,
    changes: git?.files.length || null,
  };
  const go = (t: SessionTab) => showScreen({ kind: "session", host, id, tab: t });

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-1 px-2 pb-2" style={{ paddingTop: "calc(var(--safe-top) + 6px)" }}>
        <button type="button" aria-label="Back to sessions" onClick={() => showScreen(null)} className="flex h-10 w-10 items-center justify-center text-muted">
          <ChevronLeft size={24} />
        </button>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <StateGlyph state={sessionState(d, session)} />
            <span className="truncate text-[16px] font-semibold">{session.name}</span>
          </div>
          <span className="truncate text-[12px] text-muted">{sessionLine(session, project, hostLabel)}</span>
        </div>
        <button type="button" aria-label="Session actions" onClick={() => setMenu(true)} className="flex h-10 w-10 items-center justify-center text-muted">
          <MoreHorizontal size={20} />
        </button>
      </header>
      <nav className="grid flex-none grid-cols-4 border-b border-border px-2">
        {TABS.map((t) => (
          <button key={t.id} type="button" onClick={() => go(t.id)} className={cx("relative flex h-10 items-center justify-center gap-1.5 text-[14px]", tab === t.id ? "font-semibold text-fg" : "text-muted")}>
            {t.label}
            {badge[t.id] && <span className="rounded-full bg-raised px-1.5 text-[11px] text-muted">{badge[t.id]}</span>}
            {tab === t.id && <span className="absolute right-3 bottom-0 left-3 h-[2px] rounded-full bg-accent" />}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1">
        {tab === "chat" && <ChatTab host={host} session={session} />}
        {tab === "terminal" && <TerminalTab host={host} session={session} />}
        {(tab === "changes" || tab === "pr") && <div className="p-6 text-muted">Coming in the next part of the stack.</div>}
      </div>
      {menu && (
        <Sheet label="Session actions" onClose={() => setMenu(false)}>
          <div className="flex flex-col gap-2 px-4 pb-2">
            <Btn
              onClick={async () => {
                setMenu(false);
                await rpc(host, M.sessionArchive, { id }).catch(console.error);
                showScreen(null);
              }}
            >
              <Archive size={16} /> Archive session
            </Btn>
            <Btn tone="ghost" onClick={() => setMenu(false)}>
              Cancel
            </Btn>
          </div>
        </Sheet>
      )}
    </div>
  );
}
