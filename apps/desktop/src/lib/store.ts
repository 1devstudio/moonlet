// App state. Daemons own the truth (projects, sessions, terminals); this store
// mirrors it per host from RPCs and events, plus UI-only state.

import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
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
  type Workspace,
} from "./protocol";
import { sanitize } from "./sanitize";
import { DEFAULT_MODE } from "./agents";
import { DEFAULT_SOUNDS, soundFor, type SoundSettings } from "./sounds";
import { type ToolCallView, forgetChat, loadChat, onChatItem, onChatState } from "./chat";
import { justMerged, pullToast, type FetchInfo } from "./baseSync";
import { avatarUrl } from "./projectAvatar";
import type { Archiving } from "./archiveLoader";
import type { PendingConfirm } from "./confirm";
import { spawnedNotices } from "./spawned";
import { focusThrottle, latestPerKey, needsPrPoll } from "./prPoll";
import type { ChatItem, ChatState } from "./protocol";
import type { Shortcuts } from "./runActions";
import { readStored, writeStored } from "./storage";
import { disposeEntry, findEntry, reattachHost, setTermSettings, type TermSettings, defaultTermSettings } from "./terminals";

/** Right panel tabs, in order (X24 added Plan). */
export const RIGHT_TABS = ["plan", "files", "changes", "review"] as const;
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
  /** Runs of tool calls folded into one row, or one row per call (X14). */
  toolCalls: ToolCallView;
  /** Custom keyboard shortcuts from the Run action modal (X19). */
  shortcuts: Shortcuts;
  /** Mode an approved plan switches to, `auto` or `acceptEdits` (X24). */
  planApproveMode: string;
  /** Shiki theme of the editor and diffs (X26). */
  editorTheme: string;
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
}

const uiDefaults: UiPersist = {
  selected: null,
  sidebarWidth: 280,
  rightWidth: 380,
  rightOpen: true,
  sidebarOpen: true,
  rightTab: "files",
  collapsed: {},
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
  /** Workspaces (sets of projects) per host. */
  workspaces: Record<string, Workspace[]>;
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
    | { kind: "new-session"; host?: string; project?: string; workspace?: string }
    | { kind: "add-project"; host?: string; workspace?: string }
    | { kind: "new-workspace" }
    | { kind: "create-pr" }
    | { kind: "settings" }
    | { kind: "project-settings"; host: string; project: string; focus?: "run" }
    | { kind: "palette" }
    | { kind: "commit" };
  /** The open confirm modal, above any dialog (X23). */
  confirm: PendingConfirm | null;
  settings: Settings;
  toasts: Toast[];
  lastAttention: { host: string; session: number; at: number } | null;
  /** When each agent session last started working (for "worked for 7s"). */
  workingSince: Record<string, number>;
  card: AgentCard | null;
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
  settings: loadJson<Settings>(SETTINGS_KEY, { term: defaultTermSettings, notifyWhenFocused: false, defaultMode: DEFAULT_MODE, sounds: DEFAULT_SOUNDS, toolCalls: "collapsed", shortcuts: {}, planApproveMode: "auto", editorTheme: "dark-plus" }),
  toasts: [],
  lastAttention: null,
  workingSince: {},
  card: null,
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
    s.collapsed !== prev.collapsed
  ) {
    const { selected, sidebarWidth, rightWidth, rightOpen, sidebarOpen, rightTab, collapsed } = s;
    saveJson(UI_KEY, { selected, sidebarWidth, rightWidth, rightOpen, sidebarOpen, rightTab, collapsed });
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
    const [workspaces, projects, sessions, terminals] = await Promise.all([
      rpc<Workspace[]>(host, M.workspaceList),
      rpc<Project[]>(host, M.projectList),
      rpc<Session[]>(host, M.sessionList),
      rpc<TerminalInfo[]>(host, M.terminalList),
    ]);
    set((s) => ({
      workspaces: { ...s.workspaces, [host]: workspaces },
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

export function focusTerminal(host: string, session: number) {
  const info = get().terminals[host]?.[session];
  if (!info?.session_id) return;
  const ws = info.session_id;
  const layout = getLayout(host, ws);
  const tab = tabOf(layout, session);
  set((s) => {
    const unread = { ...s.unread };
    delete unread[termKey(host, session)];
    return { selected: { host, session: ws }, unread, showHistory: false };
  });
  if (tab) setLayout(host, ws, { ...layout, active: tab.id, focused: session });
  updateBadge();
}

export function selectSession(host: string, id: string) {
  set({ selected: { host, session: id }, diffFile: null });
  const layout = getLayout(host, id);
  if (layout.focused !== null) {
    set((s) => {
      const unread = { ...s.unread };
      delete unread[termKey(host, layout.focused!)];
      return { unread };
    });
  }
  updateBadge();
  void refreshGit(host, id);
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

async function notify(title: string, body: string) {
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
  if (!visible) {
    set((st) => ({ unread: { ...st.unread, [termKey(host, a.terminal)]: a.state } }));
    updateBadge();
    const sound = soundFor(s.settings.sounds, a.state);
    if (sound) void hostsApi.playSound(sound).catch(() => {});
  }
  if (!focused || (s.settings.notifyWhenFocused && !visible)) {
    const ws = a.session_id ? s.sessions[host]?.find((w) => w.id === a.session_id) : undefined;
    const verb = a.state === "blocked" ? "needs you" : a.state === "error" ? "failed" : "is done";
    const where = ws ? ws.name : sanitize(a.title, 60);
    const hostLabel = host === "local" ? "" : ` · ${host}`;
    set({ lastAttention: { host, session: a.terminal, at: Date.now() } });
    await notify(`${where} ${verb}${hostLabel}`, sanitize(a.message) || sanitize(a.title));
  }
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
    case EV.sessionsChanged: {
      const list = data as Session[];
      const notices = spawnedNotices(get().sessions[host], list, get().projects[host] ?? []);
      set((s) => ({ sessions: { ...s.sessions, [host]: list } }));
      // An agent opened a session (X22): say so, and leave the user where they are.
      for (const n of notices) toast(n.text, "info", { label: "Go to", run: () => selectSession(host, n.session) });
      for (const w of list) if (!w.archived) syncLayout(host, w);
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
