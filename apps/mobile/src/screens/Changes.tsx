// The Changes tab (X40, D1, D2): the session's changed files by folder, with
// staging, the branch's commits, and commit.

import { useState } from "react";
import { Check, ChevronDown, ChevronRight, Folder, GitPullRequest, History } from "lucide-react";
import { rpc } from "@desktop/lib/daemon";
import { type Commit, M, type Session } from "@desktop/lib/protocol";
import { showScreen } from "../lib/app";
import { commitLabel, folderGroups, statusLetter } from "../lib/diffView";
import { forget, useGitStatus } from "../lib/lazy";
import { Btn, DiffStat, cx } from "../components/ui";

const LETTER_COLOR: Record<string, string> = { M: "text-blocked", A: "text-done", "?": "text-done", D: "text-error", R: "text-accent-2", U: "text-error" };

export function ChangesTab({ host, session }: { host: string; session: Session }) {
  const [against, setAgainst] = useState<"base" | "head">("base");
  const [status, reload] = useGitStatus(host, session, against);
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    forget(`git:${host}:${session.id}`);
    reload();
  };
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const files = status?.files ?? [];
  const staged = files.filter((f) => f.staged).length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-4 py-2.5">
        <div className="flex rounded-[9px] bg-panel p-[3px]">
          {(["base", "head"] as const).map((a) => (
            <button key={a} type="button" onClick={() => setAgainst(a)} className={cx("h-8 rounded-[7px] px-3 text-[13px]", against === a ? "bg-border-strong font-semibold" : "text-muted")}>
              {a === "base" ? `vs ${session.base}` : "vs HEAD"}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <span className="text-[13px] text-muted">
          {files.length} file{files.length === 1 ? "" : "s"}
        </span>
        {status && <DiffStat add={status.additions} del={status.deletions} />}
      </div>
      <main className="scroll min-h-0 flex-1 pb-3">
        {status === null && <div className="p-6 text-[14px] text-muted">Loading changes…</div>}
        {status && files.length === 0 && <div className="p-6 text-[14px] text-muted">No changes {against === "base" ? `against ${session.base}` : "since the last commit"}.</div>}
        {folderGroups(files).map((g) => (
          <div key={g.dir} className="flex flex-col">
            <div className="flex items-center gap-1.5 px-4 pt-3 pb-1 font-mono text-[12px] text-faint">
              <Folder size={12} />
              {g.dir || "."}
            </div>
            {g.files.map((f) => (
              <div key={f.path} className="flex items-center">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={f.staged}
                  aria-label={`Stage ${f.name}`}
                  disabled={busy}
                  onClick={() => void run(() => rpc(host, f.staged ? M.gitUnstage : M.gitStage, { path: session.path, files: [f.path] }))}
                  className="flex h-12 w-12 flex-none items-center justify-center"
                >
                  <span className={cx("flex h-5 w-5 items-center justify-center rounded-[6px] border", f.staged ? "border-accent bg-accent text-bg" : "border-border-strong")}>{f.staged && <Check size={12} strokeWidth={3} />}</span>
                </button>
                <button type="button" onClick={() => showScreen({ kind: "diff", host, id: session.id, path: f.path, against })} className="flex min-h-12 min-w-0 flex-1 items-center gap-2.5 pr-4 text-left">
                  <span className={cx("w-3 font-mono text-[12px] font-semibold", LETTER_COLOR[statusLetter(f)])}>{statusLetter(f)}</span>
                  <span className="min-w-0 flex-1 truncate text-[14.5px]">{f.name}</span>
                  {f.binary ? <span className="text-[12px] text-faint">bin</span> : <DiffStat add={f.additions} del={f.deletions} />}
                  <ChevronRight size={16} className="text-faint" />
                </button>
              </div>
            ))}
          </div>
        ))}
        <button
          type="button"
          onClick={() => (commits ? setCommits(null) : void rpc<Commit[]>(host, M.gitLog, { path: session.path, base: session.base }).then(setCommits).catch(console.error))}
          className="mt-3 flex h-11 w-full items-center gap-2 px-4 text-[13.5px] text-muted"
        >
          <History size={15} />
          <span className="flex-1 text-left">{commits ? `${commits.length} commit${commits.length === 1 ? "" : "s"} on this branch` : "Commits on this branch"}</span>
          {commits ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        {commits?.map((c) => (
          <div key={c.sha} className="flex gap-2 px-4 py-1.5 text-[13px]">
            <span className="font-mono text-faint">{c.sha.slice(0, 7)}</span>
            <span className="min-w-0 flex-1 truncate">{c.subject}</span>
          </div>
        ))}
      </main>
      <div className="flex flex-col gap-2 border-t border-border px-4 pt-3 pb-3">
        <label htmlFor="msg" className="text-[12.5px] text-muted">
          Commit message
        </label>
        <input id="msg" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="What changed" className="h-11 rounded-[10px] border border-border-strong bg-panel px-3 text-[15px] outline-none" />
        {error && <span className="text-[12.5px] text-error">{error}</span>}
        <div className="grid grid-cols-2 gap-2">
          <Btn
            tone="primary"
            disabled={busy || !staged || !message.trim()}
            onClick={() =>
              void run(async () => {
                await rpc(host, M.gitCommit, { path: session.path, message: message.trim() });
                setMessage("");
                setCommits(null);
              })
            }
          >
            {commitLabel(files)}
          </Btn>
          <Btn onClick={() => showScreen({ kind: "session", host, id: session.id, tab: "pr" })}>
            <GitPullRequest size={15} /> Create PR
          </Btn>
        </div>
      </div>
    </div>
  );
}
