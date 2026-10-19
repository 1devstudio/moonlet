import { useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Check, ChevronDown, ChevronRight, CornerDownLeft, FileText, FolderPlus, GitBranch, GitPullRequest, MoreHorizontal, X } from "lucide-react";
import { hostsApi, rpc } from "../lib/daemon";
import type { TaskStart } from "../lib/tasks";
import { branchUser, leaveTasksMode, startedFromTask } from "../lib/tasksStore";
import { composerOptions, composerPick, composerProjects, composerTarget } from "../lib/workspaces";
import { attachments, branchRow, firstMessage, placeholder, sessionName, type Attachment } from "../lib/composer";
import { M, type IssueRef, type Project, type ProjectConfig, type Session } from "../lib/protocol";
import { errorToast, selectSession, shownWorkspace, useStore } from "../lib/store";
import { Menu, type MenuItem } from "./Menu";
import { AgentIcon, BoardTile, IconButton, cx } from "./ui";
import { CLAUDE_MODELS, EFFORTS, resolveMode } from "../lib/agents";
import { ModeMenu, useModeMenu } from "./ModeMenu";
import { PlusMenu } from "./PlusMenu";
import { Markdown } from "./AgentView";
import { fileMention } from "../lib/plusMenu";
import { fromOtherDialog } from "../lib/modal";


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

