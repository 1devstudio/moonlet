// The phone app's state (X40): the hosts it reaches, what each daemon
// reports, the screen shown, and settings kept on the phone. Daemon data is
// loaded when a host connects and kept current by its events.

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { onDaemonEvent, onHostStatus, rpc, subscribeHost, type DaemonEvent } from "@desktop/lib/daemon";
import { onChatItem, onChatState } from "@desktop/lib/chat";
import { startJobs } from "@desktop/lib/jobsStore";
import {
  EV,
  M,
  type AccountInfo,
  type ChatState,
  type Copy,
  type ExecSetup,
  type GitSettings,
  type HostInfo,
  type Project,
  type ReadRequest,
  type Section,
  type Session,
  type TerminalInfo,
  type Workspace,
} from "@desktop/lib/protocol";
import { readStored, writeStored } from "@desktop/lib/storage";
import type { WorkspaceRef } from "@desktop/lib/workspaces";
import type { TaskSnapshot } from "@desktop/lib/taskSnapshot";
import type { HostSeen } from "./hosts";
import { hostWorkspaces, shownWorkspace } from "./workspaceChoices";
import { withSetupCommand } from "./setups";
import { type Change, accountAfterError, applyChanges, eventChanges, gitAfterError } from "./events";
import { parseCopyHost } from "@desktop/lib/copyHost";
import { copyData } from "./copies";

/** A host as the phone's core lists it (`host_list`). */
export interface HostEntry extends HostInfo {
  /** The paired Mac it is reached through (itself for a Mac). */
  mac: string;
  /** The Mac's name, for an SSH host routed through it. */
  via: string | null;
}

/** A chat's state without its items (`chat.summaries`). */
export type ChatSummary = Omit<ChatState, "items">;

export interface HostData {
  terminals: Record<number, TerminalInfo>;
  sessions: Session[];
  projects: Project[];
  /** The account the host shares (X68), from `account.get`; none from a daemon before X68. */
  account?: string;
  workspaces: Workspace[];
  sections: Section[];
  reads: ReadRequest[];
  chats: Record<number, ChatSummary>;
  /** The host's Git settings (X55); null until loaded, or from a daemon too old to have them. */
  git: GitSettings | null;
  /** Its live copies of sessions on its central host (X60). */
  copies: Copy[];
  /** Its routing copies whose setup waits for approval (X62). */
  setups: ExecSetup[];
  /** Each workspace's boards, as the app on the Mac shared them (X76). */
  tasks: Record<string, TaskSnapshot>;
  /** Whether moonlet is open on this Mac to act on tasks (X76); moves wait while not. */
  macOpen: boolean;
}

export const emptyData = (): HostData => ({ terminals: {}, sessions: [], projects: [], workspaces: [], sections: [], reads: [], chats: {}, git: null, copies: [], setups: [], tasks: {}, macOpen: false });

export type Tab = "inbox" | "sessions" | "tasks" | "new" | "hosts";
export type SessionTab = "chat" | "terminal" | "changes" | "pr" | "jobs";

/** A screen over the tabs. */
export type Screen =
  | { kind: "pair" }
  /** "Paired with <Mac>", right after pairing (X39). */
  | { kind: "paired"; name: string }
  | { kind: "session"; host: string; id: string; tab: SessionTab }
  /** An agent without a session, such as a design's (X65), by its chat terminal. */
  | { kind: "agent"; host: string; terminal: number }
  | { kind: "diff"; host: string; id: string; path: string; against: "base" | "head" }
  | { kind: "plan"; host: string; terminal: number; ask: string; from?: Screen }
  /** A task on a board (X76): the board's key (`PhoneBoard.key`) and the task's `connection key`; `from`, the screen it was opened from. */
  | { kind: "task"; board: string; task: string; created?: boolean; from?: Screen };

export type NotifyKey = "blocked" | "done" | "error" | "checks";

