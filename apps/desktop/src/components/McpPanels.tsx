import { useState } from "react";
import { ArrowRight, ChevronRight, Copy, Lock } from "lucide-react";
import type { McpServer } from "../lib/protocol";
import { mcpCard, mcpSummary } from "../lib/plusMenu";
import { Button, StateGlyph, cx } from "./ui";

export interface McpActions {
  servers: McpServer[] | null;
  /** Why the servers could not be listed, such as an agent that cannot start. */
  error: string | null;
  onReconnect: (name: string) => void;
  /** Sign in: the agent's sign-in page opens in the browser. */
  onAuth: (name: string) => void;
  onCancel: (name: string) => void;
  /** Copies the sign-in page's address; resolves once it is copied. */
  onCopy: (name: string) => Promise<void>;
}

const panel = "rounded-xl border border-border-strong bg-[#1a1a1a] shadow-[0_12px_32px_rgba(0,0,0,.5)]";

/** The MCP server list and the selected server's card (X29). */
export function McpPanels({ servers, error, ...actions }: McpActions) {
  const [picked, setPicked] = useState<string | null>(null);
  if (!servers) {
    return (
      <div className={cx(panel, "w-[220px] p-1.5")}>
        <div className="px-2 py-1.5 ui-text-11 text-faint">MCP servers</div>
        <div className="px-2 pb-1.5 ui-text-12 text-muted">{error ? "Start the conversation to see its MCP servers." : "Loading…"}</div>
      </div>
    );
  }
  const waiting = (s: McpServer) => s.status === "needs-auth" || s.status === "authing";
  const selected = servers.find((s) => s.name === picked) ?? servers.find(waiting) ?? servers[0];
  // The server acted on stays selected while its status changes.
  const keep =
    <A extends unknown[], R>(fn: (name: string, ...rest: A) => R) =>
    (name: string, ...rest: A) => {
      setPicked(name);
      return fn(name, ...rest);
    };
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
      {selected && (
        <McpCard
          key={selected.name}
          server={selected}
          onReconnect={keep(actions.onReconnect)}
          onAuth={keep(actions.onAuth)}
          onCancel={keep(actions.onCancel)}
          onCopy={keep(actions.onCopy)}
        />
      )}
    </>
  );
}

function McpCard({ server: s, onReconnect, onAuth, onCancel, onCopy }: { server: McpServer } & Omit<McpActions, "servers" | "error">) {
  const card = mcpCard(s);
  // Reads Copied until another server is selected (the card remounts).
  const [copied, setCopied] = useState(false);
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
          <div className="ui-text-12 leading-normal text-muted">
            The agent can't use {s.name}'s tools in this session until you sign in. This opens the sign-in page in your browser; when you approve access the server connects
            automatically.
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="primary" size="sm" onClick={() => onAuth(s.name)}>
              Authenticate <ArrowRight size={11} />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void onCopy(s.name).then(() => setCopied(true))}>
              <Copy size={11} /> {copied ? "Copied" : "Copy link"}
            </Button>
          </div>
        </div>
      )}
      {s.status === "authing" && (
        <div className="flex items-center gap-2.5 rounded-lg border border-border-strong p-3">
          <StateGlyph state="working" size={10} />
          <span className="flex-1 ui-text-12 text-muted">Finish signing in to {s.name} in your browser.</span>
          {s.auth_url && (
            <Button variant="ghost" size="sm" onClick={() => onAuth(s.name)}>
              Open page
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => onCancel(s.name)}>
            Cancel
          </Button>
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
