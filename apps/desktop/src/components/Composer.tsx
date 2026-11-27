import { useEffect, useMemo, useRef, useState } from "react";
import { KIND_WORDS, artifactSessionName, startMessage, startPlaceholder, startRefusal } from "../lib/artifacts";
import { addChip, startWithArtifact, type ArtifactChip } from "../lib/artifactStore";
import { KindTile } from "./ArtifactChips";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Check, ChevronDown, ChevronRight, CornerDownLeft, FileCode, FileText, FolderPlus, GitBranch, GitPullRequest, MoreHorizontal, PenTool, Plus, Radio, X } from "lucide-react";
import { hostsApi, rpc } from "../lib/daemon";
import type { Task, TaskStart } from "../lib/tasks";
import { branchUser, composerTask, ensureTasks, leaveTasksMode, lookUpPasted, originRepoOf, placedTasks, startedFromTask, useTasks } from "../lib/tasksStore";
import { pasteLookup, typedTask } from "../lib/taskLinking";
import { composerOptions, composerPick, composerProjects, composerTarget, composerWorkspace, wsKey } from "../lib/workspaces";
import { afterCreate, attachments, branchRow, composerSlash, firstMessage, slashKey, linkMenu, newBranch, paragraphs, pickerBranches, pickerHint, pickerSearch, placeholder, sessionName, showsLinkSlot, suggestedTask, type Attachment, type PickerList, type PickerTab } from "../lib/composer";
import { M, type ClaudeModel, type IssueRef, type Project, type ProjectConfig, type Session } from "../lib/protocol";
import { errorMessage, errorToast, hostWorkspaces, selectSession, shownWorkspace, useStore } from "../lib/store";
import { syncOffered } from "../lib/sync";
import { declineSync, keepInSync, projectKeepsNew, useSync } from "../lib/syncStore";
import { cloudOffered } from "../lib/cloudMachines";
import { useCloud } from "../lib/cloudStore";
import type { CloudInfo } from "../lib/protocol";
import { Menu, type MenuItem } from "./Menu";
import { AgentIcon, BoardTile, IconButton, cx } from "./ui";
import { EFFORTS, type ModelChoice, agentEfforts, claudeModelLabel, effortAfter, modelMenu, resolveMode } from "../lib/agents";
import { useClaudeModels } from "../lib/claudeModelsStore";
import { useClaudeCommands } from "../lib/claudeCommandsStore";
import { withCompletion } from "../lib/chat";
import { ModeMenu, useModeMenu } from "./ModeMenu";
import { PlusMenu } from "./PlusMenu";
import { CompletionRows, Markdown } from "./AgentView";
import { fileMention, withSlashCommand } from "../lib/plusMenu";
import { fromOtherDialog } from "../lib/modal";
import { defaultStartLabel, gitSettingsOf } from "../lib/gitSettings";
import { branchPrefix, buildNames, buildPick, createFailure, createReady, designAttachments, designDir, promptAfterDrop, type BuildDesign } from "../lib/buildIt";
import { loadDesigns } from "../lib/designStore";
import { pageUrl } from "../lib/designView";
import { viewportOf } from "../lib/designViewport";
import { CardFrame } from "./design/Frame";


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

