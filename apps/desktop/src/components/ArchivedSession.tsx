import { Archive, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { restoreSession } from "../lib/actions";
import { archivedSummary, historyNote, keptTabs } from "../lib/archivedSession";
import { chatBlocks } from "../lib/chat";
import { rpc } from "../lib/daemon";
import { M, type ArchivedChat, type Session, type SessionHistory } from "../lib/protocol";
import { sesKey, useStore } from "../lib/store";
import { ChatItemView, ToolGroup } from "./AgentView";
import { useSessionTask } from "./tasks/SessionTask";
import { Button, Pane } from "./ui";
import { ScrollArea } from "./ScrollArea";

/** The blocks of a kept transcript shown at first; "Show earlier" adds more. */
const SHOWN = 200;

/** An archived session, read only (X86): what it worked on, its kept chat
 *  transcripts, and Restore in the header. */
export function ArchivedSession({ host, ws }: { host: string; ws: Session }) {
  const project = useStore((s) => s.projects[host]?.find((p) => p.id === ws.project_id)?.name);
  // No longer polled once archived: the last one seen, else its kept number.
  const polled = useStore((s) => s.prs[sesKey(host, ws.id)] ?? null);
  const pr = polled ?? (ws.pr ? { number: ws.pr, state: "" } : null);
  const tabs = keptTabs(ws.archived_restore);
  const task = useSessionTask(host, ws)?.card.task ?? null;
  const [history, setHistory] = useState<SessionHistory | Error | null>(null);
  const [restoring, setRestoring] = useState(false);
  useEffect(() => {
    let live = true;
    setHistory(null);
    rpc<SessionHistory>(host, M.sessionHistory, { id: ws.id }).then(
      (h) => live && setHistory(h),
      (e) => live && setHistory(e instanceof Error ? e : new Error(String(e))),
    );
    return () => {
      live = false;
    };
  }, [host, ws.id]);
  const lines = archivedSummary(ws, { project, task, pr, now: Date.now() });
  const note = history && historyNote(history);
  return (
    <div role="region" aria-label={`Archived session ${ws.name}`} className="flex h-full w-full flex-col overflow-hidden">
      <header className="flex h-ui-44 shrink-0 items-center gap-2.5 pr-3 pl-4">
        <Archive size={14} className="shrink-0 text-faint" />
        <span className="min-w-0 truncate ui-text-13.5 font-medium text-fg">{ws.name}</span>
        <span className="shrink-0 rounded-full border border-border-strong px-2 py-px ui-text-11 text-muted">Archived</span>
        <Button
          size="sm"
          variant="primary"
          className="ml-auto"
          disabled={restoring}
          onClick={async () => {
            setRestoring(true);
            await restoreSession(host, ws);
            setRestoring(false);
          }}
        >
          <RotateCcw size={12} /> {restoring ? "Restoring…" : "Restore"}
        </Button>
      </header>
      <Pane className="flex flex-col">
        <ScrollArea>
        <div className="mx-auto flex max-w-[860px] flex-col gap-1 px-6 pt-5 pb-8">
          <dl aria-label="About this session" className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 ui-text-12.5">
            {lines.task && (
              <>
                <dt className="text-faint">Task</dt>
                <dd className="text-fg">{lines.task}</dd>
              </>
            )}
            <dt className="text-faint">Branch</dt>
            <dd className="font-mono text-muted">{lines.where}</dd>
            {lines.pr && (
              <>
                <dt className="text-faint">Pull request</dt>
                <dd className="text-muted">{lines.pr}</dd>
              </>
            )}
            <dt className="text-faint">When</dt>
            <dd className="text-muted">{lines.when}</dd>
            {tabs.length > 0 && (
              <>
                <dt className="text-faint">On Restore</dt>
                <dd className="flex flex-col text-muted">
                  {tabs.map((t, i) => (
                    <span key={i}>{t}</span>
                  ))}
                </dd>
              </>
            )}
          </dl>
          {history === null && <div className="py-10 text-center ui-text-13 text-faint">Loading transcripts…</div>}
          {note && <p className="mt-6 ui-text-13 text-faint">{note}</p>}
          {history && !(history instanceof Error) && history.chats.map((c) => <Transcript key={c.id} chat={c} cwd={ws.path} />)}
        </div>
      </ScrollArea>
      </Pane>
    </div>
  );
}

/** One kept chat, read only: no input, no answers to give. */
function Transcript({ chat, cwd }: { chat: ArchivedChat; cwd: string }) {
  const toolCalls = useStore((s) => s.settings.toolCalls);
  const blocks = useMemo(() => chatBlocks(chat.items, toolCalls), [chat.items, toolCalls]);
  const [limit, setLimit] = useState(SHOWN);
  const earlier = Math.max(0, blocks.length - limit);
  return (
    <section aria-label={`Transcript ${chat.title}`} className="mt-6 flex flex-col gap-0.5 ui-text-13.5">
      <div className="mb-2 border-b border-border pb-1 ui-text-11.5 font-medium text-faint">{chat.title}</div>
      {earlier > 0 && (
        <button className="self-center px-2 py-1 ui-text-12.5 text-muted hover:text-fg" onClick={() => setLimit(limit + SHOWN)}>
          Show earlier ({earlier})
        </button>
      )}
      {blocks.slice(earlier).map((b) => (b.kind === "item" ? <ChatItemView key={b.item.id} item={b.item} cwd={cwd} /> : <ToolGroup key={b.id} tools={b.tools} cwd={cwd} />))}
    </section>
  );
}