export interface Settings {
  /** The workspace shown in Inbox and Sessions, by its account and id
   * (X68); a name kept before X68; null for all workspaces. */
  workspace: WorkspaceRef | string | null;
  /** "Notify me when" switches that are off. */
  notifyOff: NotifyKey[];
  /** Face ID before Allow and plan approvals. */
  faceId: boolean;
  /** The board the Tasks tab shows, by its `PhoneBoard.key` (X76). */
  board?: string | null;
  /** The column shown on each board, by its key. */
  columns?: Record<string, string>;
  /** Boards shown with Assignee: me, by key (X76). */
  mine?: Record<string, boolean>;
  /** Out-of-sync chips put off with Not now, by the desktop's `driftKey` (X76). */
  notNow?: Record<string, true>;
}

const SETTINGS = "mobile.settings";
const SEEN = "mobile.seen";

function loadJson<T>(name: string, fallback: T): T {
  try {
    const v = readStored(name);
    return v ? { ...fallback, ...JSON.parse(v) } : fallback;
  } catch {
    return fallback;
  }
}

interface AppState {
  hosts: Record<string, HostEntry>;
  seen: Record<string, HostSeen>;
  data: Record<string, HostData>;
  tab: Tab;
  screen: Screen | null;
  settings: Settings;
  /** False until `host_list` answered: tells "no Mac paired" from "not loaded". */
  ready: boolean;
  /** The task, and maybe its worktree, New session starts from (X76). */
  newFrom: { board: string; task: string; worktree?: { path: string; branch: string; project?: string } } | null;
}

export const useApp = create<AppState>(() => ({
  hosts: {},
  seen: loadJson<Record<string, HostSeen>>(SEEN, {}),
  data: {},
  tab: "inbox",
  screen: null,
  newFrom: null,
  settings: loadJson<Settings>(SETTINGS, { workspace: null, notifyOff: ["checks"], faceId: true }),
  ready: false,
}));

const set = useApp.setState;
const get = useApp.getState;

export function updateSettings(patch: Partial<Settings>) {
  const settings = { ...get().settings, ...patch };
  set({ settings });
  writeStored(SETTINGS, JSON.stringify(settings));
}

/** The workspace Inbox, Sessions and New session show; null for all. */
export function useShownWorkspace(): WorkspaceRef | null {
  const hosts = useApp((s) => s.hosts);
  const data = useApp((s) => s.data);
  const kept = useApp((s) => s.settings.workspace);
  return shownWorkspace(kept, hostWorkspaces(hosts, data));
}

/** A task's Back: to the screen it was opened from, such as a session, else to the tab under it (X76). */
export function taskBack() {
  const s = get().screen;
  set({ screen: s?.kind === "task" ? (s.from ?? null) : null });
}

export const showTab = (tab: Tab) => set({ tab, screen: null, ...(tab !== "new" && { newFrom: null }) });

/** New session, started from a task on a board (X76), in its worktree without a session if given. */
export const startFromTask = (from: NonNullable<AppState["newFrom"]>) => set({ tab: "new", screen: null, newFrom: from });
export const showScreen = (screen: Screen | null) => {
  set({ screen });
  // A session another member owns opens under its copy host (X72).
  if (screen && "host" in screen && parseCopyHost(screen.host)) void loadCopy(screen.host).catch(() => {});
};

/** Loads what copy host `id` shows (X72): the session's terminals and chats,
 * through the central host. */
export async function loadCopy(id: string) {
  const copy = parseCopyHost(id);
  const central = copy && useApp.getState().data[copy.host];
  if (!copy || !central) return;
  const [terminals, chats] = await Promise.all([
    rpc<TerminalInfo[]>(id, M.terminalList).catch(() => []),
    rpc<{ id: number; state: ChatSummary }[]>(id, M.chatSummaries).catch(() => []),
  ]);
  const d = copyData(useApp.getState().data[copy.host] ?? central, copy.session, terminals, chats);
  if (d) patchData(id, d);
}

