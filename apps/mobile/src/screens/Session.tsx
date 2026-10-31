// A session (X40): its header and the Chat, Terminal, Changes and PR tabs.

import { type ReactNode, useEffect, useState } from "react";
import { Archive, ChevronLeft, Link2, MoreHorizontal } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { rpc } from "@desktop/lib/daemon";
import { M, type PullRequest, type Session, type SessionArchived, type UnpushedWork } from "@desktop/lib/protocol";
import { unpushedParams } from "@desktop/lib/gitSettings";
import { type SessionTab, showScreen, useApp } from "../lib/app";
import { sessionState } from "../lib/inbox";
import { sessionTask } from "../lib/sessionList";
import { agentStrip, sessionChat } from "../lib/chatView";
import { sessionBoards } from "../lib/board";
import { taskId } from "@desktop/lib/tasks";
import { LinkSheet } from "../components/LinkSheet";
import { useNow } from "../lib/now";
import { STATE_COLOR } from "../lib/palette";
import { sessionLine, shellTerminals } from "../lib/chatView";
import { useGitStatus, usePr } from "../lib/rowDetails";
import { checksDot } from "../lib/checks";
import { continueFailed, continueOffer, continueWait, readOnlyLine } from "../lib/copies";
import { parseCopyHost } from "@desktop/lib/copyHost";
import { archiveSheet, archivedNote } from "../lib/archive";
import { useBusy } from "../lib/busy";
import { CHECK_COLOR } from "../lib/palette";
import { Sheet } from "../components/Sheet";
import { Btn, StateGlyph, cx } from "../components/ui";
import { ChatTab } from "./Chat";
import { TerminalTab } from "./Terminal";
import { ChangesTab } from "./Changes";
import { PrTab } from "./Pr";
import { JobsTab } from "./Jobs";
import { jobsTabCount } from "@desktop/lib/jobs";
import { useSessionJobs } from "@desktop/lib/jobsStore";
import { sessionTabs, shownTab } from "../lib/jobsView";

const TAB_LABEL: Record<SessionTab, string> = { chat: "Chat", terminal: "Terminal", changes: "Changes", pr: "PR", jobs: "Jobs" };

/** Archiving, as the host's Git settings say (X55): what happens to the
 * folder and branch, and work that is only on the host. */
