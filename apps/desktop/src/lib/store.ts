// App state. Daemons own the truth (sessions, repos, workspaces); this store
// mirrors it per host from RPCs and events, plus UI-only state.

import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { hostsApi, onDaemonEvent, onHostStatus, rpc, subscribeHost, type DaemonEvent } from "./daemon";
import { type Layout, emptyLayout, parseLayout, reconcile, removeSession, tabOf } from "./layout";
import {
  type AgentState,
  type Attention,
  EV,
  type FsChanged,
  type GitStatus,
  type HostInfo,
  M,
  type Repo,
  type SessionInfo,
  type Workspace,
} from "./protocol";
import { sanitize } from "./sanitize";
import { disposeEntry, reattachHost, setTermSettings, type TermSettings, defaultTermSettings } from "./terminals";

export type RightTab = "files" | "changes" | "review";

export interface Selection {
  host: string;
  workspace: string;
}

export interface OpenFile {
  host: string;
  path: string;
  line?: number;
}

export interface Settings {
  term: TermSettings;
  notifyWhenFocused: boolean;
}

export const wsKey = (host: string, id: string) => `${host}/${id}`;
export const sessKey = (host: string, id: number) => `${host}:${id}`;

const SETTINGS_KEY = "jaunt.settings";
const UI_KEY = "jaunt.ui";

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    const v = raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
    // Defaults from older versions (wider review panel).
    if (v && typeof v === "object" && (v as { rightWidth?: number }).rightWidth === 520) (v as { rightWidth: number }).rightWidth = 380;
    if (v && typeof v === "object" && (v as { sidebarWidth?: number }).sidebarWidth === 264) (v as { sidebarWidth: number }).sidebarWidth = 280;
    // Tabs from older versions.
    if (v && typeof v === "object" && "rightTab" in v && !["files", "changes", "review"].includes((v as { rightTab: string }).rightTab)) {
      (v as { rightTab: string }).rightTab = "files";
    }
    return v;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
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
  session: number;
  workspace: string;
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
}

interface State extends UiPersist {
  hosts: Record<string, HostInfo>;
  repos: Record<string, Repo[]>;
  workspaces: Record<string, Workspace[]>;
  sessions: Record<string, Record<number, SessionInfo>>;
  layouts: Record<string, Layout>;
  git: Record<string, GitStatus | undefined>;
  /** Sessions that need attention and have not been looked at. */
  unread: Record<string, AgentState>;
  fsVersion: Record<string, number>;
  openFile: OpenFile | null;
  preview: OpenFile | null;
  showHistory: boolean;
  dialog: null | { kind: "new-workspace"; host?: string; repo?: string } | { kind: "add-repo" } | { kind: "create-pr" } | { kind: "settings" } | { kind: "palette" } | { kind: "commit" };
  settings: Settings;
  toasts: Toast[];
  lastAttention: { host: string; session: number; at: number } | null;
  /** When each agent session last started working (for "worked for 7s"). */
  workingSince: Record<string, number>;
  card: AgentCard | null;
  /** File shown in the Changes diff (set from the Files list). */
  diffFile: string | null;
}

export const useStore = create<State>(() => ({
  ...loadJson(UI_KEY, uiDefaults),
  hosts: {},
  repos: {},
  workspaces: {},
  sessions: {},
  layouts: {},
  git: {},
  unread: {},
  fsVersion: {},
  openFile: null,
  preview: null,
  showHistory: false,
  dialog: null,
  settings: loadJson<Settings>(SETTINGS_KEY, { term: defaultTermSettings, notifyWhenFocused: false }),
  toasts: [],
  lastAttention: null,
  workingSince: {},
  card: null,
  diffFile: null,
}));

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
export function toast(text: string, kind: Toast["kind"] = "info") {
  const id = ++toastId;
  set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === "error" ? 7000 : 3500);
}

export function errorToast(e: unknown) {
  toast(e instanceof Error ? e.message : String(e), "error");
}

// ---------------------------------------------------------------- selectors

export function selectedWorkspace(s: State = get()): Workspace | undefined {
  if (!s.selected) return undefined;
  return s.workspaces[s.selected.host]?.find((w) => w.id === s.selected!.workspace);
}

export function workspaceSessions(s: State, host: string, wsId: string): SessionInfo[] {
  return Object.values(s.sessions[host] ?? {})
    .filter((x) => x.workspace_id === wsId)
    .sort((a, b) => a.id - b.id);
}

const RANK: Record<AgentState, number> = { blocked: 5, error: 4, working: 3, done: 2, idle: 1 };

/** The most urgent agent state among a workspace's sessions. */
export function workspaceState(s: State, host: string, wsId: string): AgentState | null {
  let best: AgentState | null = null;
  for (const x of workspaceSessions(s, host, wsId)) {
    if (x.kind !== "agent") continue;
    if (!best || RANK[x.agent_state] > RANK[best]) best = x.agent_state;
  }
  return best;
}

