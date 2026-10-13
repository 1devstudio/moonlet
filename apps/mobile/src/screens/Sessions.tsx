// Sessions (X40): the workspace's sessions on every host, by section and
// project, with chips for what needs the user, what works and what waits.

import { useState } from "react";
import { GitBranch, GitPullRequest, Laptop, Search, Server, X } from "lucide-react";
import { rpc } from "@desktop/lib/daemon";
import { M, type Project } from "@desktop/lib/protocol";
import { prTone } from "@desktop/components/ui";
import { showScreen, useApp } from "../lib/app";
import { useBase, useGitStatus, usePr, useSeen } from "../lib/lazy";
import { type ChipId, type ProjectGroup, type SessionRow, chips, filterGroups, rowTarget, sessionGroups } from "../lib/sessionList";
import { DiffStat, StateGlyph, Title, cx } from "../components/ui";
import { WorkspacePill } from "../components/WorkspacePill";
import { useNow } from "./Inbox";

const WORD_COLOR: Record<string, string> = { blocked: "#f2c94c", working: "#d97757", done: "#3ecf6e", error: "#ef5f5f", idle: "#8c8c8c" };
const AVATAR = ["#d97757", "#5aa9e6", "#a371f7", "#3ecf6e", "#f2c94c"];

function BehindButton({ host, project }: { host: string; project: Project }) {
  const [base, reload] = useBase(host, project);
  const [busy, setBusy] = useState(false);
  if (!base || base.behind === 0 || base.ahead > 0) return null;
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await rpc(host, M.gitPullBase, { path: project.path, branch: project.base_branch });
        } catch (e) {
          console.error(e);
        } finally {
          setBusy(false);
          reload();
        }
      }}
      className="flex h-7 items-center gap-1 rounded-full border border-border-strong px-2.5 text-[12px] text-muted"
    >
      <GitBranch size={12} />
      {busy ? "Pulling…" : `${base.branch} ${base.behind} behind · Pull`}
    </button>
  );
}

function Row({ r }: { r: SessionRow }) {
  // git and gh run on the host for each row: only for rows on screen.
  const [ref, seen] = useSeen();
  const [stat] = useGitStatus(r.host, seen ? r.session : undefined);
  const [pr] = usePr(r.host, seen ? r.session : undefined);
  return (
    <button ref={ref} type="button" onClick={() => showScreen(rowTarget(r))} className={cx("flex items-start gap-2.5 px-4 py-2.5 text-left", r.state === "blocked" && "bg-[rgba(242,201,76,0.035)]")}>
      <span className="pt-[3px]">
        <StateGlyph state={r.state} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[15px]">{r.session.name}</span>
          <span className="text-[12px]" style={{ color: WORD_COLOR[r.state] }}>
            {r.word}
          </span>
        </span>
        <span className="flex items-center gap-2 text-[12px] text-faint">
          <span className="truncate font-mono">{r.session.branch}</span>
          {stat && <DiffStat add={stat.additions} del={stat.deletions} />}
          {pr && (
            <span className={cx("flex items-center gap-1", prTone(pr.state.toLowerCase()))}>
              <GitPullRequest size={12} />#{pr.number}
              {pr.state.toLowerCase() === "merged" ? " merged" : ""}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

function Group({ g, showSection, index }: { g: ProjectGroup; showSection: boolean; index: number }) {
  return (
    <div className="flex flex-col">
      {showSection && <div className="eyebrow px-4 pt-4 pb-1">{g.section}</div>}
      <div className="flex items-center gap-2 px-4 py-2 text-[13.5px] font-semibold">
        <span className="flex h-5 w-5 items-center justify-center rounded-[6px] text-[11px] font-bold text-bg" style={{ background: AVATAR[index % AVATAR.length] }}>
          {g.letter}
        </span>
        {g.project.name}
        <span className="flex items-center gap-1 text-[12px] font-normal text-faint">
          {g.remote ? <Server size={12} /> : <Laptop size={12} />}
          {g.hostLabel}
        </span>
        <span className="flex-1" />
        <BehindButton host={g.host} project={g.project} />
      </div>
      {g.rows.map((r) => (
        <Row key={r.session.id} r={r} />
      ))}
    </div>
  );
}

export function SessionsScreen() {
  const hosts = useApp((s) => s.hosts);
  const data = useApp((s) => s.data);
  const workspace = useApp((s) => s.settings.workspace);
  const now = useNow();
  const [chip, setChip] = useState<ChipId>("all");
  const [query, setQuery] = useState<string | null>(null);
  const all = sessionGroups(hosts, data, workspace, now);
  const groups = filterGroups(all, chip, query ?? "");
  return (
    <div className="scroll h-full">
      <Title
        right={
          <>
            <button type="button" aria-label="Search sessions" onClick={() => setQuery(query === null ? "" : null)} className="flex h-9 w-9 items-center justify-center text-muted">
              {query === null ? <Search size={20} /> : <X size={20} />}
            </button>
            <WorkspacePill />
          </>
        }
      >
        Sessions
      </Title>
      {query !== null && (
        <div className="px-4 pt-3">
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Title, branch or project" className="h-10 w-full rounded-[10px] border border-border-strong bg-panel px-3 text-[15px] outline-none" />
        </div>
      )}
      <div className="flex gap-2 overflow-x-auto px-4 pt-3 pb-1">
        {chips(all).map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setChip(c.id)}
            className={cx("flex h-8 flex-none items-center gap-1.5 rounded-full border px-3 text-[13px]", chip === c.id ? "border-fg bg-fg text-bg" : "border-border-strong bg-panel text-fg")}
          >
            {c.label} <span className={chip === c.id ? "text-[#555]" : "text-faint"}>{c.count}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-col pb-6">
        {groups.length === 0 && <div className="px-4 pt-6 text-[14px] text-muted">{all.length ? "No sessions match." : "No sessions yet. Start one with New."}</div>}
        {groups.map((g, i) => (
          <Group key={g.key} g={g} index={i} showSection={i === 0 || groups[i - 1].section !== g.section || groups[i - 1].host !== g.host} />
        ))}
      </div>
    </div>
  );
}
