// The phone app's state (X40): the hosts it reaches, what each daemon
// reports, the screen shown, and settings kept on the phone. Daemon data is
// loaded when a host connects and kept current by its events.

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { onDaemonEvent, onHostStatus, rpc, subscribeHost, type DaemonEvent } from "@desktop/lib/daemon";
import { onChatItem, onChatState } from "@desktop/lib/chat";
import {
  EV,
  M,
  type ChatState,
  type HostInfo,
  type Project,
  type ReadRequest,
  type Section,
  type Session,
  type TerminalInfo,
  type Workspace,
} from "@desktop/lib/protocol";
import { readStored, writeStored } from "@desktop/lib/storage";
import type { HostSeen } from "./hosts";
import { type Touched, mergeLoaded, touchedSince } from "./loadMerge";

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
  workspaces: Workspace[];
  sections: Section[];
  reads: ReadRequest[];
  chats: Record<number, ChatSummary>;
}

export const emptyData = (): HostData => ({ terminals: {}, sessions: [], projects: [], workspaces: [], sections: [], reads: [], chats: {} });

export type Tab = "inbox" | "sessions" | "new" | "hosts";
export type SessionTab = "chat" | "terminal" | "changes" | "pr";

/** A screen over the tabs. */
export type Screen =
  | { kind: "pair" }
  | { kind: "session"; host: string; id: string; tab: SessionTab }
  | { kind: "diff"; host: string; id: string; path: string }
  | { kind: "plan"; host: string; terminal: number; ask: string };

export type NotifyKey = "blocked" | "done" | "error" | "checks";

export interface Settings {
  /** The workspace shown in Inbox and Sessions, `<host>/<id>`. */
  workspace: string | null;
  /** "Notify me when" switches that are off. */
  notifyOff: NotifyKey[];
  /** Face ID before Allow and plan approvals. */
  faceId: boolean;
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
}

export const useApp = create<AppState>(() => ({
  hosts: {},
  seen: loadJson<Record<string, HostSeen>>(SEEN, {}),
  data: {},
  tab: "inbox",
  screen: null,
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

export const showTab = (tab: Tab) => set({ tab, screen: null });
export const showScreen = (screen: Screen | null) => set({ screen });

function patchData(host: string, patch: Partial<HostData> | ((d: HostData) => Partial<HostData>)) {
  set((s) => {
    const cur = s.data[host] ?? emptyData();
    return { data: { ...s.data, [host]: { ...cur, ...(typeof patch === "function" ? patch(cur) : patch) } } };
  });
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

/** Per host, what events changed while a load runs. */
const loads = new Map<string, Touched>();

function touch<K extends keyof Touched>(host: string, kind: K, id: number, value: Touched[K] extends Map<number, infer V> ? V : never) {
  (loads.get(host)?.[kind] as Map<number, unknown> | undefined)?.set(id, value);
}

/** Loads everything a connected host's screens show. */
export async function loadHost(host: string) {
  const touched = touchedSince();
  loads.set(host, touched);
  try {
    await load(host, touched);
  } finally {
    if (loads.get(host) === touched) loads.delete(host);
  }
}

async function load(host: string, touched: Touched) {
  const call = <T>(method: string, params: object = {}) => rpc<T>(host, method, params);
  const [terminals, sessions, projects, workspaces, sections, reads, chats] = await Promise.all([
    call<TerminalInfo[]>(M.terminalList),
    call<Session[]>(M.sessionList),
    call<Project[]>(M.projectList),
    call<Workspace[]>(M.workspaceList),
    call<Section[]>(M.sectionList),
    call<ReadRequest[]>(M.terminalReadRequests).catch(() => []),
    call<{ id: number; state: ChatSummary }[]>(M.chatSummaries).catch(() => []),
  ]);
  const loaded = mergeLoaded(
    {
      terminals: Object.fromEntries(terminals.map((t) => [t.id, t])),
      sessions,
      projects,
      workspaces,
      sections,
      reads,
      chats: Object.fromEntries(chats.map((c) => [c.id, c.state])),
    },
    touched,
  );
  patchData(host, loaded);
}

function onEvent(e: DaemonEvent) {
  const { host, name, data } = e;
  switch (name) {
    case EV.terminalCreated:
    case EV.terminalUpdated:
    case EV.terminalExited: {
      const t = data as TerminalInfo;
      touch(host, "terminals", t.id, t);
      patchData(host, (d) => ({ terminals: { ...d.terminals, [t.id]: t } }));
      break;
    }
    case EV.terminalRemoved: {
      const id = (data as { id: number }).id;
      touch(host, "terminals", id, null);
      touch(host, "chats", id, null);
      patchData(host, (d) => {
        const terminals = { ...d.terminals };
        delete terminals[id];
        const chats = { ...d.chats };
        delete chats[id];
        return { terminals, chats };
      });
      break;
    }
    case EV.sessionsChanged:
    case EV.projectsChanged:
    case EV.workspacesChanged:
    case EV.sectionsChanged:
      void loadHost(host).catch(() => {});
      break;
    case EV.terminalReadRequest:
      touch(host, "reads", (data as ReadRequest).request_id, data as ReadRequest);
      patchData(host, (d) => ({ reads: [...d.reads.filter((r) => r.request_id !== (data as ReadRequest).request_id), data as ReadRequest] }));
      break;
    case EV.terminalReadDone:
      touch(host, "reads", (data as { request_id: number }).request_id, null);
      patchData(host, (d) => ({ reads: d.reads.filter((r) => r.request_id !== (data as { request_id: number }).request_id) }));
      break;
    case EV.chatState: {
      const { id, state } = data as { id: number; state: ChatState };
      const { items: _items, ...summary } = state;
      touch(host, "chats", id, summary);
      patchData(host, (d) => ({ chats: { ...d.chats, [id]: summary } }));
      onChatState(host, id, state);
      break;
    }
    case EV.chatItem: {
      const { id, item } = data as { id: number; item: ChatState["items"][number] };
      onChatItem(host, id, item);
      break;
    }
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
    for (const h of Object.values(get().hosts)) if (h.status === "connected") void measure(h.id);
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