function ArchiveSheet({ host, session, pr, onClose }: { host: string; session: Session; pr: PullRequest | null | undefined; onClose: () => void }) {
  const d = useApp((s) => s.data[host]);
  const hostLabel = useApp((s) => session.owner?.name ?? s.hosts[host]?.label ?? host);
  const git = d?.git ?? null;
  const warn = git?.warn_unpushed ?? true;
  // undefined while git.unpushed runs; null when not asked.
  const [work, setWork] = useState<UnpushedWork | null | "failed" | undefined>(warn ? undefined : null);
  const [checked, setChecked] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const { busy, error, run } = useBusy();
  const params = unpushedParams(session, pr);
  useEffect(() => {
    if (!warn) return;
    // The PR can load after the sheet opens: only the latest answer counts.
    let live = true;
    setWork(undefined);
    void rpc<UnpushedWork>(host, M.gitUnpushed, params)
      .then((w) => live && setWork(w))
      .catch(() => live && setWork("failed"));
    return () => {
      live = false;
    };
  }, [host, params.path, params.branch, params.merged_head, warn]);
  const base = d?.projects.find((p) => p.id === session.project_id)?.base_branch ?? session.base;
  const sheet = archiveSheet({ session, base, git, prState: pr?.state, work: work ?? null, hostLabel });
  const archive = (push: boolean) =>
    run(async () => {
      if (push) await rpc(host, M.gitPush, params);
      const done = await rpc<SessionArchived | boolean>(host, M.sessionArchive, { id: session.id, ...sheet.flags(checked, push) });
      const note = archivedNote(done, session.branch);
      if (note) setRemoteError(note);
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
            {sheet.checkFailed && <p className="rounded-[10px] border border-[rgba(239,95,95,0.3)] bg-raised px-3 py-2.5 text-[13px] text-error">{sheet.checkFailed}</p>}
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
  // Another member's session, through its central host (X72): named after
  // the member running it.
  const central = parseCopyHost(host)?.host;
  const centralLabel = useApp((s) => (central ? (s.hosts[central]?.label ?? central) : null));
  const hostLabel = useApp((s) => s.hosts[host]?.label ?? host);
  const session = d?.sessions.find((s) => s.id === id);
  const [git] = useGitStatus(host, session);
  const [pr] = usePr(host, session);
  const dot = pr ? checksDot(pr.checks) : null;
  const jobs = useSessionJobs(host, id);
  const [menu, setMenu] = useState(false);
  const now = useNow();
  const [archiving, setArchiving] = useState(false);
  const [linking, setLinking] = useState(false);
  const hosts = useApp((s) => s.hosts);
  const data = useApp((s) => s.data);
  // Continue on <central> (X73): in progress, and why it failed.
  const [continuing, setContinuing] = useState(false);
  const [continueError, setContinueError] = useState<string | null>(null);
  // Seconds until Continue can be pressed, counted down once a second.
  const [ticks, tick] = useState(0);
  const wait = session ? continueWait(session, Date.now()) : 0;
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => tick((n) => n + 1), 1000);
    return () => clearTimeout(t);
  }, [wait, ticks]);
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
  // The task the session works on and where it is (X46, X76).
  const task = sessionTask(d, session, pr, sessionBoards(hosts, data, host, session).map((b) => b.snapshot));
  // Its subagents at a glance (X76).
  const chat = sessionChat(d, session.id);
  const strip = chat !== null && d.chats[chat] ? agentStrip(d.chats[chat], now) : null;
  const badge: Partial<Record<SessionTab, ReactNode>> = {
    terminal: shellTerminals(d, id).length || null,
    changes: git?.files.length || null,
    pr: dot ? <span className="h-[7px] w-[7px] rounded-full" style={{ background: CHECK_COLOR[dot] }} /> : null,
    jobs: jobsTabCount(jobs) || null,
  };
  const tabs = sessionTabs(jobs);
  const shown = shownTab(tab, tabs);
  const go = (t: SessionTab) => showScreen({ kind: "session", host, id, tab: t });
  // The task in the app when a board has it, else in its tracker.
  const openTask = () => {
    if (!task) return;
    // By its URL: a GitHub key shows shortened (#12).
    const b = sessionBoards(hosts, data, host, session).find((x) => x.snapshot.tasks.some((t) => t.url === task.url));
    const t = b?.snapshot.tasks.find((x) => x.url === task.url);
    if (b && t) showScreen({ kind: "task", board: b.key, task: taskId(t), from: { kind: "session", host, id, tab } });
    else void openUrl(task.url).catch(console.error);
  };

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
          <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-faint">
            {task && (
              <button type="button" aria-label={`Open ${task.key}`} onClick={openTask} className="flex-none font-mono font-semibold text-accent-2">
                {task.key}
              </button>
            )}
            <span className="min-w-0 truncate font-mono">{task ? `· ${[project?.name, session.branch].filter(Boolean).join(" · ")}` : sessionLine(session, project, session.owner?.name ?? hostLabel)}</span>
          </span>
        </div>
        <button type="button" aria-label="Session actions" onClick={() => setMenu(true)} className="flex h-10 w-10 items-center justify-center text-muted">
          <MoreHorizontal size={20} />
        </button>
      </header>
      {strip && (
        <div aria-label={`${strip.bars.length} subagents`} className="flex flex-none items-center gap-1.5 px-4 pb-2">
          <div className="flex flex-1 gap-1">
            {strip.bars.map((b, i) => (
              <span key={i} className="h-1 flex-1 rounded-full" style={{ background: { done: STATE_COLOR.done, running: STATE_COLOR.working, needs: STATE_COLOR.blocked, failed: STATE_COLOR.error, stopped: STATE_COLOR.idle }[b] }} />
            ))}
          </div>
          <span className="font-mono text-[12px] text-faint">{strip.progress}</span>
          <span className={cx("text-[12px]", strip.word.endsWith("needs you") ? "text-blocked" : "text-muted")}>{strip.word}</span>
        </div>
      )}
      {/* The design's segmented tabs; Chat carries a dot while the session needs the user. */}
      <nav className={cx("mx-4 mb-2 grid flex-none rounded-[12px] border border-border bg-panel p-[3px]", tabs.length > 4 ? "grid-cols-5" : "grid-cols-4")}>
        {tabs.map((id) => ({ id, label: TAB_LABEL[id] })).map((t) => (
          <button
            key={t.id}
            type="button"
            aria-current={shown === t.id ? "page" : undefined}
            onClick={() => go(t.id)}
            className={cx("flex h-9 items-center justify-center gap-1 rounded-[9px]", tabs.length > 4 ? "text-[13px]" : "gap-1.5 text-[14px]", shown === t.id ? "bg-border-strong font-semibold text-fg" : "text-muted")}
          >
            {t.label}
            {t.id === "chat" && shown !== "chat" && sessionState(d, session) === "blocked" && <span className="h-[7px] w-[7px] rounded-full bg-blocked" />}
            {badge[t.id] && (t.id === "pr" ? badge[t.id] : <span className="text-[12px] font-normal text-faint">{badge[t.id]}</span>)}
          </button>
        ))}
      </nav>
      {centralLabel && readOnlyLine(session, centralLabel) && (
        <div role="status" className="flex flex-none items-center gap-3 border-b border-border bg-panel px-4 py-2 text-[13px] text-muted">
          <span className="min-w-0 flex-1">{readOnlyLine(session, centralLabel)}</span>
          {central && continueOffer(session, centralLabel) && (
            <Btn
              disabled={continuing || wait > 0}
              onClick={() => {
                setContinuing(true);
                setContinueError(null);
                void rpc(central, M.sessionContinueHere, { session: session.id })
                  .then(() => showScreen({ kind: "session", host: central, id: session.id, tab: "chat" }))
                  .catch((e) => setContinueError(continueFailed(e, session, centralLabel)))
                  .finally(() => setContinuing(false));
              }}
            >
              {continueOffer(session, centralLabel)}
            </Btn>
          )}
        </div>
      )}
      {continueError && (
        <p role="alert" className="m-0 flex-none border-b border-border bg-panel px-4 py-2 text-[13px] leading-snug text-error">
          {continueError}
        </p>
      )}
      <div className="min-h-0 flex-1">
        {shown === "chat" && <ChatTab host={host} session={session} />}
        {shown === "terminal" && <TerminalTab host={host} session={session} />}
        {shown === "changes" && <ChangesTab host={host} session={session} />}
        {shown === "pr" && <PrTab host={host} session={session} />}
        {shown === "jobs" && <JobsTab host={host} session={session} jobs={jobs} />}
      </div>
      {menu && (
        <Sheet label="Session actions" onClose={() => setMenu(false)}>
          <div className="flex flex-col gap-2 px-4 pb-2">
            {/* Archiving needs the Mac running the session (X72). */}
            {session.owner?.reachable !== false && (
              <Btn
                onClick={() => {
                  setMenu(false);
                  setArchiving(true);
                }}
              >
                <Archive size={16} /> Archive session
              </Btn>
            )}
            <Btn
              onClick={() => {
                setMenu(false);
                setLinking(true);
              }}
            >
              <Link2 size={16} /> {task ? "Link another task" : "Link a task"}
            </Btn>
            <Btn tone="ghost" onClick={() => setMenu(false)}>
              Cancel
            </Btn>
          </div>
        </Sheet>
      )}
      {linking && <LinkSheet host={host} session={session} onClose={() => setLinking(false)} />}
      {archiving && <ArchiveSheet host={host} session={session} pr={pr} onClose={() => setArchiving(false)} />}
    </div>
  );
}
