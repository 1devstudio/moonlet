// App state. Daemons own the truth (projects, sessions, terminals); this store
// mirrors it per host from RPCs and events, plus UI-only state.

import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { afterCheck, afterDownloadEvent, checkError, scheduleUpdateChecks, type CheckOutcome, type UpdateState } from "./updater";
import { afterClaudeCheck, afterClaudeUpdateExit, afterClaudeUpdateLine, closeClaudeBanner, type ClaudeUpdateState, type ClaudeVersions, type ClaudeUpdateRun } from "./claudeUpdate";
import { hostsApi, onDaemonEvent, onHostStatus, rpc, subscribeHost, type DaemonEvent } from "./daemon";
import { type Layout, emptyLayout, parseLayout, reconcile, removeSession, tabOf } from "./layout";
import {
  type AgentState,
  type Attention,
  type BasePull,
  type BaseStatus,
  EV,
  type FsChanged,
  type GitStatus,
  type HostInfo,
  M,
  type Project,
  type PullRequest,
  type TerminalInfo,
  type Session,
  type ProfileAccount,
  type ProfileInfo,
  type Section,
  type Workspace,
} from "./protocol";
import { sanitize } from "./sanitize";
import { DEFAULT_MODE } from "./agents";
import { DEFAULT_SOUNDS, type SoundSettings } from "./sounds";
import { DoneBursts, alertFor, type BannerSettings } from "./alerts";
import { type ToolCallView, forgetChat, loadChat, onChatItem, onChatState } from "./chat";
import { justMerged, pullToast, type FetchInfo } from "./baseSync";
import { avatarUrl } from "./projectAvatar";
import type { Archiving } from "./archiveLoader";
import type { PendingConfirm } from "./confirm";
import type { TaskStart } from "./tasks";
import { spawnedNotices } from "./spawned";
import { currentWorkspace, isShown, sessionToRestore, switcherRows, wsKey, type HostWorkspaces, type WorkspaceRef } from "./workspaces";
import { focusThrottle, latestPerKey, needsPrPoll } from "./prPoll";
import type { ChatItem, ChatState, ReadRequest } from "./protocol";
import { readWaits, type ReadQueue } from "./terminalRead";
import type { Shortcuts } from "./runActions";
import type { SettingsRoute } from "./settingsPage";
import { readStored, writeStored } from "./storage";
import { disposeEntry, findEntry, reattachHost, setTermSettings, type TermSettings, defaultTermSettings } from "./terminals";

/** Right panel tabs, in order (X24 added Plan, X42 Agents, X46 Task for a linked session). */
export const RIGHT_TABS = ["task", "plan", "agents", "files", "changes", "review"] as const;
export type RightTab = (typeof RIGHT_TABS)[number];

export interface Selection {
  host: string;
  session: string;
}

export interface OpenFile {
  host: string;
  path: string;
  line?: number;
}

export interface Settings {
  term: TermSettings;
  notifyWhenFocused: boolean;
  /** Permission mode a new Claude session starts in (X7). */
  defaultMode: string;
  /** Sound per attention event, "" for off (X10). */
  sounds: SoundSettings;
  /** Desktop notification per attention event; a missing one is on (X47). */
  banners?: Partial<BannerSettings>;
  /** Every sound off, from the bell in the sidebar footer (X47). */
  muted?: boolean;
  /** Runs of tool calls folded into one row, or one row per call (X14). */
  toolCalls: ToolCallView;
  /** Custom keyboard shortcuts from the Run action modal (X19). */
  shortcuts: Shortcuts;
  /** Mode an approved plan switches to, `auto` or `acceptEdits` (X24). */
  planApproveMode: string;
  /** Shiki theme of the editor and diffs (X26). */
  editorTheme: string;
  /** Look for a new moonlet release at launch and every six hours (X35). */
  autoUpdateCheck: boolean;
  /** The Claude Code release the user said Later to (X36). */
  claudeUpdateDismissed?: string | null;
}

export const sesKey = (host: string, id: string) => `${host}/${id}`;
export const termKey = (host: string, id: number) => `${host}:${id}`;
export const projKey = (host: string, id: string) => `${host}/${id}`;

/** A project's base branch against origin, for the sidebar's pull chip (X13). */
export interface BaseSync extends FetchInfo {
  status: BaseStatus | null;
  pulling: boolean;
}

