import { useState } from "react";
import { ChevronRight, Lock } from "lucide-react";
import type { McpServer } from "../lib/protocol";
import { mcpCard, mcpSummary } from "../lib/plusMenu";
import { Button, StateGlyph, cx } from "./ui";

export interface McpActions {
  servers: McpServer[] | null;
  /** Why the servers could not be listed, such as an agent that cannot start. */
  error: string | null;
  onReconnect: (name: string) => void;
}

const panel = "rounded-xl border border-border-strong bg-[#1a1a1a] shadow-[0_12px_32px_rgba(0,0,0,.5)]";

/** The MCP server list and the selected server's card (X29). */
export function McpPanels({ servers, error, onReconnect }: McpActions) {
  const [picked, setPicked] = useState<string | null>(null);
  if (!servers) {
    return (
      <div className={cx(panel, "w-[220px] p-1.5")}>
        <div className="px-2 py-1.5 ui-text-11 text-faint">MCP servers</div>
        <div className="px-2 pb-1.5 ui-text-12 text-muted">{error ? "Start the conversation to see its MCP servers." : "Loading…"}</div>
      </div>
    );
  }
  const selected = servers.find((s) => s.name === picked) ?? servers.find((s) => s.status === "needs-auth") ?? servers[0];
  return (
    <>
      <div className={cx(panel, "flex max-h-[360px] w-[220px] flex-col gap-px overflow-y-auto p-1.5")}>
        <div className="px-2 py-1.5 ui-text-11 text-faint">{mcpSummary(servers).header}</div>
        {servers.length === 0 && <div className="px-2 pb-1.5 ui-text-12 text-muted">No MCP servers configured.</div>}
        {servers.map((s) => (
          <button
            key={s.name}
            className={cx("flex h-8 shrink-0 items-center gap-2 rounded-lg px-2 text-left hover:bg-hover", selected?.name === s.name && "bg-hover")}
            onMouseEnter={() => setPicked(s.name)}
            onClick={() => setPicked(s.name)}
          >
            <StateGlyph state={mcpCard(s).glyph} size={10} />
            <span className="flex-1 truncate font-mono ui-text-12.5 font-medium text-fg">{s.name}</span>
            {s.status === "needs-auth" && <Lock size={12} className="shrink-0 text-blocked" />}
            <ChevronRight size={13} className="shrink-0 text-faint" />
          </button>
        ))}
      </div>
      {selected && <McpCard server={selected} onReconnect={onReconnect} />}
    </>
  );
}

function McpCard({ server: s, onReconnect }: { server: McpServer; onReconnect: (name: string) => void }) {
  const card = mcpCard(s);
  return (
    <div className={cx(panel, "flex w-[300px] flex-col gap-3 px-4 py-3.5")} aria-label={`MCP server ${s.name}`}>
      <div className="flex items-center gap-2">
        <StateGlyph state={card.glyph} size={10} />
        <span className="truncate font-mono ui-text-13.5 font-semibold text-fg">{s.name}</span>
        <span className="ml-auto shrink-0 ui-text-11.5 text-muted">{card.label}</span>
      </div>
      <div className="grid grid-cols-[70px_minmax(0,1fr)] gap-y-[5px] ui-text-11.5">
        <span className="text-faint">Transport</span>
        <span className="font-mono text-muted">{s.transport}</span>
        {s.endpoint && (
          <>
            <span className="text-faint">Endpoint</span>
            <span className="truncate font-mono text-muted" title={s.endpoint}>
              {s.endpoint}
            </span>
          </>
        )}
        {s.scope && (
          <>
            <span className="text-faint">Scope</span>
            <span className="font-mono text-muted">{s.scope}</span>
          </>
        )}
      </div>
      {s.status === "needs-auth" && (
        <div className="flex flex-col gap-2.5 rounded-lg border border-border-strong bg-[rgba(242,201,76,.05)] p-3">
          <div className="ui-text-12.5 font-medium text-fg">Authentication required</div>
          <div className="ui-text-12 leading-normal text-muted">The agent can't use {s.name}'s tools in this session until you sign in.</div>
        </div>
      )}
      {s.status === "failed" && (
        <div className="flex items-center gap-2.5 rounded-lg border border-border-strong p-3">
          <span className="min-w-0 flex-1 break-words font-mono ui-text-11.5 text-error">{s.error ?? "The server did not start."}</span>
          <Button variant="subtle" size="sm" onClick={() => onReconnect(s.name)}>
            Retry
          </Button>
        </div>
      )}
      {card.tools && (
        <div className="flex flex-col gap-1.5">
          <span className="ui-text-11 text-faint">{card.tools.summary}</span>
          <div className="flex flex-wrap gap-1">
            {card.tools.chips.map((t) => (
              <span key={t} className="rounded border border-border bg-panel px-1.5 py-0.5 font-mono ui-text-11 text-muted">
                {t}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
