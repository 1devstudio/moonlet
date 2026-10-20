// A session (X40): its header and the Chat, Terminal, Changes and PR tabs.

import { type ReactNode, useEffect, useState } from "react";
import { Archive, ChevronLeft, MoreHorizontal } from "lucide-react";
import { rpc } from "@desktop/lib/daemon";
import { M, type Session, type SessionArchived, type UnpushedWork } from "@desktop/lib/protocol";
import { type SessionTab, showScreen, useApp } from "../lib/app";
import { sessionState } from "../lib/inbox";
import { sessionLine, shellTerminals } from "../lib/chatView";
import { useGitStatus, usePr } from "../lib/rowDetails";
import { checksDot } from "../lib/checks";
import { archiveSheet } from "../lib/archive";
import { useBusy } from "../lib/busy";
import { CHECK_COLOR } from "../lib/palette";
import { Sheet } from "../components/Sheet";
import { Btn, StateGlyph, cx } from "../components/ui";
import { ChatTab } from "./Chat";
import { TerminalTab } from "./Terminal";
import { ChangesTab } from "./Changes";
import { PrTab } from "./Pr";

const TABS: { id: SessionTab; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "terminal", label: "Terminal" },
  { id: "changes", label: "Changes" },
  { id: "pr", label: "PR" },
];

/** Archiving, as the host's Git settings say (X55): what happens to the
 * folder and branch, and work that is only on the host. */
function ArchiveSheet({ host, session, prState, onClose }: { host: string; session: Session; prState: string | null | undefined; onClose: () => void }) {
  const d = useApp((s) => s.data[host]);
  const hostLabel = useApp((s) => s.hosts[host]?.label ?? host);
  const git = d?.git ?? null;
  const warn = git?.warn_unpushed ?? true;
  // undefined while git.unpushed runs; null when not asked or it failed.
  const [work, setWork] = useState<UnpushedWork | null | undefined>(warn ? undefined : null);
  const [checked, setChecked] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const { busy, error, run } = useBusy();
  useEffect(() => {
    if (!warn) return;
    void rpc<UnpushedWork>(host, M.gitUnpushed, { path: session.path })
      .then(setWork)
      .catch(() => setWork(null));
  }, [host, session.path, warn]);
  const base = d?.projects.find((p) => p.id === session.project_id)?.base_branch ?? session.base;
  const sheet = archiveSheet({ session, base, git, prState, work: work ?? null, hostLabel });
  const archive = (push: boolean) =>
    run(async () => {
      if (push) await rpc(host, M.gitPush, { path: session.path });
      const done = await rpc<SessionArchived | boolean>(host, M.sessionArchive, { id: session.id, ...sheet.flags(checked) });
      if (typeof done === "object" && done.remote_error) setRemoteError(`Archived. Couldn't delete ${session.branch} on origin: ${done.remote_error}`);
      else showScreen(null);
    });
  if (remoteError) {
    return (
      <Sheet label="Archive session" onClose={() => showScreen(null)}>
        <div className="flex flex-col gap-3 px-4 pb-2">
          <p className="text-[14px] text-error">{remoteError}</p>
          <Btn onClick={() => showScreen(null)}>Done</Btn>
        </div>
      </Sheet>
    );
  }
  return (
    <Sheet label="Archive session" onClose={onClose}>
      <div className="scroll flex flex-col gap-3 px-4 pb-2">
        <span className="text-[16px] font-semibold">Archive session</span>
        {work === undefined ? (
          <p className="text-[14px] text-muted">Looking for work only on {hostLabel}…</p>
        ) : (
          <>
            <p className="text-[14px] leading-[1.45] text-muted">{sheet.message(checked)}</p>
            {sheet.unpushed && (
              <div className="flex flex-col gap-1.5 rounded-[10px] border border-[rgba(239,95,95,0.3)] bg-raised px-3 py-2.5">
                <span className="text-[13.5px] font-medium text-error">{sheet.unpushed.heading}</span>
                {sheet.unpushed.files.map((f) => (
                  <span key={f.path} className="truncate font-mono text-[12px] text-muted">
                    {f.status} {f.path}
                  </span>
                ))}
                {sheet.unpushed.more > 0 && <span className="text-[12px] text-faint">and {sheet.unpushed.more} more</span>}
                <span className="text-[12.5px] text-muted">{sheet.unpushed.summary}</span>
              </div>
            )}
            {sheet.checkbox && (
              <label className="flex min-h-11 items-center gap-2.5 text-[14.5px]">
                <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="h-5 w-5 accent-[var(--color-accent)]" />
                {sheet.checkbox}
              </label>
            )}
          </>
        )}
        {error && <span className="text-[12.5px] text-error">{error}</span>}
        {sheet.push && (
          <Btn disabled={busy || work === undefined || !!sheet.push.disabled} onClick={() => void archive(true)}>
            {sheet.push.label}
          </Btn>
        )}
        {sheet.push?.disabled && <span className="-mt-1 text-center text-[12px] text-faint">{sheet.push.disabled}</span>}
        <Btn
          tone={sheet.danger(checked) ? "secondary" : "primary"}
          disabled={busy || work === undefined}
          onClick={() => void archive(false)}
          className={cx(sheet.danger(checked) && "border-[#5a2a2e] bg-[#2a1416] text-error")}
        >
          <Archive size={16} /> {sheet.action}
        </Btn>
        <Btn tone="ghost" onClick={onClose}>
          Cancel
        </Btn>
      </div>
    </Sheet>
  );
}

export function SessionScreen({ host, id, tab }: { host: string; id: string; tab: SessionTab }) {
  const d = useApp((s) => s.data[host]);
  const hostLabel = useApp((s) => s.hosts[host]?.label ?? host);
  const session = d?.sessions.find((s) => s.id === id);
  const [git] = useGitStatus(host, session);
  const [pr] = usePr(host, session);
  const dot = pr ? checksDot(pr.checks) : null;
  const [menu, setMenu] = useState(false);
  const [archiving, setArchiving] = useState(false);
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
    pr: dot ? <span className="h-[7px] w-[7px] rounded-full" style={{ background: CHECK_COLOR[dot] }} /> : null,
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
            {badge[t.id] && (t.id === "pr" ? badge[t.id] : <span className="rounded-full bg-raised px-1.5 text-[11px] text-muted">{badge[t.id]}</span>)}
            {tab === t.id && <span className="absolute right-3 bottom-0 left-3 h-[2px] rounded-full bg-accent" />}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1">
        {tab === "chat" && <ChatTab host={host} session={session} />}
        {tab === "terminal" && <TerminalTab host={host} session={session} />}
        {tab === "changes" && <ChangesTab host={host} session={session} />}
        {tab === "pr" && <PrTab host={host} session={session} />}
      </div>
      {menu && (
        <Sheet label="Session actions" onClose={() => setMenu(false)}>
          <div className="flex flex-col gap-2 px-4 pb-2">
            <Btn
              onClick={() => {
                setMenu(false);
                setArchiving(true);
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
      {archiving && <ArchiveSheet host={host} session={session} prState={pr?.state} onClose={() => setArchiving(false)} />}
    </div>
  );
}