const SETTINGS_KEY = "settings";
const UI_KEY = "ui";

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = readStored(key);
    const v = raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
    // Defaults from older versions (wider review panel).
    if (v && typeof v === "object" && (v as { rightWidth?: number }).rightWidth === 520) (v as { rightWidth: number }).rightWidth = 380;
    if (v && typeof v === "object" && (v as { sidebarWidth?: number }).sidebarWidth === 264) (v as { sidebarWidth: number }).sidebarWidth = 280;
    // Tabs from older versions.
    if (v && typeof v === "object" && "rightTab" in v && !(RIGHT_TABS as readonly string[]).includes((v as { rightTab: string }).rightTab)) {
      (v as { rightTab: string }).rightTab = "files";
    }
    return v;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, v: unknown) {
  try {
    writeStored(key, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
}

interface UiPersist {
  selected: Selection | null;
  sidebarWidth: number;
  rightWidth: number;
  rightOpen: boolean;
  sidebarOpen: boolean;
  rightTab: RightTab;
  collapsed: Record<string, boolean>;
  /** The Changes tab's layout (X28). */
  changesView: "tree" | "list";
  /** The workspace the sidebar shows (X32). */
  workspace: WorkspaceRef | null;
  /** The session last open in each workspace (`host/workspaceId`). */
  lastSession: Record<string, string>;
  /** Workspaces (`host/workspaceId`) showing Tasks mode instead of Sessions (X45). */
  tasksMode: Record<string, boolean>;
}

const uiDefaults: UiPersist = {
  selected: null,
  sidebarWidth: 280,
  rightWidth: 380,
  rightOpen: true,
  sidebarOpen: true,
  rightTab: "files",
  collapsed: {},
  changesView: "tree",
  workspace: null,
  lastSession: {},
  tasksMode: {},
};

/** In-app card when an agent in the open workspace finishes or needs input. */
export interface AgentCard {
  host: string;
  terminal: number;
  session: string;
  agent: string | null;
  state: AgentState;
  message: string;
  workedMs: number | null;
  at: number;
}

export interface Toast {
  id: number;
  kind: "info" | "error";
  text: string;
  action?: { label: string; run: () => void };
}

interface State extends UiPersist {
  hosts: Record<string, HostInfo>;
  projects: Record<string, Project[]>;
  sessions: Record<string, Session[]>;
  /** Workspaces per host (X32). */
  workspaces: Record<string, Workspace[]>;
  /** Sections (sets of projects) per host, in no particular order: a
   * workspace's `section_ids` orders its own. */
  sections: Record<string, Section[]>;
  /** Claude profiles per host (X33). */
  profiles: Record<string, ProfileInfo[]>;
  /** Who the default profile (`~/.claude`) is signed in as, per host. */
  defaultAccounts: Record<string, ProfileAccount | null>;
  /** Pull request per session (`sesKey`), when known. */
  prs: Record<string, PullRequest | null>;
  /** Base branch against origin per project (`projKey`). */
  base: Record<string, BaseSync>;
  /** GitHub owner avatar per project (`projKey`), or null without a GitHub origin (X15). */
  avatars: Record<string, string | null>;
  terminals: Record<string, Record<number, TerminalInfo>>;
  layouts: Record<string, Layout>;
  git: Record<string, GitStatus | undefined>;
  /** Sessions that need attention and have not been looked at. */
  unread: Record<string, AgentState>;
  /** Text waiting for a structured agent's composer (`termKey`), such as a
   * command block sent from a shell (T8). */
  agentDrafts: Record<string, string>;
  fsVersion: Record<string, number>;
  /** Files with unsaved edits in an editor tab (`host|path`, X26). */
  dirtyFiles: Record<string, true>;
  showHistory: boolean;
  dialog:
    | null
    | {
        kind: "new-session";
        host?: string;
        project?: string;
        workspace?: string;
        /** Starting from a task (X46). */
        task?: TaskStart;
        /** Adopting a worktree without a session, with its branch (X46). */
        worktree?: { path: string; branch: string };
      }
    | { kind: "add-project"; host?: string; section?: string }
    | { kind: "new-section" }
    | { kind: "new-workspace" }
    | { kind: "create-pr" }
    /** Link a session to a task (X46). */
    | { kind: "link-task"; host: string; session: string }
    | { kind: "palette" }
    | { kind: "commit" };
  /** The open confirm modal, above any dialog (X23). */
  confirm: PendingConfirm | null;
  /** The settings page over the window, when open (X43). */
  settingsPage: SettingsRoute | null;
  /** Agents' requests to read a terminal, waiting for the user (X31). */
  reads: ReadQueue;
  /** Sessions per host whose terminal reads need no answer (X31). */
  readGrants: Record<string, string[]>;
  settings: Settings;
  toasts: Toast[];
  /** A new moonlet release and how far its install got (X35). */
  update: UpdateState;
  updateChecking: boolean;
  /** Why the last check the user asked for, or the last install, failed. */
  updateError: string | null;
  /** This app's version, for Settings and the "up to date" toast. */
  appVersion: string | null;
  /** The sidebar banner about a newer Claude Code (X36). */
  claudeUpdate: ClaudeUpdateState;
  /** The installed Claude Code and npm's newest, from the last check. */
  claudeVersions: ClaudeVersions;
  claudeChecking: boolean;
  lastAttention: { host: string; session: number; at: number } | null;
  /** When each agent session last started working (for "worked for 7s"). */
  workingSince: Record<string, number>;
  card: AgentCard | null;
  /** The subagent the Agents tab shows in detail, `agentKey` (X42). */
  agentDetail: string | null;
  /** Per chat (`termKey`): the latest agent start when × hid the strip (X42). */
  stripDismissed: Record<string, number>;
  /** File shown in the Changes diff (set from the Files list). */
  diffFile: string | null;
  /** Sessions (`sesKey`) whose sidebar row plays the archive loader (X21). */
  archiving: Record<string, Archiving>;
}

// One store per page, even when Vite hot-reloads this module: a fresh copy
// would be empty and never wired to daemon events.
const g = globalThis as { __moonletStore?: ReturnType<typeof makeStore>; __moonletStarted?: boolean; __moonletOnEvent?: (e: DaemonEvent) => void };
function makeStore() {
  return create<State>(() => ({
  ...loadJson(UI_KEY, uiDefaults),
  hosts: {},
  projects: {},
  sessions: {},
  terminals: {},
  workspaces: {},
  sections: {},
  profiles: {},
  defaultAccounts: {},
  prs: {},
  base: {},
  avatars: {},
  layouts: {},
  git: {},
  unread: {},
  agentDrafts: {},
  fsVersion: {},
  dirtyFiles: {},
  showHistory: false,
  dialog: null,
  confirm: null,
  settingsPage: null,
  reads: {},
  readGrants: {},
  settings: loadJson<Settings>(SETTINGS_KEY, { term: defaultTermSettings, notifyWhenFocused: false, defaultMode: DEFAULT_MODE, sounds: DEFAULT_SOUNDS, toolCalls: "collapsed", shortcuts: {}, planApproveMode: "auto", editorTheme: "dark-plus", autoUpdateCheck: true }),
  toasts: [],
  update: { phase: "idle" },
  updateChecking: false,
  updateError: null,
  appVersion: null,
  claudeUpdate: { phase: "idle" },
  claudeVersions: { installed: null, latest: null },
  claudeChecking: false,
  lastAttention: null,
  workingSince: {},
  card: null,
  agentDetail: null,
  stripDismissed: {},
  diffFile: null,
  archiving: {},
  }));
}
export const useStore = (g.__moonletStore ??= makeStore());

const set = useStore.setState;

const get = useStore.getState;

useStore.subscribe((s, prev) => {
  if (
    s.selected !== prev.selected ||
    s.sidebarWidth !== prev.sidebarWidth ||
    s.rightWidth !== prev.rightWidth ||
    s.rightOpen !== prev.rightOpen ||
    s.sidebarOpen !== prev.sidebarOpen ||
    s.rightTab !== prev.rightTab ||
    s.collapsed !== prev.collapsed ||
    s.changesView !== prev.changesView ||
    s.workspace !== prev.workspace ||
    s.lastSession !== prev.lastSession ||
    s.tasksMode !== prev.tasksMode
  ) {
    const { selected, sidebarWidth, rightWidth, rightOpen, sidebarOpen, rightTab, collapsed, changesView, workspace, lastSession, tasksMode } = s;
    saveJson(UI_KEY, { selected, sidebarWidth, rightWidth, rightOpen, sidebarOpen, rightTab, collapsed, changesView, workspace, lastSession, tasksMode });
  }
  if (s.settings !== prev.settings) {
    saveJson(SETTINGS_KEY, s.settings);
    setTermSettings(s.settings.term);
  }
});

let toastId = 0;
export function toast(text: string, kind: Toast["kind"] = "info", action?: Toast["action"]) {
  const id = ++toastId;
  set((s) => ({ toasts: [...s.toasts, { id, kind, text, action }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), action ? 10_000 : kind === "error" ? 7000 : 3500);
}

export function errorToast(e: unknown) {
  toast(e instanceof Error ? e.message : String(e), "error");
}

// ---------------------------------------------------------------- updates (X35)

/** The update the last check found. It holds a Rust-side resource, so a
 *  replaced one is closed. */
let foundUpdate: Update | null = null;

/** Set when the user asks while a check runs: that check reports to them. */
let reportCheck = false;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Asks the updater endpoint for a newer release. `afterCheck` decides what
 *  the user sees. */
export async function checkForUpdates({ manual = false } = {}) {
  if (get().updateChecking) {
    if (manual) reportCheck = true;
    return;
  }
  reportCheck = manual;
  set({ updateChecking: true });
  let found: Update | null = null;
  let outcome: CheckOutcome;
  try {
    found = await check();
    outcome = { found: found?.version ?? null };
  } catch (e) {
    console.warn("update check failed", e);
    outcome = { error: checkError(message(e)) };
  }
  const prev = get().update;
  const { state, notice, error } = afterCheck(prev, outcome, { manual: reportCheck, running: get().appVersion });
  reportCheck = false;
  if (state === prev) {
    void found?.close();
  } else {
    if (foundUpdate && foundUpdate !== found) void foundUpdate.close();
    foundUpdate = found;
  }
  set({ update: state, updateError: error, updateChecking: false });
  if (notice) toast(notice.text, notice.kind, notice.install ? { label: "Install", run: () => void installUpdate() } : undefined);
}

/** Downloads the found update, verifies its signature and installs it. The
 *  app runs it after a restart. */
export async function installUpdate() {
  const u = foundUpdate;
  const prev = get().update;
  if (!u || prev.phase !== "available") return;
  // Busy from the click on, so a check meanwhile keeps this update.
  set({ update: { phase: "downloading", version: u.version, received: 0, total: null }, updateError: null });
  try {
    await u.downloadAndInstall((e) => set((s) => ({ update: afterDownloadEvent(s.update, e) })));
    set({ update: { phase: "ready", version: u.version } });
  } catch (e) {
    set({ update: prev, updateError: message(e) });
    errorToast(e);
  }
}

/** Relaunches into the installed version. Sessions live in the daemon, which
 *  the new app upgrades on connect (S3). */
export function restartToUpdate() {
  void relaunch().catch(errorToast);
}

/** What the update button's action (see `updateButton`) does. */
export const updateActions = { install: () => void installUpdate(), restart: restartToUpdate };

// ---------------------------------------------------------------- Claude Code updates (X36)

/** Claude Code is checked and updated on this machine's daemon only. */
const LOCAL = "local";

const claudeVersion = () => rpc<{ version: string | null; updating: boolean }>(LOCAL, M.claudeVersion);

/** Counts updates started or finished, so a check that began before one
 *  does not put back the version from before it. */
let claudeRuns = 0;

/** Compares the installed Claude Code with npm's newest. A side that cannot
 *  be read is unknown, which shows no banner: being offline is not an error. */
export async function checkClaudeVersion() {
  if (get().claudeChecking) return;
  set({ claudeChecking: true });
  const runs = claudeRuns;
  const unknown = (what: string) => (e: unknown) => {
    console.warn(`${what} failed`, e);
    return null;
  };
  const [local, latest] = await Promise.all([claudeVersion().catch(unknown("claude --version")), hostsApi.claudeLatest().catch(unknown("Claude Code release check"))]);
  if (runs !== claudeRuns) return set({ claudeChecking: false });
  const versions = { installed: local?.version ?? null, latest };
  const check = { ...versions, updating: local?.updating ?? false };
  set((s) => ({ claudeChecking: false, claudeVersions: versions, claudeUpdate: afterClaudeCheck(s.claudeUpdate, check, s.settings.claudeUpdateDismissed ?? null) }));
}

/** Runs `claude update`; its lines move the banner's steps as they come. */
export async function updateClaude() {
  const { installed, latest } = get().claudeVersions;
  if (!installed || !latest || get().claudeUpdate.phase === "updating") return;
  claudeRuns++;
  set({ claudeUpdate: { phase: "updating", installed, latest, step: "check" } });
  let run: ClaudeUpdateRun;
  try {
    run = await rpc<{ ok: boolean; output: string }>(LOCAL, M.claudeUpdate);
  } catch (e) {
    run = { error: message(e) };
  }
  await finishClaudeUpdate(run);
}

/** Ends the banner's run, from this window's request or from the daemon's
 *  `claude.update_done`, whichever comes first, and reads the version now
 *  installed. */
async function finishClaudeUpdate(run: ClaudeUpdateRun) {
  const { state, dismiss } = afterClaudeUpdateExit(get().claudeUpdate, run);
  // Already ended here, or another window ran it: catch up with its result.
  if (state === get().claudeUpdate) return void checkClaudeVersion();
  claudeRuns++;
  set({ claudeUpdate: state });
  if (dismiss) updateSettings({ claudeUpdateDismissed: dismiss });
  const now = await claudeVersion().catch(() => null);
  if (now?.version) set((s) => ({ claudeVersions: { ...s.claudeVersions, installed: now.version } }));
}

/** Later hides the announced release until a newer one is out; the close
 *  button only hides the banner. */
export function closeClaudeUpdate(how: "later" | "close") {
  const { state, dismiss } = closeClaudeBanner(get().claudeUpdate, how);
  if (dismiss) updateSettings({ claudeUpdateDismissed: dismiss });
  set({ claudeUpdate: state });
}

// ---------------------------------------------------------------- selectors

export function selectedSession(s: State = get()): Session | undefined {
  if (!s.selected) return undefined;
  return s.sessions[s.selected.host]?.find((w) => w.id === s.selected!.session);
}

export function sessionTerminals(s: State, host: string, wsId: string): TerminalInfo[] {
  return Object.values(s.terminals[host] ?? {})
    .filter((x) => x.session_id === wsId)
    .sort((a, b) => a.id - b.id);
}

const RANK: Record<AgentState, number> = { blocked: 5, error: 4, working: 3, done: 2, idle: 1 };

/** The most urgent agent state among a workspace's sessions. */
export function sessionState(s: State, host: string, wsId: string): AgentState | null {
  // An agent waiting for the user to share a terminal needs them (X31).
  if (readWaits(s.reads, host, wsId)) return "blocked";
  let best: AgentState | null = null;
  for (const x of sessionTerminals(s, host, wsId)) {
    if (x.kind !== "agent") continue;
    if (!best || RANK[x.agent_state] > RANK[best]) best = x.agent_state;
  }
  return best;
}

export function projectOf(s: State, host: string, ws: Session): Project | undefined {
  return s.projects[host]?.find((r) => r.id === ws.project_id);
}

// ------------------------------------------------------------------ actions

/**
 * Loads a host's projects, sessions and terminals. The output channel and the
 * data are independent, so one failing never blanks the other; failures are
 * logged and retried with backoff.
 */
export async function loadHost(host: string, attempt = 0): Promise<void> {
  try {
    await subscribeHost(host);
  } catch (e) {
    console.warn(`output channel for ${host} failed`, e);
  }
  try {
    const [workspaces, sections, profiles, projects, sessions, terminals] = await Promise.all([
      rpc<Workspace[]>(host, M.workspaceList),
      rpc<Section[]>(host, M.sectionList),
      rpc<ProfileInfo[]>(host, M.profileList),
      rpc<Project[]>(host, M.projectList),
      rpc<Session[]>(host, M.sessionList),
      rpc<TerminalInfo[]>(host, M.terminalList),
    ]);
    set((s) => ({
      workspaces: { ...s.workspaces, [host]: workspaces },
      sections: { ...s.sections, [host]: sections },
      profiles: { ...s.profiles, [host]: profiles },
      projects: { ...s.projects, [host]: projects },
      sessions: { ...s.sessions, [host]: sessions },
      terminals: { ...s.terminals, [host]: Object.fromEntries(terminals.map((x) => [x.id, x])) },
    }));
    for (const w of sessions) syncLayout(host, w);
    reattachHost(host);
    // Events may have been missed while disconnected: reload open chats.
    for (const t of terminals) if (t.chat) void loadChat(host, t.id).catch(() => {});
    void refreshAllGit(host).then(() => refreshPrs(host));
    void refreshAllBases(host, { fetch: true });
    void refreshAvatars(host);
    // Apart from the rest: a daemon from before X31 does not know these.
    void Promise.all([
      rpc<ReadRequest[]>(host, M.terminalReadRequests),
      rpc<string[]>(host, M.terminalReadGrants),
    ])
      .then(([requests, grants]) =>
        set((s) => ({ reads: { ...s.reads, [host]: requests }, readGrants: { ...s.readGrants, [host]: grants } })),
      )
      .catch(() => {});
    for (const p of [null, ...profiles.map((p) => p.id)]) void refreshProfile(host, p);
  } catch (e) {
    console.warn(`loading ${host} failed (attempt ${attempt + 1})`, e);
    if (attempt < 8 && get().hosts[host]?.status === "connected") {
      setTimeout(() => void loadHost(host, attempt + 1), Math.min(500 * 2 ** attempt, 8000));
    }
  }
}

export function syncLayout(host: string, w: Session) {
  const key = sesKey(host, w.id);
  const s = get();
  const live = sessionTerminals(s, host, w.id).map((x) => x.id);
  const base = s.layouts[key] ?? parseLayout(w.layout);
  const next = reconcile(base, live);
  if (JSON.stringify(next) !== JSON.stringify(s.layouts[key])) {
    set((st) => ({ layouts: { ...st.layouts, [key]: next } }));
    persistLayout(host, w.id, next);
  }
}

const layoutTimers: Record<string, number> = {};
function persistLayout(host: string, id: string, layout: Layout) {
  const key = sesKey(host, id);
  window.clearTimeout(layoutTimers[key]);
  layoutTimers[key] = window.setTimeout(() => {
    void rpc(host, M.sessionUpdate, { id, layout }).catch(() => {});
  }, 600);
}

export function setLayout(host: string, id: string, layout: Layout) {
  set((s) => ({ layouts: { ...s.layouts, [sesKey(host, id)]: layout } }));
  persistLayout(host, id, layout);
}

export function getLayout(host: string, id: string): Layout {
  return get().layouts[sesKey(host, id)] ?? emptyLayout();
}

/** Opening a session, from the sidebar, a notification, the inbox or the
 * palette, shows its workspace and makes it that workspace's last session (X32). */
function showSessionWorkspace(s: State, host: string, id: string): Partial<State> {
  const wsId = s.sessions[host]?.find((x) => x.id === id)?.workspace_id;
  if (!wsId) return {};
  return { workspace: isShown(s.workspace, host, wsId) ? s.workspace : { host, id: wsId }, lastSession: { ...s.lastSession, [wsKey(host, wsId)]: id } };
}

/** A session needs you while one of its agents is blocked or a terminal of
 * it finished unread: the switcher's attention dot (X32). */
export function sessionNeedsYou(s: State, host: string, id: string): boolean {
  return sessionState(s, host, id) === "blocked" || sessionTerminals(s, host, id).some((t) => !!s.unread[termKey(host, t.id)]);
}

export function focusTerminal(host: string, session: number) {
  const info = get().terminals[host]?.[session];
  if (!info?.session_id) return;
  const ws = info.session_id;
  const layout = getLayout(host, ws);
  const tab = tabOf(layout, session);
  set((s) => {
    const unread = { ...s.unread };
    delete unread[termKey(host, session)];
    return { selected: { host, session: ws }, unread, showHistory: false, ...showSessionWorkspace(s, host, ws) };
  });
  if (tab) setLayout(host, ws, { ...layout, active: tab.id, focused: session });
  doneBursts.seen(sesKey(host, ws));
  updateBadge();
}

export function selectSession(host: string, id: string) {
  set((s) => ({ selected: { host, session: id }, diffFile: null, ...showSessionWorkspace(s, host, id) }));
  const layout = getLayout(host, id);
  if (layout.focused !== null) {
    set((s) => {
      const unread = { ...s.unread };
      delete unread[termKey(host, layout.focused!)];
      return { unread };
    });
  }
  doneBursts.seen(sesKey(host, id));
  updateBadge();
  void refreshGit(host, id);
}

/** Every host's workspaces, local first, as the switcher lists them (X32). */
export function hostWorkspaces(s: State): HostWorkspaces[] {
  return Object.values(s.hosts)
    .sort((a, b) => Number(a.remote) - Number(b.remote) || a.id.localeCompare(b.id))
    .map((h) => ({ host: h.id, label: h.label, workspaces: s.workspaces[h.id] ?? [], sections: s.sections[h.id] ?? [], sessions: s.sessions[h.id] ?? [], profiles: s.profiles[h.id] ?? [] }));
}

/** Asks `claude auth status` who a profile (`null`: the default) is signed
 * in as (X33). The daemon answers named profiles with `profiles.changed`. */
export async function refreshProfile(host: string, id: string | null) {
  try {
    const account = await rpc<ProfileAccount>(host, M.profileStatus, id ? { id } : {});
    if (!id) set((s) => ({ defaultAccounts: { ...s.defaultAccounts, [host]: account } }));
  } catch (e) {
    console.warn(`profile status for ${id ?? "the default profile"} failed`, e);
  }
}

let fallback: WorkspaceRef | null = null;

/** The workspace the sidebar shows: the remembered one, else the first.
 * The same object while it is unchanged, so it can be a zustand selector. */
export function shownWorkspace(s: State): WorkspaceRef | null {
  const r = currentWorkspace(s.workspace, hostWorkspaces(s));
  if (!r || r === s.workspace) return r;
  if (fallback?.host !== r.host || fallback.id !== r.id) fallback = r;
  return fallback;
}

/** Shows workspace `ref` and reopens the session last open in it. */
export function switchWorkspace(ref: WorkspaceRef) {
  const s = get();
  // Remember what was open in the workspace being left.
  const from = shownWorkspace(s);
  const lastSession = from && s.selected ? { ...s.lastSession, [wsKey(from.host, from.id)]: s.selected.session } : s.lastSession;
  const restore = sessionToRestore(lastSession[wsKey(ref.host, ref.id)], s.sessions[ref.host] ?? [], ref.id);
  set({ workspace: ref, lastSession, showHistory: false });
  if (restore) selectSession(ref.host, restore);
  else set({ selected: null });
}

/** ⌃⌘1–9: the n-th workspace in the switcher's order. */
export function switchWorkspaceByIndex(n: number) {
  const row = switcherRows(hostWorkspaces(get()))[n];
  if (row) switchWorkspace({ host: row.host, id: row.ws.id });
}

const gitInflight: Record<string, boolean> = {};
export async function refreshGit(host: string, id: string) {
  const key = sesKey(host, id);
  const w = get().sessions[host]?.find((x) => x.id === id);
  if (!w || w.archived || gitInflight[key]) return;
  gitInflight[key] = true;
  try {
    const st = await rpc<GitStatus>(host, M.gitStatus, { path: w.path, base: w.base });
    set((s) => ({ git: { ...s.git, [key]: st } }));
  } catch {
    /* worktree may be gone */
  } finally {
    gitInflight[key] = false;
  }
}

/** PR state per session (purple branch icon); slow-moving, so polled rarely.
 *  A few sessions at a time, so many sessions do not queue up behind one. */
export async function refreshPrs(host: string, opts: { openOnly?: boolean } = {}) {
  const queue = (get().sessions[host] ?? []).filter((w) => !w.archived && needsPrPoll(get().prs[sesKey(host, w.id)], opts));
  const worker = async () => {
    for (let w = queue.shift(); w; w = queue.shift()) {
      try {
        await pollPr(host, w.id, w.path);
      } catch {
        /* no gh, no remote, or not a GitHub repo */
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
}

const prPolls = latestPerKey();
/** Reads a session's PR and records it, unless a newer poll for the same
 *  session started meanwhile; that one records instead. */
export async function pollPr(host: string, sessionId: string, path: string): Promise<PullRequest | null> {
  const isLatest = prPolls.start(sesKey(host, sessionId));
  const pr = await rpc<PullRequest | null>(host, M.prStatus, { path });
  if (isLatest()) recordPr(host, sessionId, pr);
  return pr;
}

/** Records a session's PR. When it has just merged, origin's base branch
 *  moved, so the project fetches it (X13). */
export function recordPr(host: string, sessionId: string, pr: PullRequest | null) {
  const key = sesKey(host, sessionId);
  const prev = get().prs[key];
  set((s) => ({ prs: { ...s.prs, [key]: pr } }));
  const w = get().sessions[host]?.find((x) => x.id === sessionId);
  if (w && pr && justMerged(prev, pr)) void refreshBase(host, w.project_id, { fetch: true, reason: `after PR #${pr.number} merged` });
}

function patchBase(key: string, patch: Partial<BaseSync>) {
  set((s) => {
    const prev = s.base[key] ?? { status: null, pulling: false, fetchedAt: null, reason: null, fetchError: null };
    return { base: { ...s.base, [key]: { ...prev, ...patch } } };
  });
}

/** Reloads a project's base branch status; `fetch` updates origin first. */
export async function refreshBase(host: string, projectId: string, opts: { fetch?: boolean; reason?: string } = {}) {
  const p = get().projects[host]?.find((x) => x.id === projectId);
  if (!p) return;
  try {
    const status = await rpc<BaseStatus | null>(host, M.gitBaseStatus, { path: p.path, branch: p.base_branch, fetch: !!opts.fetch });
    const fetched = opts.fetch && !status?.fetch_error;
    patchBase(projKey(host, p.id), {
      status,
      ...(opts.fetch && { fetchError: status?.fetch_error ?? null }),
      ...(fetched && { fetchedAt: Date.now(), reason: opts.reason ?? null }),
    });
  } catch {
    /* the project folder is gone or the host disconnected */
  }
}

/** Looks up each project's GitHub owner avatar from its origin remote (X15). */
export async function refreshAvatars(host: string) {
  for (const p of get().projects[host] ?? []) {
    const url = await rpc<string | null>(host, M.gitOriginUrl, { path: p.path }).then(avatarUrl, () => null);
    set((s) => ({ avatars: { ...s.avatars, [projKey(host, p.id)]: url } }));
  }
}

export async function refreshAllBases(host: string, opts: { fetch?: boolean } = {}) {
  for (const p of get().projects[host] ?? []) await refreshBase(host, p.id, opts);
}

/** Fast-forwards the project's base branch to what was last fetched. */
export async function pullBase(host: string, projectId: string) {
  const p = get().projects[host]?.find((x) => x.id === projectId);
  if (!p) return;
  const key = projKey(host, p.id);
  patchBase(key, { pulling: true });
  try {
    toast(pullToast(p.base_branch, await rpc<BasePull>(host, M.gitPullBase, { path: p.path, branch: p.base_branch })));
  } catch (e) {
    errorToast(e);
  }
  // Refresh before clearing `pulling`, so the chip does not flash the old count.
  await refreshBase(host, p.id);
  patchBase(key, { pulling: false });
}

export async function refreshAllGit(host: string) {
  for (const w of get().sessions[host] ?? []) if (!w.archived) await refreshGit(host, w.id);
}

function updateBadge() {
  const count = Object.values(get().unread).filter((s) => s === "blocked" || s === "error").length;
  void getCurrentWindow()
    .setBadgeCount(count > 0 ? count : undefined)
    .catch(() => {});
}

export async function notify(title: string, body: string) {
  try {
    let ok = await isPermissionGranted();
    if (!ok) ok = (await requestPermission()) === "granted";
    if (ok) sendNotification({ title, body });
  } catch {
    /* notifications unavailable */
  }
}

function isVisible(host: string, session: number): boolean {
  const s = get();
  const info = s.terminals[host]?.[session];
  if (!info?.session_id || !s.selected) return false;
  if (s.selected.host !== host || s.selected.session !== info.session_id) return false;
  const layout = s.layouts[sesKey(host, info.session_id)];
  return !!layout && tabOf(layout, session)?.id === layout.active;
}

const doneBursts = new DoneBursts();

async function onAttention(host: string, a: Attention) {
  const s = get();
  const chatInView = !!s.terminals[host]?.[a.terminal]?.chat;
  // A structured agent shows the outcome and approvals inline; no floating card on top.
  if (a.session_id && s.selected?.host === host && s.selected.session === a.session_id && !chatInView) {
    const since = s.workingSince[termKey(host, a.terminal)];
    const info = s.terminals[host]?.[a.terminal];
    set({
      card: {
        host,
        terminal: a.terminal,
        session: a.session_id,
        agent: info?.agent ?? null,
        state: a.state,
        message: sanitize(a.message, 240),
        workedMs: since ? Date.now() - since : null,
        at: Date.now(),
      },
    });
    void refreshGit(host, a.session_id);
  }
  const focused = document.hasFocus();
  const visible = focused && isVisible(host, a.terminal);
  const burstKey = a.session_id ? sesKey(host, a.session_id) : termKey(host, a.terminal);
  const alert = doneBursts.alert(burstKey, { state: a.state, focused, visible, settings: s.settings, now: Date.now() });
  if (alert.unread) {
    set((st) => ({ unread: { ...st.unread, [termKey(host, a.terminal)]: a.state } }));
    updateBadge();
  }
  if (alert.sound) void hostsApi.playSound(alert.sound).catch(() => {});
  if (alert.banner) {
    const ws = a.session_id ? s.sessions[host]?.find((w) => w.id === a.session_id) : undefined;
    const verb = a.state === "blocked" ? "needs you" : a.state === "error" ? "failed" : "is done";
    const where = ws ? ws.name : sanitize(a.title, 60);
    const hostLabel = host === "local" ? "" : ` · ${host}`;
    set({ lastAttention: { host, session: a.terminal, at: Date.now() } });
    await notify(`${where} ${verb}${hostLabel}`, sanitize(a.message) || sanitize(a.title));
  }
}

/** An agent asks to read a terminal (X31). The modal opens when its session
 * is in view; otherwise the session needs the user like a blocked agent. */
async function onReadRequest(host: string, req: ReadRequest) {
  set((s) => ({ reads: { ...s.reads, [host]: [...(s.reads[host] ?? []).filter((r) => r.request_id !== req.request_id), req] } }));
  const s = get();
  const focused = document.hasFocus();
  const inView = focused && s.selected?.host === host && s.selected.session === req.session_id;
  const alert = alertFor({ state: "blocked", focused, visible: inView, settings: s.settings, now: Date.now() });
  if (alert.unread) {
    set((st) => ({ unread: { ...st.unread, [termKey(host, req.caller)]: "blocked" } }));
    updateBadge();
  }
  if (alert.sound) void hostsApi.playSound(alert.sound).catch(() => {});
  if (alert.banner) {
    const ws = s.sessions[host]?.find((w) => w.id === req.session_id);
    const hostLabel = host === "local" ? "" : ` · ${host}`;
    await notify(`${ws?.name ?? "A session"} needs you${hostLabel}`, `Wants to read terminal ${sanitize(req.title, 60)}`);
  }
}

function onReadDone(host: string, requestId: number) {
  const req = get().reads[host]?.find((r) => r.request_id === requestId);
  if (!req) return;
  set((s) => {
    const rest = (s.reads[host] ?? []).filter((r) => r.request_id !== requestId);
    const unread = { ...s.unread };
    const key = termKey(host, req.caller);
    if (unread[key] === "blocked" && !rest.some((r) => r.caller === req.caller)) delete unread[key];
    return { reads: { ...s.reads, [host]: rest }, unread };
  });
  updateBadge();
}

function upsertSession(host: string, info: TerminalInfo) {
  set((s) => {
    const prev = s.terminals[host]?.[info.id];
    const key = termKey(host, info.id);
    let workingSince = s.workingSince;
    if (info.agent_state === "working" && prev?.agent_state !== "working") workingSince = { ...workingSince, [key]: Date.now() };
    return { terminals: { ...s.terminals, [host]: { ...(s.terminals[host] ?? {}), [info.id]: info } }, workingSince };
  });
}

function handleEvent(e: DaemonEvent) {
  const { host, name, data } = e;
  switch (name) {
    case EV.terminalCreated:
    case EV.terminalUpdated:
    case EV.terminalExited: {
      const info = data as TerminalInfo;
      const isNew = !get().terminals[host]?.[info.id];
      upsertSession(host, info);
      if (info.session_id && isNew) {
        const w = get().sessions[host]?.find((x) => x.id === info.session_id);
        if (w) syncLayout(host, w);
      }
      break;
    }
    case EV.terminalRemoved: {
      const id = (data as { id: number }).id;
      const info = get().terminals[host]?.[id];
      set((s) => {
        const hs = { ...(s.terminals[host] ?? {}) };
        delete hs[id];
        const unread = { ...s.unread };
        delete unread[termKey(host, id)];
        return { terminals: { ...s.terminals, [host]: hs }, unread };
      });
      disposeEntry(host, id);
      forgetChat(host, id);
      if (info?.session_id) {
        const layout = getLayout(host, info.session_id);
        setLayout(host, info.session_id, removeSession(layout, id));
      }
      updateBadge();
      break;
    }
    case EV.attention:
      void onAttention(host, data as Attention);
      break;
    case EV.terminalResync:
      // The daemon detached us because output piled up: start from a snapshot.
      void findEntry(host, (data as { id: number }).id)?.attach().catch(() => {});
      break;
    case EV.chatItem: {
      const d = data as { id: number; item: ChatItem };
      onChatItem(host, d.id, d.item);
      break;
    }
    case EV.chatState: {
      const d = data as { id: number; state: ChatState };
      onChatState(host, d.id, d.state);
      break;
    }
    case EV.projectsChanged:
      set((s) => ({ projects: { ...s.projects, [host]: data as Project[] } }));
      // A new project, or a new base branch from Project settings.
      void refreshAllBases(host, { fetch: true });
      void refreshAvatars(host);
      break;
    case EV.workspacesChanged:
      set((s) => ({ workspaces: { ...s.workspaces, [host]: data as Workspace[] } }));
      break;
    case EV.sectionsChanged:
      set((s) => ({ sections: { ...s.sections, [host]: data as Section[] } }));
      break;
    case EV.claudeUpdateOutput:
      if (host === LOCAL) set((s) => ({ claudeUpdate: afterClaudeUpdateLine(s.claudeUpdate, (data as { line: string }).line) }));
      break;
    case EV.claudeUpdateDone:
      if (host === LOCAL) void finishClaudeUpdate(data as { ok: boolean; output: string });
      break;
    case EV.profilesChanged:
      // The full list, as profile.list returns it (X33).
      set((s) => ({ profiles: { ...s.profiles, [host]: data as ProfileInfo[] } }));
      break;
    case EV.sessionsChanged: {
      const list = data as Session[];
      const notices = spawnedNotices(get().sessions[host], list, get().projects[host] ?? []);
      set((s) => ({ sessions: { ...s.sessions, [host]: list } }));
      // An agent opened a session (X22): say so, and leave the user where they are.
      for (const n of notices) toast(n.text, "info", { label: "Go to", run: () => selectSession(host, n.session) });
      for (const w of list) if (!w.archived) syncLayout(host, w);
      break;
    }
    case EV.terminalReadRequest:
      void onReadRequest(host, data as ReadRequest);
      break;
    case EV.terminalReadDone:
      onReadDone(host, (data as { request_id: number }).request_id);
      break;
    case EV.terminalReadGrant: {
      const g = data as { session_id: string; granted: boolean };
      set((s) => {
        const rest = (s.readGrants[host] ?? []).filter((x) => x !== g.session_id);
        return { readGrants: { ...s.readGrants, [host]: g.granted ? [...rest, g.session_id] : rest } };
      });
      break;
    }
    case EV.fsChanged: {
      const ch = data as FsChanged;
      set((s) => ({ fsVersion: { ...s.fsVersion, [`${host}|${ch.root}`]: (s.fsVersion[`${host}|${ch.root}`] ?? 0) + 1 } }));
      for (const w of get().sessions[host] ?? []) {
        if (ch.root === w.path || ch.root.startsWith(w.path + "/") || w.path.startsWith(ch.root.replace(/\/$/, "") + "/")) scheduleGit(host, w.id);
      }
      break;
    }
  }
}

const gitTimers: Record<string, number> = {};
function scheduleGit(host: string, id: string) {
  const key = sesKey(host, id);
  window.clearTimeout(gitTimers[key]);
  gitTimers[key] = window.setTimeout(() => void refreshGit(host, id), 400);
}

// Set on every module load, so a hot-reloaded module's handler takes over
// while the one registered listener stays.
g.__moonletOnEvent = handleEvent;

export async function startStore() {
  if (g.__moonletStarted) return;
  g.__moonletStarted = true;
  setTermSettings(get().settings.term);
  await onDaemonEvent((e) => g.__moonletOnEvent?.(e));
  await onHostStatus((h) => {
    const prev = get().hosts[h.id];
    set((s) => ({ hosts: { ...s.hosts, [h.id]: h } }));
    if (h.status === "connected" && prev?.status !== "connected") void loadHost(h.id);
  });
  const hosts = await hostsApi.list();
  set({ hosts: Object.fromEntries(hosts.map((h) => [h.id, h])) });
  for (const h of hosts) if (h.status === "connected") void loadHost(h.id);

  void hostsApi.appInfo().then(({ version }) => set({ appVersion: version }), () => {});
  scheduleUpdateChecks(
    () => {
      void checkForUpdates();
      void checkClaudeVersion();
    },
    () => get().settings.autoUpdateCheck,
  );

  // Tauri cannot tell a notification click from any other activation, so
  // coming back soon after one offers the jump instead of doing it (A3).
  const prsDue = focusThrottle(15_000);
  window.addEventListener("focus", () => {
    if (prsDue(Date.now())) for (const h of Object.keys(get().sessions)) void refreshPrs(h);
    const la = get().lastAttention;
    if (la && Date.now() - la.at < 120_000) {
      set({ lastAttention: null });
      const info = get().terminals[la.host]?.[la.session];
      const ws = info?.session_id ? get().sessions[la.host]?.find((w) => w.id === info.session_id) : undefined;
      toast(`${ws?.name ?? info?.title ?? "An agent"} needs attention`, "info", { label: "Go to", run: () => focusTerminal(la.host, la.session) });
    }
  });
  setInterval(() => {
    for (const h of Object.keys(get().sessions)) void refreshPrs(h);
    for (const h of Object.keys(get().projects)) void refreshAllBases(h, { fetch: true });
  }, 300_000);
  setInterval(() => {
    for (const h of Object.keys(get().sessions)) void refreshPrs(h, { openOnly: true });
  }, 60_000);
  // Diffstats for background sessions.
  setInterval(() => {
    for (const h of Object.keys(get().sessions)) void refreshAllGit(h);
  }, 20_000);
}

export function updateSettings(patch: Partial<Settings>) {
  set((s) => ({ settings: { ...s.settings, ...patch } }));
}
