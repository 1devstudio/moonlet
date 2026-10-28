// An agent without a session, such as a design's (X65): its chat, opened
// from the Inbox.

import { ChevronLeft } from "lucide-react";
import { agentPlace } from "@desktop/lib/alerts";
import { showScreen, useApp } from "../lib/app";
import { StateGlyph } from "../components/ui";
import { ChatView } from "./Chat";

export function AgentScreen({ host, terminal }: { host: string; terminal: number }) {
  const t = useApp((s) => s.data[host]?.terminals[terminal]);
  const hostLabel = useApp((s) => s.hosts[host]?.label ?? host);
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-1 border-b border-border px-2 pb-2" style={{ paddingTop: "calc(var(--safe-top) + 6px)" }}>
        <button type="button" aria-label="Back" onClick={() => showScreen(null)} className="flex h-10 w-10 items-center justify-center text-muted">
          <ChevronLeft size={24} />
        </button>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            {t && <StateGlyph state={t.agent_state} />}
            <span className="truncate text-[16px] font-semibold">{t ? agentPlace(t, undefined).label : "Agent"}</span>
          </div>
          <span className="truncate text-[12px] text-muted">{hostLabel}</span>
        </div>
      </header>
      <div className="min-h-0 flex-1">
        {t ? (
          <ChatView host={host} terminal={terminal} cwd={t.cwd} from={{ kind: "agent", host, terminal }} />
        ) : (
          <p className="p-6 text-[14px] text-muted">This agent is no longer running. Its host may be offline.</p>
        )}
      </div>
    </div>
  );
}
