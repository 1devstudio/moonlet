// Sessions (X40): the workspace's sessions on every host, by section and
// project, with chips for what needs the user, what works and what waits.

import { useState } from "react";
import { Bot, GitBranch, GitPullRequest, Laptop, Search, Server, X } from "lucide-react";
import { rpc } from "@desktop/lib/daemon";
import { M, type Project } from "@desktop/lib/protocol";
import { prTone } from "@desktop/components/ui";
import { showScreen, useApp, useShownWorkspace } from "../lib/app";
import { useBase, useGitStatus, usePr, useSeen } from "../lib/rowDetails";
import { type ChipId, type ProjectGroup, type SessionRow, chips, filterGroups, rowTarget, sessionGroups, sessionTask, suggestedTask } from "../lib/sessionList";
import { LinkSheet } from "../components/LinkSheet";
import { sessionBoards } from "../lib/board";
import { useBusy } from "../lib/busy";
import { STATE_COLOR } from "../lib/palette";
import { DiffStat, StateGlyph, Title, cx } from "../components/ui";
import { WorkspacePill } from "../components/WorkspacePill";
import { useNow } from "../lib/now";

const AVATAR = ["#d97757", "#5aa9e6", "#a371f7", "#3ecf6e", "#f2c94c"];

function BehindButton({ host, project }: { host: string; project: Project }) {
  const [base, reload] = useBase(host, project);
  const { busy, run } = useBusy();
  if (!base || base.behind === 0 || base.ahead > 0) return null;
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void run(() => rpc(host, M.gitPullBase, { path: project.path, branch: project.base_branch }), reload)}
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
  const d = useApp((s) => s.data[r.host]);
  const hosts = useApp((s) => s.hosts);
  const data = useApp((s) => s.data);
  // Boards another member of the account shares count too (X68).
  const shared = sessionBoards(hosts, data, r.host, r.session).map((b) => b.snapshot);
  // The task the session works on: its link, or the one its branch or PR names (X46, X76).
  const task = d ? sessionTask(d, r.session, pr, shared) : null;
  // A task its name suggests, to link from here (X76).
  const suggested = d && !task ? suggestedTask(d, r.session, shared) : null;
  const [linking, setLinking] = useState(false);
  return (
    <>
    <button ref={ref} type="button" onClick={() => showScreen(rowTarget(r))} className={cx("flex items-start gap-2.5 px-4 py-2.5 text-left", r.state === "blocked" && "bg-[rgba(242,201,76,0.035)]")}>
      <span className="pt-[3px]">
        <StateGlyph state={r.state} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[15px]">{r.session.name}</span>
          <span className="text-[12px]" style={{ color: STATE_COLOR[r.state] }}>
            {r.word}
          </span>
        </span>
        <span className="flex items-center gap-2 text-[12px] text-faint">
          {task && <span className="flex-none font-mono font-semibold text-accent-2">{task.key}</span>}
          {suggested && (
            <span
              role="button"
              tabIndex={0}
              aria-label={`Link to ${suggested.key}?`}
              onClick={(e) => (e.stopPropagation(), setLinking(true))}
              onKeyDown={(e) => e.key === "Enter" && (e.stopPropagation(), setLinking(true))}
              className="flex-none font-mono font-semibold text-faint"
            >
              {suggested.key}?
            </span>
          )}
          <span className="min-w-0 truncate font-mono">{r.session.branch}</span>
          {stat && (
            <span className="flex-none whitespace-nowrap">
              <DiffStat add={stat.additions} del={stat.deletions} />
            </span>
          )}
          {r.agents && (
            <span className="flex flex-none items-center gap-1">
              <Bot size={12} />
              {r.agents}
            </span>
          )}
          {pr && (
            <span className={cx("flex flex-none items-center gap-1 whitespace-nowrap", prTone(pr.state.toLowerCase()))}>
              <GitPullRequest size={12} />#{pr.number}
              {pr.state.toLowerCase() === "merged" ? " merged" : ""}
            </span>
          )}
          {r.on && <span className="flex-none font-mono">on {r.on}</span>}
        </span>
      </span>
    </button>
    {linking && <LinkSheet host={r.host} session={r.session} onClose={() => setLinking(false)} />}
    </>
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
        <Row key={`${r.host}/${r.session.id}`} r={r} />
      ))}
    </div>
  );
}

export function SessionsScreen() {
  const hosts = useApp((s) => s.hosts);
  const data = useApp((s) => s.data);
  const workspace = useShownWorkspace();
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
          <Group key={g.key} g={g} index={i} showSection={i === 0 || groups[i - 1].sectionKey !== g.sectionKey} />
        ))}
      </div>
    </div>
  );
}