function patchData(host: string, patch: Partial<HostData> | ((d: HostData) => Partial<HostData>)) {
  set((s) => {
    const cur = s.data[host] ?? emptyData();
    return { data: { ...s.data, [host]: { ...cur, ...(typeof patch === "function" ? patch(cur) : patch) } } };
  });
}

/** Per host, a number that moves on whenever its setups change here, so a
 * re-read that overlapped a change does not undo it. */
const setupTurns = new Map<string, number>();
const nextSetupTurn = (host: string) => setupTurns.set(host, (setupTurns.get(host) ?? 0) + 1);

/** Drops a routing copy's setup answered from the phone (X62): the daemon
 * says nothing more of it. */
export function dropSetup(host: string, copy: string) {
  nextSetupTurn(host);
  patchData(host, (d) => applyChanges(d, [{ kind: "setup", copy, value: null }]));
}

/** Asks about the command the Mac now has for `copy` (X60, X62). */
export function changeSetupCommand(host: string, copy: string, command: string) {
  nextSetupTurn(host);
  patchData(host, (d) => withSetupCommand(d, copy, command));
}

/** Re-reads the routing copies waiting for setup (X62), which the Mac may
 * have answered without an event. */
export async function refreshSetups(host: string) {
  const turn = setupTurns.get(host);
  const setups = await rpc<ExecSetup[]>(host, M.execSetups).catch(() => null);
  if (setups && setupTurns.get(host) === turn) patchData(host, { setups });
}

function patchSeen(host: string, patch: Partial<HostSeen>) {
  set((s) => {
    const prev: HostSeen = s.seen[host] ?? { latencyMs: null, lastSeen: null };
    const seen = { ...s.seen, [host]: { ...prev, ...patch } };
    writeStored(SEEN, JSON.stringify(seen));
    return { seen };
  });
}

/** Times a `daemon.info` round trip. */
export async function measure(host: string) {
  const t0 = performance.now();
  try {
    await rpc(host, M.daemonInfo);
    patchSeen(host, { latencyMs: performance.now() - t0, lastSeen: Date.now() });
  } catch {
    /* offline */
  }
}

/** Per host, the changes events made while a load runs. */
const loads = new Map<string, Change[]>();

/** Loads everything a connected host's screens show. */
export async function loadHost(host: string) {
  const during: Change[] = [];
  loads.set(host, during);
  try {
    const fetched = await fetchHostData(host);
    // A newer load started meanwhile: its replies are newer than these.
    if (loads.get(host) !== during) return;
    // What events changed meanwhile wins over the replies they overtook.
    const kept = (cur: HostData) => ({ git: fetched.git === undefined ? cur.git : fetched.git, account: fetched.account === "keep" ? cur.account : (fetched.account ?? undefined) });
    patchData(host, (cur) => applyChanges({ ...fetched, ...kept(cur) }, during));
  } finally {
    if (loads.get(host) === during) loads.delete(host);
  }
}

/** The host's data; `git` left out and `account` "keep" when their replies
 * failed, so what was already loaded stays. */
