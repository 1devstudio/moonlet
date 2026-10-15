import { useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Check, ChevronDown, CornerDownLeft, FolderPlus, GitBranch, MoreHorizontal, X } from "lucide-react";
import { hostsApi, rpc } from "../lib/daemon";
import type { TaskStart } from "../lib/tasks";
import { branchUser, leaveTasksMode, startedFromTask } from "../lib/tasksStore";
import { composerOptions, composerTarget } from "../lib/workspaces";
import { M, type IssueRef, type Project, type ProjectConfig, type Session } from "../lib/protocol";
import { errorToast, selectSession, shownWorkspace, useStore } from "../lib/store";
import { Menu, type MenuItem } from "./Menu";
import { AgentIcon, cx } from "./ui";
import { CLAUDE_MODELS, EFFORTS, resolveMode } from "../lib/agents";
import { ModeMenu, useModeMenu } from "./ModeMenu";
import { PlusMenu } from "./PlusMenu";
import { fileMention } from "../lib/plusMenu";


interface Choice {
  agent: string;
  model: string | null;
  effort: string | null;
}

const defaultChoice: Choice = { agent: "claude", model: "sonnet", effort: "high" };

function loadChoice(projectId: string): Choice {
  try {
    const raw = localStorage.getItem(`moonlet.composer.${projectId}`);
    return raw ? { ...defaultChoice, ...JSON.parse(raw) } : defaultChoice;
  } catch {
    return defaultChoice;
  }
}

function saveChoice(projectId: string, c: Choice) {
  try {
    localStorage.setItem(`moonlet.composer.${projectId}`, JSON.stringify(c));
  } catch {
    /* storage unavailable */
  }
}

