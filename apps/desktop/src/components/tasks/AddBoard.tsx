// Add a board (X50): four steps, Source, Issues, Columns and Finish, for a
// Jira board or query, a Linear team, a GitHub repository or a ClickUp list.

import { ArrowDown, ArrowUp, ArrowRight, Check, Lock, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  alreadyAdded,
  canContinue,
  cardChoices,
  clash,
  columnAt,
  type Draft,
  draftFromBoard,
  finishedChoices,
  jiraSprints,
  moveColumn,
  newDraft,
  originText,
  pickOrigin,
  previewLine,
  putBoard,
  STEPS,
  summaryLine,
  toBoard,
} from "../../lib/addBoard";
import { type BoardColumn, CATEGORY_BAR, CATEGORY_LABEL, GITHUB_REPO_COLUMNS, jiraBoardType, type Origin, type StartRule } from "../../lib/boards";
import { hostsApi } from "../../lib/daemon";
import { errorToast, useStore } from "../../lib/store";
import { type Task, trackerName, trackerOf } from "../../lib/tasks";
import { GITHUB, openBoard, previewBoard, removeBoard, saveTrackersConfig, trackersConfig, useTasks, workspaceProjects } from "../../lib/tasksStore";
import { parseWsKey, wsKey } from "../../lib/workspaces";
import { Button, cx, IconButton, inputCls } from "../ui";
import { BoardMark, TaskGlyph } from "./TasksMode";

const selectCls = cx(inputCls, "menu-select field-height");

/** A row the user can pick in step 1: a Jira board, a Linear team, a ClickUp list or a repository. */
interface Choice {
  key: string;
  name: string;
  /** Its type, as the row names it: Scrum, Kanban, Team-managed, Cycles. */
  kind?: string;
  /** Whether it has sprints or cycles to follow. */
  sprints?: boolean;
  origin: Origin;
}

const CATEGORY_CHOICES = Object.entries(CATEGORY_LABEL) as [BoardColumn["category"], string][];

const message = (e: unknown) => (e as { message?: string })?.message ?? String(e);