async function fetchHostData(host: string): Promise<Omit<HostData, "git" | "account"> & { git?: HostData["git"]; account: string | null | "keep" }> {
  const call = <T>(method: string, params: object = {}) => rpc<T>(host, method, params);
  const [terminals, sessions, projects, workspaces, sections, reads, chats, git, account, copies, setups, tasks, macOpen] = await Promise.all([
    call<TerminalInfo[]>(M.terminalList),
    // With the sessions other members own, from the central host (X72).
    call<Session[]>(M.sessionList, { copies: true }),
    call<Project[]>(M.projectList),
    call<Workspace[]>(M.workspaceList),
    call<Section[]>(M.sectionList),
    call<ReadRequest[]>(M.terminalReadRequests).catch(() => []),
    call<{ id: number; state: ChatSummary }[]>(M.chatSummaries).catch(() => []),
    call<GitSettings>(M.gitSettings).catch(gitAfterError),
    call<AccountInfo>(M.accountGet).then((a) => a.account, accountAfterError),
    // A daemon before X60, or X62, or one that refuses a phone, has none to show.
    call<Copy[]>(M.syncList).catch(() => []),
    call<ExecSetup[]>(M.execSetups).catch(() => []),
    call<{ workspace: string; snapshot: TaskSnapshot }[]>(M.tasksSnapshot).catch(() => []),
    call<{ open: boolean }>(M.tasksApp).then((a) => a.open, () => false),
  ]);
  return {
    terminals: Object.fromEntries(terminals.map((t) => [t.id, t])),
    sessions,
    projects,
    workspaces,
    sections,
    reads,
    chats: Object.fromEntries(chats.map((c) => [c.id, c.state])),
    ...(git !== "keep" && { git }),
    account,
    copies,
    setups,
    tasks: Object.fromEntries(tasks.map((t) => [t.workspace, t.snapshot])),
    macOpen,
  };
}

function onEvent(e: DaemonEvent) {
  const { host, name, data } = e;
  const changes = eventChanges(name, data);
  if (name === EV.execSetup) nextSetupTurn(host);
  if (changes === "reload") {
    void loadHost(host).catch(() => {});
  } else if (changes.length) {
    loads.get(host)?.push(...changes);
    patchData(host, (d) => applyChanges(d, changes));
  }
  // The open conversation follows its chat (lib/chat.ts).
  if (name === EV.chatState) {
    const { id, state } = data as { id: number; state: ChatState };
    onChatState(host, id, state);
  } else if (name === EV.chatItem) {
    const { id, item } = data as { id: number; item: ChatState["items"][number] };
    onChatItem(host, id, item);
  }
}

function connected(id: string) {
  void subscribeHost(id).catch(() => {});
  void loadHost(id).catch(() => {});
  void measure(id);
}

function onStatus(h: HostEntry) {
  const prev = get().hosts[h.id];
  set((s) => ({ hosts: { ...s.hosts, [h.id]: h } }));
  if (h.status === "connected" && prev?.status !== "connected") connected(h.id);
}

let started = false;

/** Starts listening to the core and loads the hosts. */
export async function startApp() {
  if (started) return;
  started = true;
  await onHostStatus((h) => onStatus(h as HostEntry));
  await onDaemonEvent(onEvent);
  // A session's jobs follow `job.changed` and `job.output` (X62).
  startJobs();
  const list = await invoke<HostEntry[]>("host_list");
  set({ hosts: Object.fromEntries(list.map((h) => [h.id, h])), ready: true });
  // Hosts that connected before the listeners were up load now.
  for (const h of list) if (h.status === "connected") connected(h.id);
  // Back from the background: retry hosts that dropped meanwhile at once.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    for (const h of Object.values(get().hosts)) if (h.status !== "connected") void reconnect(h.id).catch(() => {});
  });
  // Round trips and "last seen" stay fresh while the app is open.
  setInterval(() => {
    for (const h of Object.values(get().hosts)) {
      if (h.status !== "connected") continue;
      void measure(h.id);
      void refreshSetups(h.id);
    }
  }, 30_000);
}

/** Pairs with a Mac from its link's parts; resolves to the new Mac. */
export async function pairMac(link: { host: string; addrs: string[]; code: string }, device: string): Promise<HostEntry> {
  const entry = await invoke<HostEntry>("pair", { name: link.host, addrs: link.addrs, code: link.code, device });
  set((s) => ({ hosts: { ...s.hosts, [entry.id]: entry } }));
  return entry;
}

export async function forgetMac(id: string) {
  await invoke("mac_forget", { id });
  set((s) => {
    const hosts = Object.fromEntries(Object.entries(s.hosts).filter(([, h]) => h.mac !== id));
    return { hosts };
  });
}

export const reconnect = (id: string) => invoke("host_reconnect", { id });