/** Issue / PR picker behind the pull request icon (X54). */
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
    // A tab's list that arrives after a switch to the other tab is dropped:
    // issues must not show, or be picked, as pull requests.
    let current = true;
    void rpc<IssueRef[]>(host, tab === "issue" ? M.ghIssues : M.ghPrs, { path: project.path })
      .then((list) => current && setItems(list))
      .catch((e) => current && setError(String(e?.message ?? e)));
    return () => {
      current = false;
    };
  }, [open, tab, host, project.path]);
  const shown = (items ?? []).filter((i) => !q || `#${i.number} ${i.title}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="relative">
      <button
        className={cx("-my-1 flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-fg hover:bg-hover", open && "bg-hover")}
        title="Start from a GitHub issue or pull request"
        onClick={() => setOpen(!open)}
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-black">
          <GitPullRequest size={14} />
        </span>
        <ChevronDown size={14} className="text-muted" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-2 w-[420px] overflow-hidden rounded-xl border border-border-strong bg-[#232323] shadow-2xl">
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

/** A folded attachment (X54): its line, › to unfold its text, × to remove it. */
function AttachmentRow({ a, flash, onRemove }: { a: Attachment; flash: boolean; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const Icon = a.icon === "pr" ? GitPullRequest : FileText;
  return (
    <div role="group" aria-label={`${a.mono ? `${a.mono} ` : ""}${a.before ?? ""}${a.strong}${a.after ?? ""}`} className={cx("rounded-[10px] border bg-panel-2 transition-colors duration-500", flash ? "border-accent/45" : "border-border")}>
      <div className="flex items-center gap-2 px-3 py-[9px] ui-text-12.5 text-muted">
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={open} title={open ? "Fold" : "Unfold"} onClick={() => setOpen(!open)}>
          <Icon size={13} className="shrink-0" />
          {a.mono && <span className="shrink-0 font-mono ui-text-12">{a.mono}</span>}
          <span className="min-w-0 flex-1 truncate">
            {a.before}
            <span className="text-fg">{a.strong}</span>
            {a.after}
          </span>
          <ChevronRight size={13} className={cx("shrink-0 transition-transform", open && "rotate-90")} />
        </button>
        {a.remove && (
          <IconButton title={a.remove} className="h-5 w-5 shrink-0" onClick={onRemove}>
            <X size={11} />
          </IconButton>
        )}
      </div>
      {open && (
        <div className="max-h-[220px] overflow-y-auto border-t border-border px-3 py-2">
          {a.body ? <Markdown text={a.body} task /> : <span className="ui-text-12.5 text-faint">No description.</span>}
        </div>
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
  // Started from an issue, the projects that link its tracker project (X44).
  // An adopted worktree stays in its project (X46).
  const linked = worktree ? [] : (presetTask?.projects ?? []);
  const initial = composerPick(options, { host: presetHost, preset: presetProject, linked, current: selected && currentProject ? { host: selected.host, id: currentProject } : null, worktree: !!worktree });
  const [projectQuery, setProjectQuery] = useState("");
  const [pick, setPick] = useState(initial ? { host: initial.host, id: initial.project.id } : null);
  const current = options.find((o) => pick && o.host === pick.host && o.project.id === pick.id);

  // The task's text is an attachment; what the user types goes after it (X54).
  const [prompt, setPrompt] = useState("");
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
  // The picked PR's attachment, kept unless the user removes it (X54).
  const [prSend, setPrSend] = useState(true);
  const [prContext, setPrContext] = useState<string | null>(null);
  // A picked issue's attachment is outlined for a moment (X54).
  const [flash, setFlash] = useState(false);
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

  // Esc closes the composer wherever the focus is: a pick or an undo button
  // that goes away leaves it on the page. Menus stop their own Esc before it
  // bubbles here; a dialog on top handles its own.
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !fromOtherDialog(e, panel.current)) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!issue) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1500);
    return () => clearTimeout(t);
  }, [issue]);

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
  }, [task, worktree, current?.host]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const projectItem = (o: (typeof options)[number]): MenuItem => ({
    label: o.project.name,
    hint: [o.section, o.host !== "local" ? o.host : null].filter(Boolean).join(" · "),
    checked: !!pick && pick.host === o.host && pick.id === o.project.id,
    onSelect: () => setPick({ host: o.host, id: o.project.id }),
  });
  const found = composerProjects(options, linked, projectQuery, presetHost);
  const projectItems: MenuItem[] = [
    ...(found.linked.length ? [{ kind: "label" as const, label: `Linked to ${task?.key ?? "the issue"}` }, ...found.linked.map(projectItem)] : []),
    ...(found.linked.length && found.others.length ? [{ kind: "label" as const, label: "Other projects" }] : []),
    ...found.others.map(projectItem),
    ...(found.linked.length + found.others.length ? [] : [{ kind: "label" as const, label: "No project matches" }]),
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
        prompt: firstMessage(sent, prompt),
        name: sessionName({ task, pr, issue }),
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

  const sent = attachments({ task, issue, pr: pr && prSend ? pr : null, prContext });
  const row = branchRow({
    base: current?.project.base_branch ?? "base",
    task,
    taskBranch,
    from,
    worktree: worktree ?? null,
    pr,
    checkbox: !!task?.assign,
  });

  if (!options.length) {
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
        role="dialog"
        aria-label="New session"
        className="w-[min(720px,90vw)] rounded-2xl border border-border-strong bg-[#1f1f1f] shadow-2xl"
        ref={panel}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div role="group" aria-label="Project and task" className="flex items-center gap-2.5 border-b border-border py-3 pl-6 pr-4">
          <Menu
            items={projectItems}
            width={300}
            search={{ placeholder: "Search projects…", query: projectQuery, onQuery: setProjectQuery }}
            trigger={(open) => (
              // An existing worktree belongs to its project: the picker stays put.
              <button
                className="-ml-1 flex shrink-0 items-center gap-2 rounded-md px-1 py-1 ui-text-14 font-medium hover:bg-hover disabled:hover:bg-transparent"
                onClick={open}
                disabled={!!worktree}
                title={worktree ? "This worktree belongs to this project" : undefined}
              >
                {current ? current.project.name : <span className="text-muted">Choose a project</span>}
                {current && current.host !== "local" && <span className="font-mono ui-text-12 text-faint">@{current.host}</span>}
                {!worktree && <ChevronDown size={14} className="text-muted" />}
              </button>
            )}
          />
          <span className="text-border-strong">|</span>
          {task ? (
            // The task chip takes the spare width (X54).
            <span role="group" aria-label={`Task ${task.key}`} className="flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-lg bg-hover pl-2 pr-1.5 ui-text-13" title={task.title}>
              <BoardTile tracker={task.kind} />
              <span className="shrink-0 font-mono ui-text-12 text-muted">{task.key}</span>
              <span className="min-w-0 truncate">{task.title}</span>
              <IconButton title="Remove the task link" className="shrink-0" onClick={() => setTask(null)}>
                <X size={12} />
              </IconButton>
            </span>
          ) : (
            <span className="flex-1" />
          )}
          {current && !worktree && (
            <SourcePicker
              host={current.host}
              project={current.project}
              onIssue={(i) => {
                setIssue(i);
                ta.current?.focus();
              }}
              onPr={(p) => {
                setPr(p);
                setPrSend(true);
                setPrContext(null);
                setFrom(null);
                ta.current?.focus();
              }}
            />
          )}
        </div>
        {/* The git things (X54): branch and base, chips, the checkbox and branch options. */}
        <div
          role="group"
          aria-label="Branch"
          className={cx("flex h-[38px] items-center gap-2 border-b border-border pl-6 pr-4 ui-text-12.5 text-muted", row.kind === "pr" ? "bg-done/5" : "bg-panel-2")}
          title={row.kind === "pr" ? (row.title ?? undefined) : undefined}
        >
          {editingFrom ? (
            <>
              <GitBranch size={13} className="shrink-0" />
              <input
                autoFocus
                list="moonlet-composer-branches"
                placeholder={editingFrom === "existing" ? "Existing branch, e.g. feature/login" : `Branch, tag or commit (default ${current?.project.base_branch ?? "base"})`}
                className="min-w-0 flex-1 bg-transparent font-mono text-fg outline-none placeholder:text-faint"
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
            </>
          ) : row.kind === "pr" ? (
            <>
              <GitPullRequest size={13} className="shrink-0 text-done" />
              <span className="shrink-0 text-done">PR #{row.number}</span>
              <span className="min-w-0 shrink-[100000] truncate font-mono text-fg">{row.name}</span>
              {row.detail && <span className="shrink-0 text-faint">{row.detail}</span>}
            </>
          ) : (
            <>
              <GitBranch size={13} className="shrink-0" />
              {row.name ? <span className="min-w-0 shrink-[100000] truncate font-mono text-fg">{row.name}</span> : <span className="shrink-0 text-fg">New branch</span>}
              <span className="shrink-0 text-faint">{row.detail}</span>
              {row.clear && (
                <IconButton
                  title={row.clear}
                  className="h-5 w-5 shrink-0"
                  onClick={() => {
                    setFrom(null);
                    // The × goes away: keep the focus in the composer, so esc still closes it.
                    ta.current?.focus();
                  }}
                >
                  <X size={11} />
                </IconButton>
              )}
            </>
          )}
          {/* The branch name gives way before the chips: its shrink-[100000] leaves them
              less than a layout unit of the shortfall, so they keep their whole name. */}
          {addDirs.map((d) => (
            <span key={d} className="flex min-w-0 max-w-[160px] shrink items-center gap-1.5 rounded-md bg-hover px-2 py-0.5 font-mono ui-text-12" title={d}>
              <FolderPlus size={12} className="shrink-0" /> <span className="truncate">{d.slice(d.lastIndexOf("/") + 1)}</span>
              <button title={`Remove ${d}`} onClick={() => setAddDirs((ds) => ds.filter((x) => x !== d))} className="hover:text-fg">
                <X size={11} />
              </button>
            </span>
          ))}
          <span className="flex-1" />
          {task?.assign && (
            <label className="flex shrink-0 items-center gap-1.5" title={task.assign.title}>
              <input type="checkbox" className="m-0 accent-accent" checked={assign} onChange={(e) => setAssign(e.target.checked)} />
              {task.assign.label}
            </label>
          )}
          {row.kind === "pr" ? (
            <button
              title={row.undo.title}
              onClick={() => {
                setPr(null);
                ta.current?.focus();
              }}
              className="flex h-6 shrink-0 items-center gap-[5px] rounded-md px-2 ui-text-12 text-muted hover:bg-hover hover:text-fg">
              <X size={11} />
              {row.undo.label}
            </button>
          ) : (
            !worktree && (
              <Menu
                items={moreItems}
                width={280}
                trigger={(open) => (
                  <IconButton title="Branch options" className="shrink-0" onClick={open}>
                    <MoreHorizontal size={14} />
                  </IconButton>
                )}
              />
            )
          )}
        </div>
        {/* The attachments above the prompt (X54); the prompt fills what is left. */}
        <div className="flex min-h-[168px] flex-col gap-2 px-6 pb-2 pt-4">
          {sent.map((a) => (
            <AttachmentRow
              key={a.id}
              a={a}
              flash={a.id === "issue" && flash}
              onRemove={() => {
                if (a.id === "issue") setIssue(null);
                if (a.id === "pr") setPrSend(false);
                ta.current?.focus();
              }}
            />
          ))}
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
            placeholder={placeholder({ task: !!task, issue: !!issue, pr: !!pr })}
            className={cx("block min-h-[52px] w-full flex-1 resize-none bg-transparent ui-text-14 leading-[1.6] text-fg outline-none placeholder:text-faint", sent.length > 0 && "pt-1")}
          />
        </div>
        <div className="flex items-center gap-2.5 px-5 pb-4">
          <ModelPicker agents={agents} choice={choice} onChange={setAndSave} label={modelLabel} effortLabel={effortLabel} />
          {choice.agent === "claude" && <ModeMenu menu={modeMenu} className="px-2 py-1.5 ui-text-14" iconSize={14} align="left" />}
          <span className="ml-auto" />
          <PlusMenu variant="composer" onAttach={() => void attach()} onAddDir={() => void addDir()} />
          <button
            disabled={busy || !current}
            title={current ? undefined : "Choose a project first"}
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
