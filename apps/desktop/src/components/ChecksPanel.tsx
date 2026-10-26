import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CircleCheck, CircleDashed, CircleX, ExternalLink, GitPullRequest, LoaderCircle } from "lucide-react";
import { rpc } from "../lib/daemon";
import { M, type Commit, type PullRequest, type Session } from "../lib/protocol";
import { pollPr, useStore, sesKey } from "../lib/store";
import { Button, Empty, prTone } from "./ui";
import { sessionDesignsOf, useDesign } from "../lib/designStore";
import { DesignBuildSection } from "./design/DesignAndBuild";

function CheckIcon({ status, conclusion }: { status: string; conclusion: string | null }) {
  if (status !== "completed" && !conclusion) return <LoaderCircle size={13} className="spin text-working" />;
  if (conclusion === "success" || conclusion === "neutral" || conclusion === "skipped") return <CircleCheck size={13} className="text-done" />;
  if (conclusion) return <CircleX size={13} className="text-error" />;
  return <CircleDashed size={13} className="text-faint" />;
}

/** Branch state, PR, review and CI at a glance (X2), polled while visible. */
export function ChecksPanel({ host, ws }: { host: string; ws: Session }) {
  const git = useStore((s) => s.git[sesKey(host, ws.id)]);
  // Undefined until the first poll; shared with the PR button and sidebar.
  const pr = useStore((s): PullRequest | null | undefined => s.prs[sesKey(host, ws.id)]);
  const [prError, setPrError] = useState<string | null>(null);
  const [log, setLog] = useState<Commit[]>([]);
  const designs = useDesign((d) => sessionDesignsOf(d, host, ws.id));

  useEffect(() => {
    let live = true;
    const load = () => {
      void pollPr(host, ws.id, ws.path)
        .then(() => live && setPrError(null))
        .catch((e) => live && setPrError(String(e?.message ?? e)));
      void rpc<Commit[]>(host, M.gitLog, { path: ws.path, base: ws.base })
        .then((l) => live && setLog(l))
        .catch(() => {});
    };
    load();
    const t = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [host, ws.id, ws.path, ws.base]);

  return (
    <div className="h-full overflow-y-auto p-3 ui-text-13">
      <section className="mb-4">
        <h3 className="mb-2 ui-text-11 font-semibold uppercase tracking-wider text-faint">Branch</h3>
        <div className="space-y-1 text-muted">
          <div>
            <span className="font-mono text-fg">{ws.branch}</span> → <span className="font-mono">{ws.base}</span>
          </div>
          {git && (
            <div>
              {git.files.length} changed file{git.files.length === 1 ? "" : "s"}, {git.files.filter((f) => f.unstaged || f.status === "untracked").length} uncommitted
              {git.upstream ? ` · ↑${git.ahead} ↓${git.behind} vs ${git.upstream}` : " · not pushed"}
            </div>
          )}
          {git?.files.some((f) => f.status === "conflicted") && <div className="text-error">Merge conflicts need resolving.</div>}
        </div>
      </section>

      <section className="mb-4">
        <h3 className="mb-2 ui-text-11 font-semibold uppercase tracking-wider text-faint">Pull request</h3>
        {pr === undefined && !prError && <div className="text-faint">Loading…</div>}
        {prError && <div className="text-faint">GitHub status unavailable: {prError}</div>}
        {pr === null && (
          <div className="flex items-center gap-2 text-muted">
            No pull request for this branch.
            <Button size="sm" onClick={() => useStore.setState({ dialog: { kind: "create-pr" } })}>
              <GitPullRequest size={12} /> Create PR
            </Button>
          </div>
        )}
        {pr && (
          <div className="rounded-lg border border-border bg-panel-2 p-2.5">
            <button className="flex w-full items-center gap-2 text-left hover:text-accent" onClick={() => void openUrl(pr.url)}>
              <GitPullRequest size={13} className={prTone(pr.state)} />
              <span className="truncate font-medium">
                #{pr.number} {pr.title}
              </span>
              <ExternalLink size={11} className="ml-auto shrink-0 text-faint" />
            </button>
            <div className="mt-1 ui-text-12 text-muted">
              {pr.state}
              {pr.review_decision ? ` · ${pr.review_decision.toLowerCase().replace(/_/g, " ")}` : ""}
            </div>
            {pr.checks.length > 0 && (
              <div className="mt-2 space-y-1 border-t border-border pt-2">
                {pr.checks.map((c, i) => (
                  <button key={i} className="flex w-full items-center gap-2 text-left hover:text-fg" onClick={() => c.url && void openUrl(c.url)}>
                    <CheckIcon status={c.status} conclusion={c.conclusion} />
                    <span className="truncate text-muted">{c.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {/* The PR's Design and build: each page of the session's designs beside its built screen (X65). */}
      {designs.map((d) => (
        <DesignBuildSection key={d.slug} host={host} ws={ws} design={d} />
      ))}

      <section>
        <h3 className="mb-2 ui-text-11 font-semibold uppercase tracking-wider text-faint">Commits on this branch</h3>
        {log.length === 0 ? (
          <Empty title="No commits yet" />
        ) : (
          <div className="space-y-1">
            {log.map((c) => (
              <div key={c.sha} className="flex gap-2">
                <span className="shrink-0 font-mono ui-text-12 text-faint">{c.sha.slice(0, 7)}</span>
                <span className="selectable truncate text-[#c5c9d1]">{c.subject}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