export function repoOf(s: State, host: string, ws: Workspace): Repo | undefined {
  return s.repos[host]?.find((r) => r.id === ws.repo_id);
}

// ------------------------------------------------------------------ actions

/**
 * Loads a host's repos, workspaces and sessions. The output channel and the
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
    const [repos, workspaces, sessions] = await Promise.all([
      rpc<Repo[]>(host, M.repoList),
      rpc<Workspace[]>(host, M.wsList),
      rpc<SessionInfo[]>(host, M.sessionList),
    ]);
    set((s) => ({
      repos: { ...s.repos, [host]: repos },
      workspaces: { ...s.workspaces, [host]: workspaces },
      sessions: { ...s.sessions, [host]: Object.fromEntries(sessions.map((x) => [x.id, x])) },
    }));
    for (const w of workspaces) syncLayout(host, w);
    reattachHost(host);
    void refreshAllGit(host);
  } catch (e) {
    console.warn(`loading ${host} failed (attempt ${attempt + 1})`, e);
    if (attempt < 8 && get().hosts[host]?.status === "connected") {
      setTimeout(() => void loadHost(host, attempt + 1), Math.min(500 * 2 ** attempt, 8000));
    }
  }
}

export function syncLayout(host: string, w: Workspace) {
  const key = wsKey(host, w.id);
  const s = get();
  const live = workspaceSessions(s, host, w.id).map((x) => x.id);
  const base = s.layouts[key] ?? parseLayout(w.layout);
  const next = reconcile(base, live);
  if (JSON.stringify(next) !== JSON.stringify(s.layouts[key])) {
    set((st) => ({ layouts: { ...st.layouts, [key]: next } }));
    persistLayout(host, w.id, next);
  }
}

const layoutTimers: Record<string, number> = {};
function persistLayout(host: string, id: string, layout: Layout) {
  const key = wsKey(host, id);
  window.clearTimeout(layoutTimers[key]);
  layoutTimers[key] = window.setTimeout(() => {
    void rpc(host, M.wsUpdate, { id, layout }).catch(() => {});
  }, 600);
}

export function setLayout(host: string, id: string, layout: Layout) {
  set((s) => ({ layouts: { ...s.layouts, [wsKey(host, id)]: layout } }));
  persistLayout(host, id, layout);
}

export function getLayout(host: string, id: string): Layout {
  return get().layouts[wsKey(host, id)] ?? emptyLayout();
}

export function focusSession(host: string, session: number) {
  const info = get().sessions[host]?.[session];
  if (!info?.workspace_id) return;
  const ws = info.workspace_id;
  const layout = getLayout(host, ws);
  const tab = tabOf(layout, session);
  set((s) => {
    const unread = { ...s.unread };
    delete unread[sessKey(host, session)];
    return { selected: { host, workspace: ws }, unread, showHistory: false };
  });
  if (tab) setLayout(host, ws, { ...layout, active: tab.id, focused: session });
  updateBadge();
}

export function selectWorkspace(host: string, id: string) {
  set({ selected: { host, workspace: id }, diffFile: null, preview: null });
  const layout = getLayout(host, id);
  if (layout.focused !== null) {
    set((s) => {
      const unread = { ...s.unread };
      delete unread[sessKey(host, layout.focused!)];
      return { unread };
    });
  }
  updateBadge();
  void refreshGit(host, id);
}

const gitInflight: Record<string, boolean> = {};
export async function refreshGit(host: string, id: string) {
  const key = wsKey(host, id);
  const w = get().workspaces[host]?.find((x) => x.id === id);
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

export async function refreshAllGit(host: string) {
  for (const w of get().workspaces[host] ?? []) if (!w.archived) await refreshGit(host, w.id);
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
  const info = s.sessions[host]?.[session];
  if (!info?.workspace_id || !s.selected) return false;
  if (s.selected.host !== host || s.selected.workspace !== info.workspace_id) return false;
  const layout = s.layouts[wsKey(host, info.workspace_id)];
  return !!layout && tabOf(layout, session)?.id === layout.active;
}

async function onAttention(host: string, a: Attention) {
  const s = get();
  if (a.workspace_id && s.selected?.host === host && s.selected.workspace === a.workspace_id) {
    const since = s.workingSince[sessKey(host, a.session)];
    const info = s.sessions[host]?.[a.session];
    set({
      card: {
        host,
        session: a.session,
        workspace: a.workspace_id,
        agent: info?.agent ?? null,
        state: a.state,
        message: sanitize(a.message, 240),
        workedMs: since ? Date.now() - since : null,
        at: Date.now(),
      },
    });
    void refreshGit(host, a.workspace_id);
  }
  const focused = document.hasFocus();
  const visible = focused && isVisible(host, a.session);
  if (!visible) {
    set((st) => ({ unread: { ...st.unread, [sessKey(host, a.session)]: a.state } }));
    updateBadge();
  }
  if (!focused || (s.settings.notifyWhenFocused && !visible)) {
    const ws = a.workspace_id ? s.workspaces[host]?.find((w) => w.id === a.workspace_id) : undefined;
    const verb = a.state === "blocked" ? "needs you" : a.state === "error" ? "failed" : "is done";
    const where = ws ? ws.name : sanitize(a.title, 60);
    const hostLabel = host === "local" ? "" : ` · ${host}`;
    set({ lastAttention: { host, session: a.session, at: Date.now() } });
    await notify(`${where} ${verb}${hostLabel}`, sanitize(a.message) || sanitize(a.title));
  }
}

function upsertSession(host: string, info: SessionInfo) {
  set((s) => {
    const prev = s.sessions[host]?.[info.id];
    const key = sessKey(host, info.id);
    let workingSince = s.workingSince;
    if (info.agent_state === "working" && prev?.agent_state !== "working") workingSince = { ...workingSince, [key]: Date.now() };
    return { sessions: { ...s.sessions, [host]: { ...(s.sessions[host] ?? {}), [info.id]: info } }, workingSince };
  });
}

function handleEvent(e: DaemonEvent) {
  const { host, name, data } = e;
  switch (name) {
    case EV.sessionCreated:
    case EV.sessionUpdated:
    case EV.sessionExited: {
      const info = data as SessionInfo;
      const isNew = !get().sessions[host]?.[info.id];
      upsertSession(host, info);
      if (info.workspace_id && isNew) {
        const w = get().workspaces[host]?.find((x) => x.id === info.workspace_id);
        if (w) syncLayout(host, w);
      }
      break;
    }
    case EV.sessionRemoved: {
      const id = (data as { id: number }).id;
      const info = get().sessions[host]?.[id];
      set((s) => {
        const hs = { ...(s.sessions[host] ?? {}) };
        delete hs[id];
        const unread = { ...s.unread };
        delete unread[sessKey(host, id)];
        return { sessions: { ...s.sessions, [host]: hs }, unread };
      });
      disposeEntry(host, id);
      if (info?.workspace_id) {
        const layout = getLayout(host, info.workspace_id);
        setLayout(host, info.workspace_id, removeSession(layout, id));
      }
      updateBadge();
      break;
    }
    case EV.attention:
      void onAttention(host, data as Attention);
      break;
    case EV.reposChanged:
      set((s) => ({ repos: { ...s.repos, [host]: data as Repo[] } }));
      break;
    case EV.workspacesChanged: {
      const list = data as Workspace[];
      set((s) => ({ workspaces: { ...s.workspaces, [host]: list } }));
      for (const w of list) if (!w.archived) syncLayout(host, w);
      break;
    }
    case EV.fsChanged: {
      const ch = data as FsChanged;
      set((s) => ({ fsVersion: { ...s.fsVersion, [`${host}|${ch.root}`]: (s.fsVersion[`${host}|${ch.root}`] ?? 0) + 1 } }));
      for (const w of get().workspaces[host] ?? []) {
        if (ch.root === w.path || ch.root.startsWith(w.path + "/") || w.path.startsWith(ch.root)) scheduleGit(host, w.id);
      }
      break;
    }
  }
}

const gitTimers: Record<string, number> = {};
function scheduleGit(host: string, id: string) {
  const key = wsKey(host, id);
  window.clearTimeout(gitTimers[key]);
  gitTimers[key] = window.setTimeout(() => void refreshGit(host, id), 400);
}

let started = false;
export async function startStore() {
  if (started) return;
  started = true;
  setTermSettings(get().settings.term);
  await onDaemonEvent(handleEvent);
  await onHostStatus((h) => {
    const prev = get().hosts[h.id];
    set((s) => ({ hosts: { ...s.hosts, [h.id]: h } }));
    if (h.status === "connected" && prev?.status !== "connected") void loadHost(h.id);
  });
  const hosts = await hostsApi.list();
  set({ hosts: Object.fromEntries(hosts.map((h) => [h.id, h])) });
  for (const h of hosts) if (h.status === "connected") void loadHost(h.id);

  // Clicking a notification activates the app; jump to that agent (A3).
  window.addEventListener("focus", () => {
    const la = get().lastAttention;
    if (la && Date.now() - la.at < 120_000) {
      set({ lastAttention: null });
      focusSession(la.host, la.session);
    }
  });
  // Diffstats for background workspaces.
  setInterval(() => {
    for (const h of Object.keys(get().workspaces)) void refreshAllGit(h);
  }, 20_000);
}

export function updateSettings(patch: Partial<Settings>) {
  set((s) => ({ settings: { ...s.settings, ...patch } }));
}