function GitHubMark({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" aria-label="GitHub">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/** Issue / PR picker behind the GitHub icon. */
function SourcePicker({ host, project, onIssue, onPr }: { host: string; project: Project; onIssue: (i: IssueRef) => void; onPr: (p: IssueRef) => void }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"issue" | "pr">("issue");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<IssueRef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setItems(null);
    setError(null);
    void rpc<IssueRef[]>(host, tab === "issue" ? M.ghIssues : M.ghPrs, { path: project.path })
      .then(setItems)
      .catch((e) => setError(String(e?.message ?? e)));
  }, [open, tab, host, project.path]);
  const shown = (items ?? []).filter((i) => !q || `#${i.number} ${i.title}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="relative">
      <button className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-fg hover:bg-hover" title="Start from a GitHub issue or pull request" onClick={() => setOpen(!open)}>
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-black">
          <GitHubMark size={17} />
        </span>
        <ChevronDown size={16} className="text-muted" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-1 w-[420px] overflow-hidden rounded-xl border border-border-strong bg-[#232323] shadow-2xl">
            <div className="flex items-center gap-1 border-b border-border p-2">
              {(["issue", "pr"] as const).map((t) => (
                <button key={t} className={cx("rounded-md px-2.5 py-1 ui-text-13", tab === t ? "bg-hover text-fg" : "text-muted hover:text-fg")} onClick={() => setTab(t)}>
                  {t === "issue" ? "Issues" : "Pull requests"}
                </button>
              ))}
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="ml-auto w-40 rounded-md bg-panel-2 px-2 py-1 ui-text-13 outline-none placeholder:text-faint" />
            </div>
            <div className="max-h-[320px] overflow-y-auto p-1">
              {error && <div className="p-3 ui-text-13 text-muted">GitHub unavailable: {error}</div>}
              {!error && items === null && <div className="p-3 ui-text-13 text-faint">Loading…</div>}
              {shown.map((i) => (
                <button
                  key={i.number}
                  className="flex w-full items-start gap-2 rounded-md px-3 py-2 text-left hover:bg-hover"
                  onClick={() => {
                    setOpen(false);
                    if (tab === "issue") onIssue(i);
                    else onPr(i);
                  }}
                >
                  <span className="shrink-0 font-mono ui-text-12.5 text-muted">#{i.number}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate ui-text-13.5">{i.title}</span>
                    {i.head_branch && <span className="block truncate font-mono ui-text-11.5 text-faint">{i.head_branch}</span>}
                  </span>
                </button>
              ))}
              {items && shown.length === 0 && <div className="p-3 ui-text-13 text-faint">Nothing open.</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Column({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-[150px] p-1">
      <div className="px-2.5 pb-1 pt-1.5 ui-text-11 font-medium uppercase tracking-[0.08em] text-faint">{title}</div>
      {children}
    </div>
  );
}

function Opt({ checked, onClick, children }: { checked: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className={cx("flex w-full items-center gap-2 rounded-md px-2.5 py-[6px] text-left ui-text-14 hover:bg-hover", checked && "bg-[#2c2c2c]")} onClick={onClick}>
      <span className="flex flex-1 items-center gap-2">{children}</span>
      {checked && <Check size={13} />}
    </button>
  );
}

/** Agent · model · effort in one compact panel above the footer. */
function ModelPicker({ agents, choice, onChange, label, effortLabel }: { agents: string[]; choice: Choice; onChange: (c: Choice) => void; label: string; effortLabel?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", down, true);
    return () => window.removeEventListener("mousedown", down, true);
  }, [open]);
  const efforts = EFFORTS.filter((e) => choice.agent === "claude" || ["low", "medium", "high"].includes(e.id));
  return (
    <div ref={ref} className="relative">
      <button className="flex items-center gap-2 rounded-lg px-2 py-1.5 ui-text-14 hover:bg-hover" onClick={() => setOpen(!open)}>
        {choice.agent !== "claude" && choice.agent !== "none" && <AgentIcon agent={choice.agent} size={14} />}
        <span className="text-fg">{label}</span>
        {effortLabel && <span className="text-muted">{effortLabel}</span>}
        <ChevronDown size={14} className="text-muted" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 flex rounded-xl border border-border-strong bg-[#232323] p-1 shadow-2xl">
          <Column title="Agent">
            {agents.map((a) => (
              <Opt
                key={a}
                checked={choice.agent === a}
                onClick={() =>
                  onChange({
                    agent: a,
                    model: a === "claude" ? (choice.agent === "claude" ? choice.model : "sonnet") : null,
                    effort: a === "claude" || a === "codex" ? (choice.effort ?? "high") : null,
                  })
                }
              >
                <AgentIcon agent={a} size={14} /> {a === "claude" ? "Claude Code" : a === "codex" ? "Codex" : a}
              </Opt>
            ))}
            <Opt checked={choice.agent === "none"} onClick={() => onChange({ agent: "none", model: null, effort: null })}>
              <AgentIcon agent={null} size={14} /> Terminal only
            </Opt>
          </Column>
          {choice.agent === "claude" && (
            <Column title="Model">
              {CLAUDE_MODELS.map((m) => (
                <Opt key={m.id} checked={choice.model === m.id} onClick={() => onChange({ ...choice, model: m.id })}>
                  {m.label}
                </Opt>
              ))}
            </Column>
          )}
          {(choice.agent === "claude" || choice.agent === "codex") && (
            <Column title="Effort">
              {efforts.map((e) => (
                <Opt key={e.id} checked={choice.effort === e.id} onClick={() => onChange({ ...choice, effort: e.id })}>
                  {e.label}
                </Opt>
              ))}
            </Column>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * New session (X5): "What do you want to work on?" The name and branch come
 * from the prompt; the session is a fresh worktree of the chosen project.
 */
export function Composer({
  host: presetHost,
  project: presetProject,
  workspace: presetWorkspace,
  task: presetTask,
  worktree,
}: {
  host?: string;
  project?: string;
  workspace?: string;
  /** Starting from a task (X46): the chip, the first message, the branch and the link. */
  task?: TaskStart;
  /** Adopting a worktree without a session, and its branch (X46). */
  worktree?: { path: string; branch: string };
}) {
  const hosts = useStore((s) => s.hosts);
  const allProjects = useStore((s) => s.projects);
  const allWorkspaces = useStore((s) => s.workspaces);
  const allSections = useStore((s) => s.sections);
  const selected = useStore((s) => s.selected);
  const close = () => useStore.setState({ dialog: null });

  // The session goes into the preset workspace, else the one the sidebar
  // shows (X32), and the picker offers that workspace's projects.
  const shown = useStore((s) => shownWorkspace(s));
  const target = composerTarget(presetHost, presetWorkspace, shown);
  const options = useMemo(
    () =>
      composerOptions<Project>(
        Object.fromEntries(
          Object.keys(allProjects).map((h) => [h, { connected: hosts[h]?.status === "connected", workspaces: allWorkspaces[h] ?? [], sections: allSections[h] ?? [], projects: allProjects[h] ?? [] }]),
        ),
        target,
      ),
    // `target` is rebuilt each render; its parts are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allProjects, allSections, allWorkspaces, hosts, target?.host, target?.id],
  );
  /** Every option is in the target workspace when there is one (X32). */
  const workspaceFor = (host: string) => (target?.host === host ? target.id : null);
  const currentProject = useStore((s) => (s.selected ? s.sessions[s.selected.host]?.find((x) => x.id === s.selected!.session)?.project_id : undefined));
  const initial =
    options.find((o) => o.host === presetHost && o.project.id === presetProject) ??
    options.find((o) => o.host === selected?.host && o.project.id === currentProject) ??
    options[0];
  const [pick, setPick] = useState(initial ? { host: initial.host, id: initial.project.id } : null);
  const current = options.find((o) => pick && o.host === pick.host && o.project.id === pick.id);

  const [prompt, setPrompt] = useState(presetTask?.firstMessage ?? "");
  const [task, setTask] = useState(presetTask ?? null);
  const [assign, setAssign] = useState(!!presetTask?.assign?.checked);
  const [taskBranch, setTaskBranch] = useState<string | null>(null);
  // Starts at the Settings default every time; not remembered per project (X7).
  const [mode, setMode] = useState(() => resolveMode(useStore.getState().settings.defaultMode));
  const modeMenu = useModeMenu(mode, setMode);
  const [choice, setChoice] = useState<Choice>(() => (initial ? loadChoice(initial.project.id) : defaultChoice));
  const [config, setConfig] = useState<ProjectConfig | null>(null);
  const [from, setFrom] = useState<{ ref: string; existing: boolean } | null>(null);
  const [editingFrom, setEditingFrom] = useState<null | "from" | "existing">(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [issue, setIssue] = useState<IssueRef | null>(null);
  const [pr, setPr] = useState<IssueRef | null>(null);
  const [addDirs, setAddDirs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!current) return;
    setChoice(loadChoice(current.project.id));
    void rpc<ProjectConfig>(current.host, M.projectConfig, { id: current.project.id }).then(setConfig).catch(() => setConfig(null));
    void rpc<string[]>(current.host, M.gitBranches, { path: current.project.path }).then(setBranches).catch(() => setBranches([]));
    setPr(null);
    setFrom(null);
    setIssue(null);
    setAddDirs([]);
  }, [current?.host, current?.project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => ta.current?.focus(), []);

  // The branch a task names (X44 template); an adopted worktree keeps its own.
  // Create waits for it, so a quick ⌘↵ still gets the task's branch.
  const taskBranchLoad = useRef<Promise<string | null>>(Promise.resolve(null));
  useEffect(() => {
    if (!task || worktree) {
      taskBranchLoad.current = Promise.resolve(null);
      return setTaskBranch(null);
    }
    // `{user}` and `{type}` too (X44).
    taskBranchLoad.current = branchUser(current?.host ?? "local", task.ref.connection)
      .then((user) => hostsApi.taskBranch({ kind: task.kind, key: task.key, title: task.title, number: task.number, template: task.template, maxLen: task.maxLen, user, issueType: task.issueType }))
      .catch(() => null);
    void taskBranchLoad.current.then(setTaskBranch);
  }, [task, worktree]); // eslint-disable-line react-hooks/exhaustive-deps

  const agents = ["claude", "codex", ...Object.keys(config?.agents ?? {}).filter((a) => a !== "claude" && a !== "codex")];
  const modelLabel =
    choice.agent === "none"
      ? "Terminal only"
      : choice.agent === "claude"
        ? (CLAUDE_MODELS.find((m) => m.id === choice.model)?.label ?? "Claude")
        : choice.model
          ? `${choice.agent} · ${choice.model}`
          : choice.agent;
  const effortLabel = choice.agent === "claude" || choice.agent === "codex" ? EFFORTS.find((e) => e.id === choice.effort)?.label : undefined;

  const setAndSave = (c: Choice) => {
    setChoice(c);
    if (current) saveChoice(current.project.id, c);
  };

  const projectItems: MenuItem[] = [
    ...options.map((o) => ({
      label: o.project.name,
      hint: [o.section, o.host !== "local" ? o.host : null].filter(Boolean).join(" · "),
      checked: !!pick && pick.host === o.host && pick.id === o.project.id,
      onSelect: () => setPick({ host: o.host, id: o.project.id }),
    })),
    { kind: "divider" },
    { label: "Add project…", icon: <FolderPlus size={14} className="text-muted" />, onSelect: () => useStore.setState({ dialog: { kind: "add-project" } }) },
  ];

  const moreItems: MenuItem[] = [
    { label: `Start from ${current?.project.base_branch ?? "base"} (default)`, checked: !from && !pr, onSelect: () => (setFrom(null), setPr(null)) },
    { label: "Start from branch or commit…", checked: !!from && !from.existing, onSelect: () => setEditingFrom("from") },
    { label: "Use an existing branch…", checked: !!from?.existing, onSelect: () => setEditingFrom("existing") },
  ];

  const attach = async () => {
    const files = await openDialog({ multiple: true, directory: false, defaultPath: current?.project.path, title: "Attach files or images" });
    const list = Array.isArray(files) ? files : files ? [files] : [];
    if (!list.length || !current) return;
    const rel = list.map((f) => fileMention(f, current.project.path));
    setPrompt((p) => `${p}${p && !p.endsWith("\n") ? "\n" : ""}${rel.map((r) => `@${r}`).join(" ")} `);
    ta.current?.focus();
  };

  // Directories the agent may work in from its first message (X29).
  const addDir = async () => {
    const picked = await openDialog({ directory: true, multiple: false, defaultPath: current?.project.path, title: "Add directory" });
    if (typeof picked === "string") setAddDirs((d) => (d.includes(picked) ? d : [...d, picked]));
  };

  const create = async () => {
    if (!current || busy) return;
    setBusy(true);
    try {
      const named = task && !worktree ? await taskBranchLoad.current : null;
      const s = await rpc<Session>(current.host, M.sessionCreate, {
        project_id: current.project.id,
        prompt: prompt.trim() || null,
        name: task ? task.title : issue && !prompt.trim() ? issue.title : null,
        task: task?.ref ?? null,
        worktree: worktree?.path ?? null,
        agent: choice.agent,
        model: choice.agent === "none" ? null : choice.model,
        effort: choice.agent === "none" ? null : choice.effort,
        mode: choice.agent === "claude" ? mode : null,
        from: from && !from.existing ? from.ref : null,
        existing_branch: !!from?.existing,
        branch: from?.existing ? from.ref : named,
        pr: pr?.number ?? null,
        add_dirs: choice.agent === "none" ? [] : addDirs,
        workspace_id: workspaceFor(current.host),
        cols: 120,
        rows: 32,
      });
      close();
      // Activity, and Keep in step's "session starts" rule (X46).
      if (task) void startedFromTask(current.host, s.workspace_id ?? workspaceFor(current.host) ?? "", task, { session: s.name, assign: !!task.assign && assign });
      // Started from Tasks mode: work on it in Sessions mode (X46).
      if (task || worktree) leaveTasksMode();
      selectSession(current.host, s.id);
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };

  if (!current) {
    return (
      <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[14vh]" onMouseDown={close}>
        <div className="w-[560px] rounded-2xl border border-border-strong bg-[#1f1f1f] p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
          <div className="mb-2 ui-text-14 font-semibold">Add a project first</div>
          <p className="mb-4 ui-text-14 text-muted">A project is a git repository folder on disk. Sessions are created as worktrees of it.</p>
          <button className="rounded-lg bg-fg px-3 py-1.5 ui-text-14 font-medium text-bg" onClick={() => useStore.setState({ dialog: { kind: "add-project" } })}>
            Add project…
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[12vh]" onMouseDown={close}>
      <div
        className="w-[min(720px,90vw)] rounded-2xl border border-border-strong bg-[#1f1f1f] shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
        }}
      >
        <div className="flex items-center gap-3 border-b border-border px-6 py-3.5">
          <Menu
            items={projectItems}
            width={300}
            trigger={(open) => (
              // An existing worktree belongs to its project: the picker stays put.
              <button
                className="flex items-center gap-2 rounded-md px-1 py-1 ui-text-14 font-medium hover:bg-hover disabled:hover:bg-transparent"
                onClick={open}
                disabled={!!worktree}
                title={worktree ? "This worktree belongs to this project" : undefined}
              >
                {current.project.name}
                {current.host !== "local" && <span className="font-mono ui-text-12 text-faint">@{current.host}</span>}
                {!worktree && <ChevronDown size={14} className="text-muted" />}
              </button>
            )}
          />
          <Menu
            items={moreItems}
            width={280}
            trigger={(open) => (
              <button className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg" title="Branch options" onClick={open}>
                <MoreHorizontal size={16} />
              </button>
            )}
          />
          {(from || pr || issue || task || worktree || addDirs.length > 0) && (
            <div className="flex min-w-0 items-center gap-1.5">
              {task && (
                <span className="flex min-w-0 items-center gap-1.5 rounded-md bg-hover px-2 py-1 ui-text-12 text-muted" title={task.title}>
                  <span className="shrink-0 font-mono">For {task.key}</span>
                  <span className="truncate text-fg">{task.title}</span>
                  <button title="Remove the task link" onClick={() => setTask(null)} className="hover:text-fg">
                    <X size={11} />
                  </button>
                </span>
              )}
              {(worktree || (task && taskBranch)) && (
                <span className="flex items-center gap-1.5 rounded-md bg-hover px-2 py-1 font-mono ui-text-12 text-muted" title={worktree ? worktree.path : undefined}>
                  <GitBranch size={12} /> {worktree ? `${worktree.branch} · existing worktree` : taskBranch}
                </span>
              )}
              {from && (
                <span className="flex items-center gap-1.5 rounded-md bg-hover px-2 py-1 font-mono ui-text-12 text-muted">
                  <GitBranch size={12} /> {from.existing ? from.ref : `from ${from.ref}`}
                  <button onClick={() => setFrom(null)} className="hover:text-fg">
                    <X size={11} />
                  </button>
                </span>
              )}
              {pr && (
                <span className="flex items-center gap-1.5 rounded-md bg-hover px-2 py-1 font-mono ui-text-12 text-muted">
                  PR #{pr.number} · {pr.head_branch}
                  <button onClick={() => setPr(null)} className="hover:text-fg">
                    <X size={11} />
                  </button>
                </span>
              )}
              {addDirs.map((d) => (
                <span key={d} className="flex min-w-0 items-center gap-1.5 rounded-md bg-hover px-2 py-1 font-mono ui-text-12 text-muted" title={d}>
                  <FolderPlus size={12} className="shrink-0" /> <span className="truncate">{d.slice(d.lastIndexOf("/") + 1)}</span>
                  <button title={`Remove ${d}`} onClick={() => setAddDirs((ds) => ds.filter((x) => x !== d))} className="hover:text-fg">
                    <X size={11} />
                  </button>
                </span>
              ))}
              {issue && (
                <span className="flex items-center gap-1.5 rounded-md bg-hover px-2 py-1 font-mono ui-text-12 text-muted">
                  #{issue.number}
                  <button onClick={() => setIssue(null)} className="hover:text-fg">
                    <X size={11} />
                  </button>
                </span>
              )}
            </div>
          )}
          <span className="ml-auto" />
          <SourcePicker
            host={current.host}
            project={current.project}
            onIssue={(i) => {
              setIssue(i);
              setPrompt((p) => p || `Resolve #${i.number}: ${i.title}\n\n${i.body.trim()}\n\n${i.url}`.trim());
              ta.current?.focus();
            }}
            onPr={(p) => {
              setPr(p);
              setFrom(null);
              ta.current?.focus();
            }}
          />
        </div>
        {task?.assign && (
          <label className="flex items-center gap-2 border-b border-border px-6 py-2 ui-text-12.5 text-muted">
            <input type="checkbox" checked={assign} onChange={(e) => setAssign(e.target.checked)} />
            {task.assign.label}
          </label>
        )}
        {editingFrom && (
          <div className="flex items-center gap-2 border-b border-border px-6 py-2.5">
            <GitBranch size={14} className="text-muted" />
            <input
              autoFocus
              list="moonlet-composer-branches"
              placeholder={editingFrom === "existing" ? "Existing branch, e.g. feature/login" : `Branch, tag or commit (default ${current.project.base_branch})`}
              className="flex-1 bg-transparent font-mono ui-text-13.5 outline-none placeholder:text-faint"
              onKeyDown={(e) => {
                e.stopPropagation();
                const v = (e.target as HTMLInputElement).value.trim();
                if (e.key === "Enter") {
                  if (v) setFrom({ ref: v, existing: editingFrom === "existing" });
                  setPr(null);
                  setEditingFrom(null);
                  ta.current?.focus();
                }
                if (e.key === "Escape") setEditingFrom(null);
              }}
            />
            <datalist id="moonlet-composer-branches">
              {branches.slice(0, 200).map((b) => (
                <option key={b} value={b} />
              ))}
            </datalist>
          </div>
        )}
        <textarea
          ref={ta}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void create();
            }
          }}
          placeholder="What do you want to work on?"
          className="block h-[200px] w-full resize-none bg-transparent px-6 py-5 ui-text-14 leading-relaxed text-fg outline-none placeholder:text-faint"
        />
        <div className="flex items-center gap-2 px-5 pb-4">
          <ModelPicker agents={agents} choice={choice} onChange={setAndSave} label={modelLabel} effortLabel={effortLabel} />
          {choice.agent === "claude" && <ModeMenu menu={modeMenu} className="px-2 py-1.5 ui-text-14" iconSize={14} align="left" />}
          <span className="ml-auto" />
          <PlusMenu variant="composer" onAttach={() => void attach()} onAddDir={() => void addDir()} />
          <button
            disabled={busy}
            className="flex items-center gap-2 rounded-lg bg-fg px-3 py-1.5 ui-text-14 font-medium text-bg hover:bg-white disabled:opacity-50"
            onClick={() => void create()}
          >
            {busy ? "Creating…" : "Create"} <CornerDownLeft size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