/** Branch / PR picker behind the pull request icon (X54). */
function SourcePicker({
  host,
  project,
  hint,
  onBranch,
  onPr,
}: {
  host: string;
  project: Project;
  /** What picking from a tab does (X54). */
  hint: (tab: PickerTab) => string;
  onBranch: (b: string) => void;
  onPr: (p: IssueRef) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<PickerTab>("branch");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<PickerList | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setItems(null);
    setError(null);
    // A tab's list that arrives after a switch to the other tab is dropped:
    // pull requests must not show, or be picked, as branches.
    let current = true;
    const load: Promise<PickerList> =
      tab === "branch"
        ? rpc<string[]>(host, M.gitBranches, { path: project.path }).then((list) => ({ tab, list: pickerBranches(list) }))
        : rpc<IssueRef[]>(host, M.ghPrs, { path: project.path }).then((list) => ({ tab, list }));
    void load.then((got) => current && setItems(got)).catch((e) => current && setError(String(e?.message ?? e)));
    return () => {
      current = false;
    };
  }, [open, tab, host, project.path]);
  const pick = (then: () => void) => () => {
    setOpen(false);
    then();
  };
  // Each row picks for the tab its list arrived for.
  const found = items && pickerSearch(items, q);
  const rows = !found
    ? []
    : found.tab === "branch"
      ? found.list.map((b) => ({ key: b, number: null, title: b, branch: null, onPick: pick(() => onBranch(b)) }))
      : found.list.map((i) => ({ key: String(i.number), number: i.number, title: i.title, branch: i.head_branch, onPick: pick(() => onPr(i)) }));
  return (
    <div className="relative">
      <button
        className={cx("-my-1 flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-fg hover:bg-hover", open && "bg-hover")}
        title="Start from a branch or pull request"
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
              {(["branch", "pr"] as const).map((t) => (
                <button key={t} className={cx("rounded-md px-2.5 py-1 ui-text-13", tab === t ? "bg-hover text-fg" : "text-muted hover:text-fg")} onClick={() => (setTab(t), setQ(""))}>
                  {t === "branch" ? "Branches" : "Pull requests"}
                </button>
              ))}
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="ml-auto w-40 rounded-md bg-panel-2 px-2 py-1 ui-text-13 outline-none placeholder:text-faint" />
            </div>
            <div className="max-h-[320px] overflow-y-auto p-1">
              {error && <div className="p-3 ui-text-13 text-muted">{tab === "pr" ? "GitHub" : "Git"} unavailable: {error}</div>}
              {!error && items === null && <div className="p-3 ui-text-13 text-faint">Loading…</div>}
              {rows.map((r) => (
                <button key={r.key} className="flex w-full items-start gap-2 rounded-md px-3 py-2 text-left hover:bg-[#2a2a2a]" onClick={r.onPick}>
                  {r.number !== null ? (
                    <span className="shrink-0 font-mono ui-text-12.5 text-muted">#{r.number}</span>
                  ) : (
                    <GitBranch size={13} className="mt-[3px] shrink-0 text-muted" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className={cx("block truncate ui-text-13.5", r.number === null && "font-mono")}>{r.title}</span>
                    {r.branch && <span className="block truncate font-mono ui-text-11.5 text-faint">{r.branch}</span>}
                  </span>
                </button>
              ))}
              {items && rows.length === 0 && <div className="p-3 ui-text-13 text-faint">{items.tab === "pr" ? "Nothing open." : "No branch matches."}</div>}
            </div>
            <div className="flex items-start gap-2 border-t border-border px-3 py-[9px] ui-text-12 leading-[1.45] text-faint">
              <GitBranch size={12} className="mt-0.5 shrink-0" />
              <span>{hint(tab)}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** A design page's thumbnail in its unfolded attachment (X65 Build it):
 *  the page framed on a host of its own, sandboxed as on the canvas, at
 *  the design's viewport; mounted only while the attachment is unfolded. */
export interface AttachmentPage {
  workspace: string;
  slug: string;
  viewport: [number, number];
}

const THUMB_WIDTH = 320;

/** Each kind of attachment's icon. */
const ATTACHMENT_ICONS: Record<Attachment["icon"], typeof FileText> = { file: FileText, pr: GitPullRequest, page: FileCode, styles: FileCode };

/** A folded attachment (X54): its line, › to unfold its text, × to remove it. */
function AttachmentRow({ a, onRemove, design }: { a: Attachment; onRemove: () => void; design?: AttachmentPage }) {
  const [open, setOpen] = useState(false);
  const Icon = ATTACHMENT_ICONS[a.icon];
  return (
    <div role="group" aria-label={a.file ? `${a.file} ${a.summary}` : `${a.lead}${a.summary}`} className="rounded-[10px] border border-border bg-panel-2">
      <div className="flex items-center gap-2 px-3 py-[9px] ui-text-12.5 text-muted">
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={open} title={open ? "Fold" : "Unfold"} onClick={() => setOpen(!open)}>
          <Icon size={13} className="shrink-0" />
          {a.file ? (
            <span className="min-w-0 flex-1 truncate">
              <span className="font-mono text-fg">{a.file}</span>
              <span className="ml-2">{a.summary}</span>
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate">
              {a.lead}
              <span className="text-fg">{a.summary}</span>
            </span>
          )}
          <ChevronRight size={13} className={cx("shrink-0 transition-transform", open && "rotate-90")} />
        </button>
        {a.remove && (
          <IconButton title={a.remove} className="h-5 w-5 shrink-0" onClick={onRemove}>
            <X size={11} />
          </IconButton>
        )}
      </div>
      {open &&
        (a.file ? (
          // A design's file sends its line; a page shows the page too (X65).
          <div className="flex flex-col gap-2 border-t border-border px-3 py-2">
            <span className="selectable break-all font-mono ui-text-12 text-muted">{a.body}</span>
            {a.page && design && (
              <div className="self-start overflow-hidden rounded-md border border-border-strong">
                <CardFrame url={pageUrl(design.workspace, design.slug, a.page)} title={`${a.file} preview`} viewport={design.viewport} scale={THUMB_WIDTH / design.viewport[0]} />
              </div>
            )}
          </div>
        ) : (
          <div className="max-h-[220px] overflow-y-auto border-t border-border px-3 py-2">
            {a.body ? <Markdown text={a.body} kind="task" /> : <span className="ui-text-12.5 text-faint">No description.</span>}
          </div>
        ))}
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
/** The older models under More models (X105), opened by hovering or clicking its row. The list
 * opens beside the whole panel, not over the Effort column, so it is not
 * positioned against its row and stays open until the panel closes. */
function MoreModels({ items, chosen, onPick }: { items: ModelChoice[]; chosen: string | null; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={cx("flex w-full items-center gap-2 rounded-md px-2.5 py-[6px] text-left ui-text-14 hover:bg-hover", open && "bg-hover")} onMouseEnter={() => setOpen(true)} onClick={() => setOpen(true)}>
        <span className="flex-1">More models</span>
        {items.some((m) => m.id === chosen) && <Check size={13} />}
        <ChevronRight size={13} className="text-muted" />
      </button>
      {open && (
        <div className="absolute bottom-0 left-full ml-1 max-h-[320px] min-w-[150px] overflow-y-auto rounded-xl border border-border-strong bg-[#232323] p-1 shadow-2xl">
          {items.map((m) => (
            <Opt key={m.id} checked={chosen === m.id} onClick={() => onPick(m.id)}>
              {m.label}
            </Opt>
          ))}
        </div>
      )}
    </>
  );
}

function ModelPicker({ agents, choice, onChange, label, effortLabel, models }: { agents: string[]; choice: Choice; onChange: (c: Choice) => void; label: string; effortLabel?: string; models: ClaudeModel[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", down, true);
    return () => window.removeEventListener("mousedown", down, true);
  }, [open]);
  const efforts = agentEfforts(choice.agent, models, choice.model);
  const menu = modelMenu(models);
  const pickModel = (id: string) => onChange({ ...choice, model: id, effort: effortAfter(models, id, choice.effort) });
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
              {menu.latest.map((m) => (
                <Opt key={m.id} checked={choice.model === m.id} onClick={() => pickModel(m.id)}>
                  {m.label}
                </Opt>
              ))}
              {menu.more.length > 0 && <MoreModels items={menu.more} chosen={choice.model} onPick={pickModel} />}
            </Column>
          )}
          {(choice.agent === "claude" || choice.agent === "codex") && efforts.length > 0 && (
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
/** The composer's source chip, after the project: what the session starts
 *  from, with × to start without it (X65 Build it, X114 an artifact). */
function SourceChip({ label, title, drop, onDrop, children }: { label: string; title: string; drop: string; onDrop: () => void; children: React.ReactNode }) {
  return (
    <span role="group" aria-label={label} className="flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-lg bg-hover pl-2 pr-1.5 ui-text-13" title={title}>
      {children}
      <span className="flex-1" />
      <IconButton title={drop} className="shrink-0" onClick={onDrop}>
        <X size={12} />
      </IconButton>
    </span>
  );
}

export function Composer({
  host: presetHost,
  project: presetProject,
  workspace: presetWorkspace,
  task: presetTask,
  worktree,
  design: presetDesign,
  artifact: presetArtifact,
}: {
  host?: string;
  project?: string;
  workspace?: string;
  /** Starting from a task (X46): the chip, the first message, the branch and the link. */
  task?: TaskStart;
  /** Adopting a worktree without a session, and its branch (X46). */
  worktree?: { path: string; branch: string };
  /** Building a workspace design (X65 Build it): its chip, attachments, branch and prompt. */
  design?: BuildDesign;
  /** Starting from an artifact (X114): its chip, and its live reference sent first. */
  artifact?: ArtifactChip;
}) {
  const [artifact, setArtifact] = useState<ArtifactChip | null>(presetArtifact ?? null);
  const hosts = useStore((s) => s.hosts);
  const allProjects = useStore((s) => s.projects);
  const allWorkspaces = useStore((s) => s.workspaces);
  const allSections = useStore((s) => s.sections);
  const selected = useStore((s) => s.selected);
  const close = () => useStore.setState({ dialog: null });

  // The session goes into the preset workspace, else the one the sidebar
  // shows (X32), and the picker offers that workspace's projects.
  const shown = useStore((s) => shownWorkspace(s));
  const accounts = useStore((s) => s.accounts);
  const preset = composerTarget(presetHost, presetWorkspace, shown);
  // The account it belongs to, so any member of it can take the session (X68).
  const target = preset && { ...preset, account: preset.account ?? accounts[preset.host]?.account ?? preset.host };
  const options = useMemo(
    () =>
      composerOptions<Project>(
        Object.fromEntries(
          Object.keys(allProjects).map((h) => [h, { connected: hosts[h]?.status === "connected", account: accounts[h]?.account, workspaces: allWorkspaces[h] ?? [], sections: allSections[h] ?? [], projects: allProjects[h] ?? [] }]),
        ),
        target,
      ),
    // `target` is rebuilt each render; its parts are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allProjects, allSections, allWorkspaces, hosts, accounts, target?.host, target?.id, target?.account],
  );
  /** Every option is in the target workspace when there is one (X32), on
   * whichever member of its account has the project (X68). */
  const workspaceFor = (host: string) => composerWorkspace(target, host, hostWorkspaces(useStore.getState()));
  const currentProject = useStore((s) => (s.selected ? s.sessions[s.selected.host]?.find((x) => x.id === s.selected!.session)?.project_id : undefined));
  // Started from an issue, the projects that link its tracker project (X44).
  // An adopted worktree stays in its project (X46).
  const linked = worktree ? [] : (presetTask?.projects ?? []);
  const initial = composerPick(options, { host: presetHost, preset: presetProject, linked, current: selected && currentProject ? { host: selected.host, id: currentProject } : null, worktree: !!worktree });
  const [projectQuery, setProjectQuery] = useState("");
  const [pick, setPick] = useState(initial ? { host: initial.host, id: initial.project.id } : null);
  const current = options.find((o) => pick && o.host === pick.host && o.project.id === pick.id);

  // Build it (X65): the design, the pages × left out, and why Create was refused.
  const [design, setDesign] = useState(presetDesign ?? null);
  const [left, setLeft] = useState<string[]>([]);
  const [refused, setRefused] = useState<string | null>(null);
  // The task's text is an attachment; what the user types goes after it (X54).
  const [prompt, setPrompt] = useState(() => (presetDesign ? buildNames(presetDesign, "").prompt : ""));
  const [task, setTask] = useState(presetTask ?? null);
  const [assign, setAssign] = useState(!!presetTask?.assign?.checked);
  // Keep in sync with this Mac (X60): for a project on the central host,
  // ticked when the project keeps its new sessions in sync.
  const central = useSync((s) => s.central);
  const syncShown = !!current && syncOffered(current.host, central);
  // null until the project's choice is known; a late answer never undoes the user's tick.
  const [keepSync, setKeepSync] = useState<boolean | null>(null);
  const [syncTouched, setSyncTouched] = useState(false);
  useEffect(() => {
    setKeepSync(null);
    setSyncTouched(false);
    if (!current || !syncShown) return;
    let live = true;
    void projectKeepsNew(current.project.identity).then((k) => live && setKeepSync((v) => (v === null ? k : v)));
    return () => {
      live = false;
    };
  }, [current?.host, current?.project.id, syncShown]); // eslint-disable-line react-hooks/exhaustive-deps
  // Run heavy commands in the cloud (X63): for a project with a cloud setting on its central host.
  const cloudHost = useCloud((s) => s.host);
  const [cloudProjects, setCloudProjects] = useState<CloudInfo["projects"] | null>(null);
  const [cloud, setCloud] = useState(false);
  useEffect(() => {
    setCloudProjects(null);
    setCloud(false);
    if (!current || current.host !== cloudHost) return;
    let live = true;
    void rpc<CloudInfo>(current.host, M.cloudGet).then(
      (i) => live && setCloudProjects(i.projects),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [current?.host, current?.project.id, cloudHost]); // eslint-disable-line react-hooks/exhaustive-deps
  const cloudShown = !!current && current.host === cloudHost && cloudOffered(cloudProjects, current.project.identity);
  const [taskBranch, setTaskBranch] = useState<string | null>(null);
  // Starts at the Settings default every time; not remembered per project (X7).
  const [mode, setMode] = useState(() => resolveMode(useStore.getState().settings.defaultMode));
  const modeMenu = useModeMenu(mode, setMode);
  const [choice, setChoice] = useState<Choice>(() => (initial ? loadChoice(initial.project.id) : defaultChoice));
  const [config, setConfig] = useState<ProjectConfig | null>(null);
  // Build it's lines name the project's design folder: Create waits for its config.
  const [configRead, setConfigRead] = useState(false);
  const [from, setFrom] = useState<{ ref: string; existing: boolean } | null>(null);
  const [editingFrom, setEditingFrom] = useState<null | "from" | "existing">(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [pr, setPr] = useState<IssueRef | null>(null);
  // The picked PR's attachment, kept unless the user removes it (X54).
  const [prSend, setPrSend] = useState(true);
  const [prContext, setPrContext] = useState<string | null>(null);
  /** The request for the picked PR's context still wanted: a later pick, or another project, replaces it. */
  const wantedContext = useRef<object | null>(null);
  const [addDirs, setAddDirs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // Link a task (X54): the target workspace's tasks, when it has a task source.
  const taskData = useTasks((t) => (target ? t.data[wsKey(target.host, target.id)] : undefined));
  const tasksConfig = useTasks((t) => t.config);
  const wsTasks = useMemo(() => (taskData ? placedTasks(taskData) : []), [taskData, tasksConfig]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (target) ensureTasks(target.host, target.id);
  }, [target?.host, target?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [taskQuery, setTaskQuery] = useState("");
  // A key or URL typed into Link a task is asked of its tracker when it is not among the
  // loaded tasks, so a task assigned to someone else, or off the boards, links too.
  // The answer is kept with the text it is for, so a newer keystroke never shows the last one's.
  const [typed, setTyped] = useState<{ query: string; task: Task | null } | null>(null);
  const foundTask = typed?.query === taskQuery ? typed.task : null;
  const [lookup] = useState(() => pasteLookup());
  const latestTasks = useRef(wsTasks);
  latestTasks.current = wsTasks;
  const originRepo = useStore((s) => (current && target && taskData ? originRepoOf(s, target.host, taskData, current.host, current.project.id) : null));
  // What the last lookup was asked with: new tasks, another project or its repository ask again.
  const askedWith = useRef("");
  const tasksLoaded = !!taskData;
  useEffect(() => {
    if (!current || !taskQuery.trim()) {
      lookup.cancel();
      askedWith.current = "";
      return;
    }
    const context = `${tasksLoaded} ${originRepo} ${current.host} ${current.project.path}`;
    const force = askedWith.current !== "" && askedWith.current !== context;
    askedWith.current = context;
    const asked = taskQuery;
    void lookup
      .query(
        asked,
        () => typedTask(asked, latestTasks.current, originRepo, { parse: hostsApi.parsePasted, lookUp: (p) => lookUpPasted(current.host, current.project.path, p, originRepo) }),
        force,
      )
      .then((task) => task !== undefined && setTyped({ query: asked, task }));
  }, [taskQuery, current?.host, current?.project.path, originRepo, tasksLoaded]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => lookup.cancel(), [lookup]);
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!current) return;
    setChoice(loadChoice(current.project.id));
    setConfigRead(false);
    // A project picked meanwhile asks again: this answer is no longer its.
    let live = true;
    void rpc<ProjectConfig>(current.host, M.projectConfig, { id: current.project.id })
      .then((c) => live && setConfig(c))
      .catch(() => live && setConfig(null))
      .finally(() => live && setConfigRead(true));
    void rpc<string[]>(current.host, M.gitBranches, { path: current.project.path }).then(setBranches).catch(() => setBranches([]));
    setPr(null);
    wantedContext.current = null;
    setFrom(null);
    setAddDirs([]);
    return () => {
      live = false;
    };
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
    // A task linked after this one wins (X54 Link a task).
    const load = taskBranchLoad.current;
    void load.then((b) => taskBranchLoad.current === load && setTaskBranch(b));
  }, [task, worktree, current?.host]); // eslint-disable-line react-hooks/exhaustive-deps

  const agents = ["claude", "codex", ...Object.keys(config?.agents ?? {}).filter((a) => a !== "claude" && a !== "codex")];
  // The models Claude Code offers in the target workspace's profile (X105).
  const currentWorkspace = current ? workspaceFor(current.host) : undefined;
  const claudeModels = useClaudeModels(current?.host, currentWorkspace);
  // Claude's slash commands for the project, for the prompt's `/` menu and `+` (X111).
  const claudeCommands = useClaudeCommands(choice.agent === "claude" ? current?.host : undefined, current?.project.id, currentWorkspace);
  const [caret, setCaret] = useState(0);
  const [slashSel, setSlashSel] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState<number | null>(null);
  const slash = composerSlash({ agent: choice.agent, commands: claudeCommands, text: prompt, caret, dismissed: slashDismissed });
  useEffect(() => setSlashSel(0), [slash.rows.length, slash.token?.query]);
  /** The prompt as `r` has it, with the caret where it says, focused. */
  const putPrompt = (r: { text: string; caret: number }) => {
    setPrompt(r.text);
    setCaret(r.caret);
    ta.current?.focus();
    requestAnimationFrame(() => ta.current?.setSelectionRange(r.caret, r.caret));
  };
  // A saved effort the model turns out not to support, once its list arrives (X105).
  useEffect(() => {
    if (!claudeModels.length || choice.agent !== "claude" || !choice.model) return;
    const effort = effortAfter(claudeModels, choice.model, choice.effort);
    if (effort !== choice.effort) setAndSave({ ...choice, effort });
  }, [claudeModels, choice.agent, choice.model]); // eslint-disable-line react-hooks/exhaustive-deps
  const modelLabel =
    choice.agent === "none"
      ? "Terminal only"
      : choice.agent === "claude"
        ? choice.model
          ? claudeModelLabel(claudeModels, choice.model)
          : "Claude"
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

  const startFrom = useStore((s) => gitSettingsOf(s.gitSettings, current?.host ?? "local").start_from);
  const moreItems: MenuItem[] = [
    { label: defaultStartLabel(current?.project.base_branch ?? "base", startFrom), checked: !from && !pr, onSelect: () => (setFrom(null), setPr(null)) },
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
    if (!current || !createReady({ busy, project: true, building: !!design, configRead })) return;
    // An artifact this session cannot refer to is said before any session is made (X114).
    const cannot = artifact ? startRefusal(artifact, current.host, choice.agent) : null;
    if (cannot) return setRefused(cannot);
    setBusy(true);
    setRefused(null);
    try {
      const named = newBranch({ taskBranch: task && !worktree ? await taskBranchLoad.current : null, build: built });
      const s = await rpc<Session>(current.host, M.sessionCreate, {
        project_id: current.project.id,
        // From an artifact, the first message goes once it is referred to (X114).
        prompt: artifact ? null : firstMessage(sent, prompt),
        name: artifact ? artifactSessionName(artifact) : sessionName({ task, pr, build: built }),
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
        cloud: cloudShown && cloud,
        workspace_id: workspaceFor(current.host),
        // Copied into the worktree as a session design before the agent starts (X65).
        design: design ? buildPick(design, left) : null,
        cols: 120,
        rows: 32,
      });
      close();
      if (artifact) {
        const from = artifact;
        // Not sent: the artifact stays picked in the new session's input, to send again.
        void startWithArtifact(current.host, s.id, from, paragraphs(...sent.map((a) => a.message), startMessage(from.kind, prompt))).catch((e) => {
          addChip(current.host, s.id, from);
          errorToast(e);
        });
      }
      // The checkbox decides for this session, Build it's too (afterCreate).
      const next = afterCreate({ building: !!design, box: { shown: syncShown, value: keepSync, touched: syncTouched } });
      if (next.sync === "keep") void keepInSync(current.host, s.id);
      else if (next.sync === "decline") void declineSync(s.id);
      // Built from Design mode: the design's header says where it is building (X65).
      if (next.designs && design) void loadDesigns(current.host, design.workspace, true).catch(() => {});
      if (!next.select) return;
      // Activity, and Keep in step's "session starts" rule (X46).
      if (task) void startedFromTask(current.host, s.workspace_id ?? workspaceFor(current.host) ?? "", task, { session: s.name, assign: !!task.assign && assign });
      // Started from Tasks mode: work on it in Sessions mode (X46).
      if (task || worktree) leaveTasksMode();
      selectSession(current.host, s.id);
    } catch (e) {
      // Build it says why in the composer, such as a design folder the base branch has (X65).
      const failed = createFailure(!!design, errorMessage(e));
      if ("refused" in failed) setRefused(failed.refused);
      else errorToast(failed.toast);
    } finally {
      setBusy(false);
    }
  };

  // Linked here, a task starts as if the composer had opened on it, in the
  // project already picked (X54).
  const linkTo = (t: Task) => {
    if (!target) return;
    const start = composerTask(target.host, target.id, t);
    setTask(start);
    // A task found by its key off the boards may be someone else's: it is not assigned to the user unless they tick the box.
    setAssign(!!start.assign?.checked && wsTasks.includes(t));
    setTaskQuery("");
  };
  const canLink = !!target && showsLinkSlot({ task: !!task, worktree: !!worktree, sources: !!taskData?.sources.length });
  const suggestion = canLink ? suggestedTask({ pr }, wsTasks) : null;
  const linkItems: MenuItem[] = canLink
    ? linkMenu({ pr }, prompt, wsTasks, taskQuery, foundTask).flatMap((section) => [
        { kind: "label" as const, label: section.label },
        ...section.tasks.map(({ task: t, hint }) => ({ label: `${t.key} ${t.title}`, hint: hint ?? undefined, onSelect: () => linkTo(t) })),
      ])
    : [];

  const prefix = useStore((s) => branchPrefix(config, gitSettingsOf(s.gitSettings, current?.host ?? "local").branch_prefix));
  const built = design ? buildNames(design, prefix) : null;
  const designSent = design ? designAttachments(design, { systemName: design.systemName, dir: designDir(config), left }) : [];
  const sent = [...designSent, ...attachments({ task, pr: pr && prSend ? pr : null, prContext })];
  const thumbs = design ? { workspace: design.workspace, slug: design.slug, viewport: viewportOf(design) } : undefined;
  const row = branchRow({
    base: current?.project.base_branch ?? "base",
    task,
    taskBranch,
    from,
    worktree: worktree ?? null,
    pr,
    checkbox: !!task?.assign,
    named: built?.branch ?? null,
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
    <div className="fixed inset-0 z-50 flex flex-col items-center bg-black/60 pt-[12vh]" onMouseDown={close}>
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
          {artifact ? (
            // The artifact is the composer's source (X114).
            <SourceChip label={`${KIND_WORDS[artifact.kind]} ${artifact.name}`} title={artifact.name} drop={`Start without the ${artifact.kind}`} onDrop={() => (setArtifact(null), setRefused(null))}>
              <KindTile kind={artifact.kind} size={18} />
              <span className="shrink-0 font-mono ui-text-12 text-muted">{KIND_WORDS[artifact.kind]}</span>
              <span className="min-w-0 truncate">{artifact.name}</span>
            </SourceChip>
          ) : design && built ? (
            // The design is the composer's source (X65 Build it).
            <SourceChip label={built.chip} title={design.name} drop="Don’t build the design" onDrop={() => (setPrompt((p) => promptAfterDrop(p, design)), setDesign(null), setRefused(null))}>
              <PenTool size={13} className="shrink-0 text-accent" />
              <span className="min-w-0 truncate">{built.chip}</span>
            </SourceChip>
          ) : task ? (
            // The task chip takes the spare width (X54).
            <span role="group" aria-label={`Task ${task.key}`} className="flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-lg bg-hover pl-2 pr-1.5 ui-text-13" title={task.title}>
              <BoardTile tracker={task.kind} />
              <span className="shrink-0 font-mono ui-text-12 text-muted">{task.key}</span>
              <span className="min-w-0 truncate">{task.title}</span>
              <IconButton title="Remove the task link" className="shrink-0" onClick={() => setTask(null)}>
                <X size={12} />
              </IconButton>
            </span>
          ) : canLink ? (
            // No task yet: a slot that links one, suggesting the one a pick points at (X54).
            <span role="group" aria-label="Link a task" className="flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-lg border border-dashed border-border-strong pl-2 pr-1 ui-text-13 text-muted">
              <Menu
                items={linkItems}
                width={420}
                search={{ placeholder: "Search tasks by key or title", query: taskQuery, onQuery: setTaskQuery }}
                trigger={(open) => (
                  <button className="flex shrink-0 items-center gap-2 hover:text-fg" onClick={open}>
                    <Plus size={13} />
                    Link a task
                  </button>
                )}
              />
              {suggestion && (
                <>
                  <span className="text-border-strong">·</span>
                  <span className="min-w-0 flex-1 truncate text-faint">
                    {suggestion.from} {suggestion.verb}{" "}
                    <span className="font-mono ui-text-12 text-fg">{suggestion.task.key}</span>
                  </span>
                  <button
                    title={`Link ${suggestion.task.key} ${suggestion.task.title}`}
                    className="h-[22px] shrink-0 rounded-[5px] bg-accent/12 px-2 ui-text-12 text-accent-2 hover:bg-accent/20"
                    onClick={() => linkTo(suggestion.task)}
                  >
                    Link
                  </button>
                </>
              )}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          {current && !worktree && (
            <SourcePicker
              host={current.host}
              project={current.project}
              hint={(tab) => pickerHint(tab, task && { key: task.key, branch: taskBranch }, current.project.base_branch)}
              onBranch={(b) => {
                setFrom({ ref: b, existing: true });
                setPr(null);
                setEditingFrom(null);
                ta.current?.focus();
              }}
              onPr={(p) => {
                setPr(p);
                setPrSend(true);
                setPrContext(null);
                setFrom(null);
                // Its reviews and comments, once read; the list's description until then (X54).
                const request = {};
                wantedContext.current = request;
                void rpc<string>(current.host, M.ghPrContext, { path: current.project.path, number: p.number })
                  .then((text) => wantedContext.current === request && setPrContext(text))
                  .catch(() => {});
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
          {syncShown && (
            <label className="flex shrink-0 items-center gap-1.5" title="Keep a live copy of the session on this Mac">
              <input type="checkbox" aria-label="Keep in sync with this Mac" className="m-0 accent-accent" checked={!!keepSync}
                onChange={(e) => {
                  setSyncTouched(true);
                  setKeepSync(e.target.checked);
                }}
              />
              Keep in sync with this Mac
            </label>
          )}
          {cloudShown && (
            <label className="flex shrink-0 items-center gap-1.5" title={`Routed commands go to ${current.project.name}'s cloud machine first. When none is ready, a command starts one and waits for it.`}>
              <input type="checkbox" aria-label="Run heavy commands in the cloud" className="m-0 accent-accent" checked={cloud} onChange={(e) => setCloud(e.target.checked)} />
              Run heavy commands in the cloud
            </label>
          )}
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
          {artifact && (
            <div role="group" aria-label={`${KIND_WORDS[artifact.kind]}, live and read only · ${artifact.name}`} className="flex items-center gap-2 rounded-[10px] border border-border bg-panel-2 px-3 py-[9px] ui-text-12.5 text-muted">
              <Radio size={13} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                {KIND_WORDS[artifact.kind]}, live and read only · <span className="text-fg">{artifact.name}</span>
              </span>
            </div>
          )}
          {sent.map((a) => (
            <AttachmentRow
              key={a.id}
              a={a}
              design={thumbs}
              onRemove={() => {
                if (a.id === "pr") setPrSend(false);
                // × leaves a design's page out of the copy and the message (X65).
                if (a.page) setLeft((l) => [...l, a.page!]);
                ta.current?.focus();
              }}
            />
          ))}
          {/* Claude's slash commands under the first line, as the chat's `/` menu (X111). */}
          <div className="relative flex min-h-[52px] flex-1 flex-col">
            {slash.rows.length > 0 && (
              <div className="absolute left-0 top-[30px] z-30 w-full max-w-[420px] overflow-hidden rounded-xl border border-border-strong bg-[#232323] p-1 shadow-2xl">
                <CompletionRows rows={slash.rows.map((value) => ({ value, hint: null }))} sel={slashSel} onPick={(v) => slash.token && putPrompt(withCompletion(prompt, caret, slash.token, v))} />
              </div>
            )}
            <textarea
              ref={ta}
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                setCaret(e.target.selectionStart);
                // An edit opens the menu again after Escape, as in the chat.
                setSlashDismissed(null);
              }}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                const act = slash.token ? slashKey(e, slash.rows, slashSel) : null;
                if (act && slash.token) {
                  e.preventDefault();
                  // Escape closes the menu, not the composer.
                  e.stopPropagation();
                  if ("move" in act) setSlashSel(act.move);
                  else if ("accept" in act) putPrompt(withCompletion(prompt, caret, slash.token, act.accept));
                  else setSlashDismissed(slash.token.start);
                } else if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void create();
                }
              }}
              placeholder={artifact ? startPlaceholder(artifact.kind) : placeholder(sent.map((a) => a.id))}
              className={cx("block min-h-[52px] w-full flex-1 resize-none bg-transparent ui-text-14 leading-[1.6] text-fg outline-none placeholder:text-faint", sent.length > 0 && "pt-1")}
            />
          </div>
        </div>
        <div className="flex items-center gap-2.5 px-5 pb-4">
          <ModelPicker agents={agents} choice={choice} onChange={setAndSave} label={modelLabel} effortLabel={effortLabel} models={claudeModels} />
          {choice.agent === "claude" && <ModeMenu menu={modeMenu} className="px-2 py-1.5 ui-text-14" iconSize={14} align="left" />}
          <span className="ml-auto" />
          <PlusMenu
            variant="composer"
            onAttach={() => void attach()}
            onAddDir={() => void addDir()}
            commands={claudeCommands}
            onCommand={choice.agent === "claude" ? (name) => putPrompt(withSlashCommand(prompt, name)) : undefined}
          />
          <button
            disabled={!createReady({ busy, project: !!current, building: !!design, configRead })}
            title={current ? undefined : "Choose a project first"}
            className="flex items-center gap-2 rounded-lg bg-fg px-3 py-1.5 ui-text-14 font-medium text-bg hover:bg-white disabled:opacity-50"
            onClick={() => void create()}
          >
            {busy ? "Creating…" : "Create"} <CornerDownLeft size={14} />
          </button>
        </div>
        {refused && (
          <p role="alert" className="border-t border-border px-6 py-2.5 ui-text-12.5 text-error">
            {refused}
          </p>
        )}
      </div>
      {built && (
        <p className="mt-2.5 w-[min(720px,90vw)] px-2 ui-text-12.5 text-faint" onMouseDown={(e) => e.stopPropagation()}>
          {built.note}
        </p>
      )}
    </div>
  );
}
