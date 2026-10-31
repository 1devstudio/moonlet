// The PR tab (X40, X2, X11): the session's pull request, its review and
// stack, and its checks; or a form to create it.

import { parseCopyHost } from "@desktop/lib/copyHost";
import { useEffect, useState } from "react";
import { ExternalLink, GitBranch, GitPullRequest } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { rpc } from "@desktop/lib/daemon";
import { M, type PrStack, type PullRequest, type Session } from "@desktop/lib/protocol";
import { prTone } from "@desktop/components/ui";
import { showScreen, useApp } from "../lib/app";
import { checkMark, checkNote, checksSummary, fixPrompt, reviewText, stackedOn, startsDraft, updatedAgo } from "../lib/checks";
import { sessionChat } from "../lib/chatView";
import { forget, useGitStatus, usePr } from "../lib/rowDetails";
import { useBusy } from "../lib/busy";
import { StatusMark } from "../components/chat";
import { AgentIcon, Btn, DiffStat, cx } from "../components/ui";
import { useNow } from "../lib/now";

function CreatePr({ host, session, onCreated }: { host: string; session: Session; onCreated: () => void }) {
  // Another member's session (X72): its pull request is made where it runs.
  if (parseCopyHost(host)) {
    return (
      <p className="m-4 text-[14px] text-muted">
        No pull request for <span className="font-mono text-fg">{session.branch}</span> yet. Open it on {session.owner?.name ?? "the Mac running this session"}.
      </p>
    );
  }
  return <CreatePrForm host={host} session={session} onCreated={onCreated} />;
}

function CreatePrForm({ host, session, onCreated }: { host: string; session: Session; onCreated: () => void }) {
  const [title, setTitle] = useState(session.name);
  const [body, setBody] = useState("");
  const git = useApp((s) => s.data[host]?.git ?? null);
  const [draft, setDraft] = useState(() => startsDraft(git));
  const { busy, error, run } = useBusy();
  const create = () =>
    run(async () => {
      await rpc<PullRequest>(host, M.prCreate, { path: session.path, title: title.trim(), body, base: session.base, draft });
      onCreated();
    });
  return (
    <div className="scroll flex h-full flex-col gap-3 p-4">
      <p className="m-0 text-[14px] text-muted">
        No pull request for <span className="font-mono text-fg">{session.branch}</span> yet. Creating one pushes the branch and opens it against <span className="font-mono text-fg">{session.base}</span>.
      </p>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className="h-11 rounded-[10px] border border-border-strong bg-panel px-3 text-[15px] outline-none" />
      <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Description (optional)" className="rounded-[10px] border border-border-strong bg-panel p-3 text-[15px] outline-none" />
      <label className="flex items-center gap-2 text-[14px]">
        <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Draft
      </label>
      {error && <span className="text-[12.5px] text-error">{error}</span>}
      <Btn tone="primary" disabled={busy || !title.trim()} onClick={() => void create()}>
        <GitPullRequest size={15} /> {busy ? "Creating…" : "Create PR"}
      </Btn>
    </div>
  );
}

export function PrTab({ host, session }: { host: string; session: Session }) {
  const d = useApp((s) => s.data[host]);
  const [pr, reload] = usePr(host, session);
  const [git] = useGitStatus(host, session);
  const [stack, setStack] = useState<PrStack | null>(null);
  const [loadedAt, setLoadedAt] = useState(Date.now());
  const now = useNow(5_000);
  const refresh = () => {
    forget(`pr:${host}:${session.id}`);
    reload();
    setLoadedAt(Date.now());
  };
  // Checks move: refresh every 30 s while the tab shows.
  useEffect(() => {
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [host, session.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (pr) void rpc<PrStack | null>(host, M.prStack, { path: session.path, number: pr.number }).then(setStack).catch(() => setStack(null));
  }, [host, session.path, pr?.number]); // eslint-disable-line react-hooks/exhaustive-deps

  if (pr === undefined) return <div className="p-6 text-[14px] text-muted">Loading the pull request…</div>;
  if (pr === null) return <CreatePr host={host} session={session} onCreated={refresh} />;

  const failing = pr.checks.find((c) => checkMark(c) === "error");
  const below = stackedOn(stack, pr.number);
  const review = reviewText(pr.review_decision);
  const chat = d ? sessionChat(d, session.id) : null;
  const askFix = async () => {
    if (!failing || chat === null) return;
    await rpc(host, M.chatSend, { id: chat, text: fixPrompt(failing, pr.number), images: [] }).catch(console.error);
    showScreen({ kind: "session", host, id: session.id, tab: "chat" });
  };

  return (
    <div className="flex h-full flex-col">
      <main className="scroll flex min-h-0 flex-1 flex-col gap-3 p-4">
        <div className="flex flex-col gap-2.5 rounded-[14px] border border-border bg-panel p-3.5">
          <div className="flex gap-2.5">
            <GitPullRequest size={18} className={cx("mt-0.5 flex-none", prTone(pr.state.toLowerCase()))} />
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-[15px] leading-snug font-semibold">
                {pr.title} <span className="font-normal text-muted">#{pr.number}</span>
              </span>
              <span className="font-mono text-[12px] text-muted">
                {session.base} ← {session.branch}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 text-[12.5px]">
            <span className={cx("rounded-full border border-border-strong px-2 py-0.5", prTone(pr.state.toLowerCase()))}>{pr.state.toLowerCase()}</span>
            {review && <span className="rounded-full border border-border-strong px-2 py-0.5 text-muted">{review}</span>}
            <span className="flex-1" />
            {git && <DiffStat add={git.additions} del={git.deletions} />}
          </div>
          {below && (
            <div className="flex items-center gap-1.5 text-[12.5px] text-muted">
              <GitBranch size={13} /> Stacked on <span className="text-fg">{below}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 px-1">
          <span className="text-[14px] font-semibold">Checks</span>
          <span className={cx("text-[12.5px]", failing ? "text-error" : "text-muted")}>{checksSummary(pr.checks)}</span>
          <span className="flex-1" />
          <span className="text-[12px] text-faint">{updatedAgo(loadedAt, now)}</span>
        </div>
        <div className="flex flex-col rounded-[14px] border border-border bg-panel">
          {pr.checks.map((c) => {
            const m = checkMark(c);
            return (
              <button key={c.name} type="button" onClick={() => c.url && void openUrl(c.url)} className="flex min-h-12 items-center gap-2.5 border-b border-border px-3.5 text-left last:border-b-0">
                <StatusMark status={m === "running" ? "running" : m === "ok" ? "ok" : "error"} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[14px]">{c.name}</span>
                  <span className={cx("text-[12px]", m === "error" ? "text-error" : "text-faint")}>{checkNote(c)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </main>
      <div className="flex flex-col gap-2 border-t border-border px-4 pt-3 pb-3">
        {failing && chat !== null && (
          <Btn tone="primary" onClick={() => void askFix()}>
            <AgentIcon agent="claude" size={15} /> Ask Claude to fix {failing.name}
          </Btn>
        )}
        <Btn onClick={() => void openUrl(pr.url)}>
          <ExternalLink size={15} /> Open on GitHub
        </Btn>
      </div>
    </div>
  );
}