/** Add a board, starting on `connection` when given, or with `boardId` that board's settings (X50). */
export function AddBoardDialog({ host, workspace, boardId, connection }: { host: string; workspace: string; boardId?: string; connection?: string }) {
  const close = () => useStore.setState({ dialog: null });
  const config = useTasks((t) => trackersConfig(t));
  const workspaces = useStore((s) => s.workspaces);
  const data = useTasks((t) => t.data[wsKey(host, workspace)]);
  const repos = [...new Set(Object.values(data?.repos ?? {}).filter((r): r is string => !!r))];
  const editing = config.boards?.find((b) => b.id === boardId);
  const [draft, setDraft] = useState<Draft>(() => (editing ? draftFromBoard(editing) : { ...newDraft(wsKey(host, workspace)), connection: connection ?? null }));
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [choicesError, setChoicesError] = useState<string | null>(null);
  const [build, setBuild] = useState<"board" | "jql">("board");
  // The board's filter: undefined while it is read, null when Jira does not share it.
  const [filterJql, setFilterJql] = useState<string | null | undefined>(undefined);
  const [preview, setPreview] = useState<{ tasks: Task[]; columns: BoardColumn[] | null; error: string | null } | null>(null);
  const tracker = draft.connection ? (trackerOf(draft.connection) ?? "github") : null;
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  // The furthest step reached: the steps before it are done and stay clickable after Back.
  const [reached, setReached] = useState<Draft["step"]>(editing ? 4 : 1);
  useEffect(() => setReached((r) => (draft.step > r ? draft.step : r)), [draft.step]);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Step 1: what the connection can show; an answer for a connection no longer picked is dropped.
  useEffect(() => {
    setChoices(null);
    setChoicesError(null);
    if (!draft.connection) return;
    if (draft.connection === GITHUB) {
      setChoices(repos.map((repo) => ({ key: repo, name: repo, origin: { kind: "github_repo", repo } })));
      return;
    }
    let stale = false;
    const kind = trackerOf(draft.connection);
    const ask =
      kind === "jira"
        ? hostsApi.trackerBoards(draft.connection).then((bs) => bs.map((b): Choice => ({ key: b.project ?? String(b.id), name: b.name, kind: jiraBoardType(b.kind), sprints: jiraSprints(b.kind), origin: { kind: "jira_board", board: b.id } })))
        : hostsApi
            .trackerSources(draft.connection)
            .then((ss) => ss.map((s): Choice => ({ key: s.key, name: s.name, ...(s.cycles && { kind: "Cycles", sprints: true }), origin: kind === "linear" ? { kind: "linear_team", team: s.key } : { kind: "clickup_list", list: s.key } })));
    ask.then(
      (c) => !stale && setChoices(c),
      (e) => !stale && setChoicesError(message(e)),
    );
    return () => {
      stale = true;
    };
  }, [draft.connection, repos.join(" ")]);

  // Board settings learn from the source's row whether it has sprints or cycles.
  useEffect(() => {
    if (draft.sprints !== undefined || !draft.origin) return;
    const row = choices?.find((c) => JSON.stringify(c.origin) === JSON.stringify(draft.origin));
    if (row) set({ sprints: !!row.sprints });
  }, [choices]);

  // A Jira board's filter and columns; an answer for a board no longer picked is dropped.
  useEffect(() => {
    setFilterJql(undefined);
    if (!draft.connection || draft.origin?.kind !== "jira_board") return;
    let stale = false;
    hostsApi.trackerBoardSetup(draft.connection, draft.origin.board).then(
      (setup) => {
        if (stale) return;
        setFilterJql(setup.filterJql ?? null);
        setDraft((d) => (d.columns.length ? d : { ...d, columns: setup.columns }));
      },
      (e) => !stale && errorToast(e),
    );
    return () => {
      stale = true;
    };
  }, [draft.connection, JSON.stringify(draft.origin)]);

  // Step 2's preview (and Board settings'), a moment after the last change;
  // until it answers, Continue waits.
  const target = parseWsKey(draft.workspace);
  const previewKey = JSON.stringify([draft.connection, draft.origin, draft.narrow, draft.labels, draft.finished, draft.workspace]);
  const latest = useRef(previewKey);
  latest.current = previewKey;
  const previewing = (draft.step >= 2 || !!editing) && canContinue({ ...draft, step: 1 }, null);
  useEffect(() => {
    setPreview(null);
    if (!previewing) return;
    const t = setTimeout(() => {
      const answer = (p: { tasks: Task[]; columns: BoardColumn[] | null; error: string | null }) => {
        if (latest.current !== previewKey) return;
        setPreview(p);
        // A JQL board's, a Linear team's and a ClickUp list's columns come with their issues.
        if (p.columns) setDraft((d) => (d.columns.length ? d : { ...d, columns: p.columns ?? [] }));
      };
      previewBoard(target.host, target.id, { ...toBoard(draft), assignee: "anyone" }).then(answer, (e) => answer({ tasks: [], columns: null, error: message(e) }));
    }, 500);
    return () => clearTimeout(t);
  }, [previewKey, previewing]);

  useEffect(() => {
    if (draft.origin?.kind === "github_repo" && !draft.columns.length) set({ columns: GITHUB_REPO_COLUMNS });
  }, [draft.origin]);

  const branches = useMemo(() => {
    const st = useStore.getState();
    const worktrees = useTasks.getState().data[draft.workspace]?.worktrees ?? [];
    return [...(st.sessions[target.host] ?? []).filter((s) => s.workspace_id === target.id).map((s) => s.branch), ...worktrees.flatMap((w) => (w.branch ? [w.branch] : []))];
  }, [draft.workspace, data]);

  const projects = workspaceProjects(useStore.getState(), target.host, target.id);
  const wsOptions = Object.entries(workspaces).flatMap(([h, list]) => list.map((w) => ({ value: wsKey(h, w.id), label: w.name })));
  const wsName = wsOptions.find((w) => w.value === draft.workspace)?.label ?? "";
  // A board its workspace already has stops Create board and Save.
  const clashText = draft.origin && draft.connection ? clash(config.boards, toBoard(draft), editing?.id) : null;
  const ok = canContinue(draft, preview) && !(draft.step === 4 && clashText);
  const canSave = canContinue({ ...draft, step: 4 }, preview) && !clashText;
  const create = async () => {
    // Board settings save the board where it was, under the id of its workspace now.
    const board = toBoard(draft);
    try {
      await saveTrackersConfig((c) => ({ ...c, boards: putBoard(c.boards, board, editing?.id) }));
      close();
      const to = parseWsKey(board.workspace);
      openBoard(to.host, to.id, board.id);
    } catch (e) {
      errorToast(e);
    }
  };
  const remove = async () => {
    if (!editing) return;
    try {
      if (await removeBoard(editing)) close();
    } catch (e) {
      errorToast(e);
    }
  };

  const connections = [
    ...(config.connections ?? []).map((c) => ({ id: c.id, name: c.kind === "jira" ? "Jira Cloud" : trackerName(c.kind), site: c.site })),
    { id: GITHUB, name: "GitHub", site: "via gh login" },
  ];
  const sample = (preview?.tasks ?? []).slice(0, 3);
  const moveAt = (i: number, by: number) => setDraft((d) => ({ ...d, columns: moveColumn(d.columns, i, by) }));
  const setColumn = (i: number, patch: Parameters<typeof columnAt>[2]) => setDraft((d) => ({ ...d, columns: columnAt(d.columns, i, patch) }));
  // WIP limits are Jira's alone.
  const wip = tracker === "jira";
  const grid = wip ? "grid-cols-[52px_minmax(0,1fr)_150px_150px_40px]" : "grid-cols-[52px_minmax(0,1fr)_150px_150px]";
  const defaultRule = draft.rules.find((r) => r.when === "default");
  const otherRules = draft.rules.filter((r) => r.when !== "default");
  const setRules = (rules: StartRule[]) => set({ rules });

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[8vh]" onMouseDown={close}>
      <div role="dialog" aria-label={editing ? "Board settings" : "Add a board"} className="flex h-[640px] w-[960px] overflow-hidden rounded-xl border border-border-strong bg-panel shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <nav aria-label="Steps" className="flex w-[210px] shrink-0 flex-col border-r border-border bg-bg/40 p-3">
          <h2 className="px-2 pb-3 pt-1 ui-text-14 font-semibold text-fg">{editing ? "Board settings" : "Add a board"}</h2>
          {STEPS.map((s, i) => {
            const n = (i + 1) as Draft["step"];
            const done = n < reached && n !== draft.step;
            const current = n === draft.step;
            return (
              <button
                key={s.name}
                aria-current={current ? "step" : undefined}
                disabled={n > reached}
                onClick={() => set({ step: n })}
                className={cx("flex items-start gap-2.5 rounded-lg px-2 py-2 text-left", current && "bg-panel-2")}
              >
                <span
                  className={cx(
                    "mt-[1px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border font-mono ui-text-10.5",
                    current ? "border-accent bg-accent text-[#1a1208]" : done ? "border-border-strong text-done" : "border-border-strong text-muted",
                  )}
                >
                  {done ? <Check size={11} /> : n}
                </span>
                <span>
                  <span className={cx("block ui-text-13", current || done ? "text-fg" : "text-muted")}>{s.name}</span>
                  <span className="block ui-text-11.5 text-faint">{s.sub}</span>
                </span>
              </button>
            );
          })}
          <p className="mt-auto px-2 ui-text-11.5 text-faint">Every choice can be changed later from the board's ⋯ menu › Board settings.</p>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center border-b border-border px-5 py-3">
            <h3 className="flex-1 ui-text-14 font-semibold text-fg">{STEPS[draft.step - 1].title}</h3>
            <IconButton title="Close" onClick={close}>
              <X size={14} />
            </IconButton>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {draft.step === 1 && editing && (
              <section aria-label="Source" className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
                <span className="flex h-7 w-7 items-center justify-center rounded-md bg-panel-2">
                  <BoardMark size={14} connection={editing.connection} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate ui-text-13 text-fg">{draft.origin && originText(draft.origin)}</span>
                  <span className="block ui-text-12 text-faint">The source stays as it is: a different one is a new board.</span>
                </span>
              </section>
            )}
            {draft.step === 1 && !editing && (
              <div className="flex flex-col gap-4">
                <section aria-label="Connection">
                  <div className="mb-2 ui-text-12 text-muted">Connection</div>
                  <div className="grid grid-cols-3 gap-2">
                    {connections.map((c) => (
                      <button
                        key={c.id}
                        aria-pressed={draft.connection === c.id}
                        onClick={() => {
                          setDraft({ ...newDraft(draft.workspace), connection: c.id });
                          setReached(1);
                        }}
                        className={cx("flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left", draft.connection === c.id ? "border-accent bg-accent/[0.08]" : "border-border hover:bg-panel-2")}
                      >
                        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-panel-2">
                          <BoardMark size={14} connection={c.id} />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate ui-text-13 text-fg">{c.name}</span>
                          <span className="block truncate ui-text-11.5 text-faint">{c.site}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
                {tracker === "jira" && (
                  <section aria-label="Build the board from">
                    <div className="mb-2 ui-text-12 text-muted">Build the board from</div>
                    <div className="grid grid-cols-2 gap-2">
                      {(
                        [
                          ["board", "An existing Jira board", "Columns, their order, WIP limits and the filter come from the board. Changes in Jira show up here."],
                          ["jql", "A JQL query", "Any set of issues. One column per workflow status, which you can then group and order."],
                        ] as const
                      ).map(([id, title, text]) => (
                        <button
                          key={id}
                          aria-pressed={build === id}
                          onClick={() => {
                            setBuild(id);
                            setReached(1);
                            if (id === "jql" && draft.connection) setDraft(pickOrigin(draft, draft.connection, { kind: "jql", query: "" }, "Query"));
                            if (id === "board") set({ origin: null });
                          }}
                          className={cx("rounded-lg border px-3 py-2.5 text-left", build === id ? "border-accent bg-accent/[0.08]" : "border-border hover:bg-panel-2")}
                        >
                          <span className="block ui-text-13 text-fg">{title}</span>
                          <span className="mt-0.5 block ui-text-12 text-muted">{text}</span>
                        </button>
                      ))}
                    </div>
                  </section>
                )}
                {tracker === "jira" && build === "jql" ? (
                  <label className="flex flex-col gap-1.5">
                    <span className="ui-text-12 text-muted">JQL query</span>
                    <textarea
                      className={cx(inputCls, "min-h-[72px] font-mono ui-text-12.5")}
                      placeholder="project = WEB AND component = frontend"
                      value={draft.origin?.kind === "jql" ? draft.origin.query : ""}
                      onChange={(e) => draft.connection && set({ origin: { kind: "jql", query: e.target.value } })}
                    />
                  </label>
                ) : (
                  draft.connection && (
                    <section aria-label="Pick what the board shows">
                      <div className="mb-2 ui-text-12 text-muted">{tracker === "jira" ? "Jira board" : tracker === "linear" ? "Linear team" : tracker === "clickup" ? "ClickUp list" : "Repository"}</div>
                      {choicesError && <p className="ui-text-12.5 text-error">{choicesError}</p>}
                      {!choices && !choicesError && <p className="ui-text-12.5 text-muted">Loading…</p>}
                      {choices && choices.length === 0 && <p className="ui-text-12.5 text-muted">{tracker === "github" ? "No project of this workspace has a GitHub origin." : "Nothing to pick."}</p>}
                      <div role="radiogroup" className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border">
                        {(choices ?? []).map((c) => {
                          const added = alreadyAdded(config.boards, draft.workspace, draft.connection ?? "", c.origin);
                          const on = JSON.stringify(draft.origin) === JSON.stringify(c.origin);
                          return (
                            <button
                              key={JSON.stringify(c.origin)}
                              role="radio"
                              aria-checked={on}
                              disabled={added}
                              onClick={() => {
                                if (!draft.connection) return;
                                setDraft(pickOrigin(draft, draft.connection, c.origin, c.name, c.sprints));
                                setReached(1);
                              }}
                              className={cx("flex items-center gap-3 px-3 py-2.5 text-left", on ? "bg-accent/[0.08]" : "hover:bg-panel-2", added && "opacity-60")}
                            >
                              <span className={cx("h-3 w-3 shrink-0 rounded-full border", on ? "border-accent bg-accent" : "border-border-strong")} />
                              <span className="w-[64px] shrink-0 truncate font-mono ui-text-12 text-muted">{c.key}</span>
                              <span className="min-w-0 flex-1 truncate ui-text-13 text-fg">{c.name}</span>
                              {c.kind && <span className="ui-text-12 text-faint">{c.kind}</span>}
                              <span className="w-[100px] text-right ui-text-12 text-faint">{added ? "Already added" : on && draft.columns.length ? `${draft.columns.length} columns` : ""}</span>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  )
                )}
              </div>
            )}
            {draft.step === 2 && (
              <div className="flex flex-col gap-4">
                {draft.origin?.kind === "jira_board" && (
                  <section aria-label="Board filter">
                    <div className="mb-1.5 ui-text-12 text-muted">Board filter, from Jira</div>
                    <div className="flex items-center gap-2 rounded-lg border border-border bg-bg/40 px-3 py-2 font-mono ui-text-12.5 text-muted">
                      <Lock size={12} />
                      <span className="min-w-0 flex-1 truncate">{filterJql === undefined ? "Reading the board's filter…" : (filterJql ?? "Jira did not share the board's filter")}</span>
                    </div>
                  </section>
                )}
                {(draft.origin?.kind === "jira_board" || draft.origin?.kind === "jql") && (
                  <label className="flex flex-col gap-1.5">
                    <span className="ui-text-12 text-muted">
                      {draft.origin.kind === "jql" ? "JQL query" : "Narrow it down in moonlet"} <span className="text-faint">{draft.origin.kind === "jql" ? "" : "· optional JQL, added with AND"}</span>
                    </span>
                    {draft.origin.kind === "jql" ? (
                      <textarea className={cx(inputCls, "min-h-[60px] font-mono ui-text-12.5")} value={draft.origin.query} onChange={(e) => set({ origin: { kind: "jql", query: e.target.value } })} />
                    ) : (
                      <input className={cx(inputCls, "font-mono ui-text-12.5")} placeholder="component in (frontend, design-system)" value={draft.narrow} onChange={(e) => set({ narrow: e.target.value })} />
                    )}
                  </label>
                )}
                {(draft.origin?.kind === "linear_team" || draft.origin?.kind === "github_repo" || draft.origin?.kind === "clickup_list") && (
                  <label className="flex flex-col gap-1.5">
                    <span className="ui-text-12 text-muted">
                      Labels <span className="text-faint">· optional, any of them, comma separated</span>
                    </span>
                    <input
                      className={inputCls}
                      placeholder="frontend, bug"
                      value={draft.labels.join(", ")}
                      onChange={(e) =>
                        set({
                          labels: e.target.value
                            .split(",")
                            .map((x) => x.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  </label>
                )}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="mb-1.5 ui-text-12 text-muted">Show issues assigned to</div>
                    <div role="group" aria-label="Show issues assigned to" className="inline-flex gap-0.5 rounded-md bg-panel-2 p-0.5">
                      {(["me", "anyone"] as const).map((a) => (
                        <button key={a} aria-pressed={draft.assignee === a} onClick={() => set({ assignee: a })} className={cx("rounded-[5px] px-3 py-1 ui-text-12.5", draft.assignee === a ? "bg-raised text-fg" : "text-muted")}>
                          {a === "me" ? "Me" : "Anyone"}
                        </button>
                      ))}
                    </div>
                    <p className="mt-1.5 ui-text-11.5 text-faint">Others' issues are dimmed. The header filter can still switch it.</p>
                  </div>
                  <div>
                    <div className="mb-1.5 ui-text-12 text-muted">Finished issues</div>
                    <select aria-label="Finished issues" className={selectCls} value={String(draft.finished)} onChange={(e) => set({ finished: e.target.value === "sprint" ? "sprint" : 14 })}>
                      {finishedChoices(tracker ?? "github", draft.sprints, draft.finished).map((c) => (
                        <option key={String(c.value)} value={String(c.value)}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <section aria-label="Preview" className="rounded-lg border border-border px-3 py-2.5">
                  {!preview && <p className="ui-text-12.5 text-muted">Counting the issues…</p>}
                  {preview?.error && <p className="ui-text-12.5 text-error">{preview.error}</p>}
                  {preview && !preview.error && (
                    <>
                      <p className="flex items-center gap-2 ui-text-12.5 text-fg">
                        <Check size={13} className="text-done" />
                        {previewLine(preview.tasks, branches, draft.connection ?? "")}
                      </p>
                      {sample.map((t) => (
                        <div key={t.key} className="mt-1 flex items-center gap-3 pl-5 ui-text-12.5">
                          <span className="w-[90px] shrink-0 truncate font-mono text-faint">{t.key}</span>
                          <span className="min-w-0 flex-1 truncate text-muted">{t.title}</span>
                          <span className="text-faint">{t.tracker?.state ?? (t.column === "open" ? "Open" : "Closed")}</span>
                        </div>
                      ))}
                    </>
                  )}
                </section>
              </div>
            )}
            {draft.step === 3 && (
              <div className="flex flex-col gap-3">
                <section aria-label="Board preview">
                  <div className="mb-1.5 ui-text-12 text-muted">Preview</div>
                  <div className="flex h-[34px] gap-1 rounded-lg border border-border p-1">
                    {draft.columns
                      .filter((c) => c.show !== "hide")
                      .map((c) => (
                        <div key={c.name} title={c.name} className={cx("flex min-w-0 flex-col overflow-hidden rounded-[4px] bg-panel-2", c.show === "fold" ? "w-[14px] shrink-0" : "flex-1")}>
                          <div className={cx("h-[2px]", CATEGORY_BAR[c.category])} />
                          {c.show !== "fold" && <span className="truncate px-1.5 pt-0.5 ui-text-11 text-muted">{c.name}</span>}
                        </div>
                      ))}
                  </div>
                </section>
                {!draft.columns.length && <p className="ui-text-12.5 text-muted">Reading the columns…</p>}
                <div role="table" aria-label="Columns" className="overflow-hidden rounded-lg border border-border">
                  <div role="row" className={cx("grid items-center gap-2 border-b border-border px-2 py-1.5 ui-text-11.5 text-faint", grid)}>
                    <span />
                    <span>{trackerName(draft.connection ?? "")} column · statuses</span>
                    <span>moonlet treats it as</span>
                    <span>On the board</span>
                    {wip && <span>WIP</span>}
                  </div>
                  {draft.columns.map((c, i) => (
                    <div key={c.name} role="row" aria-label={c.name} className={cx("grid items-center gap-2 border-b border-border px-2 py-1.5 last:border-b-0", grid)}>
                      <span className="flex">
                        <IconButton title={`Move ${c.name} up`} onClick={() => moveAt(i, -1)}>
                          <ArrowUp size={12} />
                        </IconButton>
                        <IconButton title={`Move ${c.name} down`} onClick={() => moveAt(i, 1)}>
                          <ArrowDown size={12} />
                        </IconButton>
                      </span>
                      <span className="min-w-0">
                        <span className={cx("block truncate ui-text-13", c.show === "hide" ? "text-faint" : "text-fg")}>{c.name}</span>
                        <span className="block truncate ui-text-11.5 text-faint">{c.statuses.length ? c.statuses.join(" · ") : "no status"}</span>
                      </span>
                      <span className="flex items-center gap-1.5">
                        <TaskGlyph column={c.category} size={12} />
                        <select aria-label={`Category of ${c.name}`} className={selectCls} value={c.category} onChange={(e) => setColumn(i, { category: e.target.value as BoardColumn["category"] })}>
                          {CATEGORY_CHOICES.map(([id, label]) => (
                            <option key={id} value={id}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </span>
                      <span role="group" aria-label={`${c.name} on the board`} className="inline-flex gap-0.5 rounded-md bg-panel-2 p-0.5">
                        {(["show", "fold", "hide"] as const).map((v) => (
                          <button key={v} aria-pressed={(c.show ?? "show") === v} onClick={() => setColumn(i, { show: v })} className={cx("rounded-[5px] px-2 py-0.5 ui-text-12", (c.show ?? "show") === v ? "bg-raised text-fg" : "text-muted")}>
                            {v === "show" ? "Show" : v === "fold" ? "Fold" : "Hide"}
                          </button>
                        ))}
                      </span>
                      {wip && <span className="font-mono ui-text-12 text-faint">{c.wip ?? "—"}</span>}
                    </div>
                  ))}
                </div>
                <p className="ui-text-12 text-faint">
                  Suggested from each status's {trackerName(draft.connection ?? "")} category. Change one where your team means something else. A hidden column's issues are not shown.
                </p>
              </div>
            )}
            {draft.step === 4 && (
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-4">
                  <label className="flex flex-col gap-1.5">
                    <span className="ui-text-12 text-muted">Name</span>
                    <input className={inputCls} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="ui-text-12 text-muted">Workspace</span>
                    <select className={selectCls} value={draft.workspace} onChange={(e) => set({ workspace: e.target.value })}>
                      {wsOptions.map((w) => (
                        <option key={w.value} value={w.value}>
                          {w.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <section aria-label="New sessions from this board start in">
                  <div className="mb-1.5 ui-text-12 text-muted">New sessions from this board start in</div>
                  <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
                    <div className="grid grid-cols-[minmax(0,1fr)_16px_200px_24px] items-center gap-2 px-3 py-2">
                      <span className="ui-text-12.5 text-muted">By default</span>
                      <ArrowRight size={12} className="text-faint" />
                      <select
                        aria-label="Project by default"
                        className={selectCls}
                        value={defaultRule?.project ?? ""}
                        onChange={(e) => setRules([...(e.target.value ? [{ when: "default" as const, project: e.target.value }] : []), ...otherRules])}
                      >
                        <option value="">The projects that link it</option>
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                      <span />
                    </div>
                    {otherRules.map((r, i) => {
                      const by = r.when !== "default" && "component" in r.when ? "component" : "label";
                      const value = r.when === "default" ? "" : "component" in r.when ? r.when.component : r.when.label;
                      const update = (next: StartRule | null) => setRules([...(defaultRule ? [defaultRule] : []), ...otherRules.flatMap((x, j) => (j === i ? (next ? [next] : []) : [x]))]);
                      return (
                        <div key={i} className="grid grid-cols-[minmax(0,1fr)_16px_200px_24px] items-center gap-2 px-3 py-2">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <select aria-label="Rule by" className={cx(selectCls, "w-[110px]")} value={by} onChange={(e) => update({ when: e.target.value === "component" ? { component: value } : { label: value }, project: r.project })}>
                              <option value="component">Component</option>
                              <option value="label">Label</option>
                            </select>
                            <input aria-label="Rule value" className={cx(inputCls, "min-w-0 flex-1")} value={value} onChange={(e) => update({ when: by === "component" ? { component: e.target.value } : { label: e.target.value }, project: r.project })} />
                          </span>
                          <ArrowRight size={12} className="text-faint" />
                          <select aria-label="Rule project" className={selectCls} value={r.project} onChange={(e) => update({ when: r.when, project: e.target.value })}>
                            {projects.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </select>
                          <IconButton title="Remove rule" onClick={() => update(null)}>
                            <X size={12} />
                          </IconButton>
                        </div>
                      );
                    })}
                    <button
                      disabled={!projects.length}
                      onClick={() => setRules([...draft.rules, { when: { component: "" }, project: projects[0]?.id ?? "" }])}
                      className="px-3 py-2 text-left ui-text-12.5 text-accent hover:underline disabled:text-faint"
                    >
                      + Add a rule by component or label
                    </button>
                  </div>
                </section>
                <section aria-label="Cards show">
                  <div className="mb-1.5 ui-text-12 text-muted">Cards show</div>
                  <div className="flex flex-wrap gap-4">
                    {cardChoices(tracker ?? "github").map(([id, label]) => (
                      <label key={id} className="flex items-center gap-1.5 ui-text-12.5 text-fg">
                        <input type="checkbox" checked={draft.cards.includes(id)} onChange={(e) => set({ cards: e.target.checked ? [...draft.cards, id] : draft.cards.filter((x) => x !== id) })} />
                        {label}
                      </label>
                    ))}
                  </div>
                </section>
                <section aria-label="Summary" className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
                  <span className="flex h-7 w-7 items-center justify-center rounded-md bg-panel-2">
                    <BoardMark size={14} connection={draft.connection ?? GITHUB} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate ui-text-13 text-fg">{draft.name || "Untitled board"}</span>
                    <span className="block truncate ui-text-12 text-faint">{summaryLine(draft, preview?.tasks.length ?? 0, wsName)}</span>
                  </span>
                  <label className="flex items-center gap-1.5 ui-text-12.5 text-muted">
                    <input type="checkbox" checked={draft.pinned} onChange={(e) => set({ pinned: e.target.checked })} />
                    Pin in sidebar
                  </label>
                </section>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 border-t border-border px-5 py-3">
            <span className={cx("min-w-0 flex-1 truncate ui-text-12", clashText && draft.step === 4 ? "text-error" : "text-faint")}>
              {clashText && draft.step === 4 ? clashText : null}
              {draft.step === 1 && `moonlet reads the board's configuration; it never changes it in ${trackerName(draft.connection ?? "jira")}.`}
              {draft.step === 2 && "Counts update as you type."}
              {draft.step === 3 && `Order and folding are moonlet-only and don't change ${trackerName(draft.connection ?? "jira")}.`}
              {draft.step === 4 && !clashText && "Saved to ~/.moonlet/trackers.toml."}
            </span>
            {editing && (
              <Button size="sm" variant="danger" onClick={() => void remove()}>
                Remove board
              </Button>
            )}
            {draft.step > 1 && (
              <Button size="sm" variant="ghost" onClick={() => set({ step: (draft.step - 1) as Draft["step"] })}>
                Back
              </Button>
            )}
            {editing ? (
              <Button size="sm" variant="primary" disabled={!canSave} onClick={() => void create()}>
                Save
              </Button>
            ) : draft.step < 4 ? (
              <Button size="sm" variant="primary" disabled={!ok} onClick={() => set({ step: (draft.step + 1) as Draft["step"] })}>
                Continue <ArrowRight size={12} />
              </Button>
            ) : (
              <Button size="sm" variant="primary" disabled={!ok} onClick={() => void create()}>
                Create board
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
