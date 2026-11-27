// Sessions (X40, X118): the workspace's sessions on every host, drawn as the
// desktop sidebar draws them, with chips for what needs the user, what works
// and what waits.

import { useState } from "react";
import { ArrowDown, Loader2, Search, Server, ShieldAlert, X } from "lucide-react";
import { rpc } from "@desktop/lib/daemon";
import { M, type Project } from "@desktop/lib/protocol";
import { baseChip } from "@desktop/lib/baseSync";
import { numberColumn, rowStyle, taskGroups } from "@desktop/lib/sessionRows";
import { cellOf, ProjectMarkView, RowGlyph, RowView, TaskGroupList, type RowCell } from "@desktop/components/SessionRowView";
import { showScreen, useApp, useShownWorkspace } from "../lib/app";
import { useBase, useGitStatus, usePr, useSeen } from "../lib/rowDetails";
import { type ChipId, type ProjectGroup, type SessionRow, type SessionSection, chips, filterGroups, rowBadge, rowGlyph, rowTarget, sessionSections } from "../lib/sessionList";
import { useBusy } from "../lib/busy";
import { Title, cx } from "../components/ui";
import { WorkspacePill } from "../components/WorkspacePill";

const CHIP_TONE = { behind: "text-accent", pulling: "text-muted", diverged: "text-error" } as const;

/** The desktop's base chip (X13): `↓ 3` pulls the base branch on a tap. */
function BaseChip({ host, project }: { host: string; project: Project }) {
  const [base, reload] = useBase(host, project);
  const { busy, run } = useBusy();
  const chip = baseChip(base, busy);
  if (!chip) return null;
  return (
    <button
      type="button"
      aria-label={chip.title}
      disabled={busy || chip.kind !== "behind"}
      onClick={(e) => {
        e.stopPropagation();
        void run(() => rpc(host, M.gitPullBase, { path: project.path, branch: project.base_branch }), reload);
      }}
      className={cx("flex h-[26px] shrink-0 items-center gap-1 rounded-md border border-border-strong bg-panel-2 px-2 font-mono ui-text-11.5", CHIP_TONE[chip.kind])}
    >
      {chip.kind === "behind" ? <ArrowDown size={12} strokeWidth={1.75} /> : chip.kind === "pulling" ? <Loader2 size={12} strokeWidth={1.75} className="animate-spin" /> : <ShieldAlert size={12} strokeWidth={1.75} />}
      <span>{chip.text}</span>
    </button>
  );
}

function Row({ r, cell, nested }: { r: SessionRow; cell?: RowCell; nested: boolean }) {
  // git and gh run on the host for each row: only for rows on screen.
  const [ref, seen] = useSeen();
  const [stat] = useGitStatus(r.host, seen ? r.session : undefined);
  const [pr] = usePr(r.host, seen ? r.session : undefined);
  const prState = pr?.state.toLowerCase();
  const badge = rowBadge(r, stat, pr?.state);
  return (
    <div ref={ref}>
      <RowView
        touch
        role="button"
        aria-label={r.session.name}
        onClick={() => showScreen(rowTarget(r))}
        selected={false}
        nested={nested}
        cell={cell}
        glyph={<RowGlyph glyph={rowGlyph(r, pr?.state)} pr={prState} />}
        badge={badge}
        merged={prState === "merged"}
        name={
          <>
            <span className="min-w-0 flex-1 truncate ui-text-14 text-[#cfcfcf]">{r.session.name}</span>
            {/* Where the session runs, when not on its project's member (X68). */}
            {r.on && (
              <span aria-label={`on ${r.on}`} className="flex shrink-0 items-center text-muted">
                <Server size={12} />
              </span>
            )}
          </>
        }
      />
    </div>
  );
}

function Group({ g }: { g: ProjectGroup }) {
  const style = useApp((s) => rowStyle(s.settings.sessionRows));
  // Rows come from several hosts: their task lines are keyed by host and id.
  const lines = Object.fromEntries(g.rows.flatMap((r) => (r.task ? [[r.key, r.task]] : [])));
  const sources = g.rows.some((r) => r.sources);
  const ids = g.rows.map((r) => r.key);
  const column = style === "number" && sources ? numberColumn(ids, lines, { heading: g.heading === "project" }) : null;
  const tasks = style === "task" ? taskGroups(ids, lines, { sources, groupedByTask: g.kind === "task" }) : null;
  const row = (r: SessionRow, nested: boolean) => <Row key={r.key} r={r} nested={nested} cell={cellOf(column, r.key)} />;
  return (
    <div className="mb-1 flex flex-col">
      {g.heading === "project" && g.project && (
        <div className="flex h-[44px] items-center gap-2 pl-4 pr-3">
          <ProjectMarkView src={g.avatar} />
          <span className="truncate ui-text-14 font-semibold text-[#d6d6d6]">{g.label}</span>
          {g.on && <span className="shrink-0 font-mono ui-text-11 text-faint">on {g.on}</span>}
          {column?.prefix && <span className="shrink-0 font-mono ui-text-11.5 text-faint">{column.prefix}</span>}
          <BaseChip host={g.host} project={g.project} />
          <span className="flex-1" />
        </div>
      )}
      {g.heading === "label" && (
        <div className="flex h-[38px] items-center pl-4 pr-3">
          <span className={cx("truncate ui-text-11.5 font-medium text-muted", g.kind === "status" && "uppercase tracking-[0.1em]")}>{g.label}</span>
        </div>
      )}
      {!tasks && g.rows.map((r) => row(r, r.nested))}
      {tasks && <TaskGroupList tasks={tasks} row={(key) => row(g.rows.find((r) => r.key === key)!, true)} />}
    </div>
  );
}

function SectionBlock({ s, groups }: { s: SessionSection; groups: ProjectGroup[] }) {
  return (
    <div className="mb-3">
      <div className="mx-2 flex h-[40px] items-center gap-1.5 rounded-lg bg-bg pl-2.5 pr-1.5">
        <span className="truncate ui-text-14 font-semibold text-muted">{s.name}</span>
        {s.where && <span className="truncate font-mono ui-text-11 text-faint">@{s.where}</span>}
      </div>
      <div className="pt-1">
        {groups.map((g) => (
          <Group key={g.key} g={g} />
        ))}
      </div>
    </div>
  );
}

export function SessionsScreen() {
  const hosts = useApp((s) => s.hosts);
  const data = useApp((s) => s.data);
  const workspace = useShownWorkspace();
  const [chip, setChip] = useState<ChipId>("all");
  const [query, setQuery] = useState<string | null>(null);
  const sections = sessionSections(hosts, data, workspace);
  const all = sections.flatMap((s) => s.groups);
  const rows = all.flatMap((g) => g.rows);
  const filtered = filterGroups(all, chip, query ?? "");
  return (
      <div className="scroll h-full bg-window">
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
        <div className="flex gap-2 overflow-x-auto px-4 pt-3 pb-3">
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
          {filtered.length === 0 && <div className="px-4 pt-3 text-[14px] text-muted">{rows.length ? "No sessions match." : "No sessions yet. Start one with New."}</div>}
          {sections.map((s) => {
            const groups = filtered.filter((g) => g.sectionKey === s.key);
            // A section shows under All with nothing searched even without rows, as on the Mac.
            return groups.length || (chip === "all" && !query) ? <SectionBlock key={s.key} s={s} groups={groups} /> : null;
          })}
        </div>
      </div>
  );
}
