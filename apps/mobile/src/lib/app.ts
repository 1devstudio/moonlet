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
import { type Change, applyChanges, eventChanges } from "./events";

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
  /** "Paired with <Mac>", right after pairing (X39). */
  | { kind: "paired"; name: string }
  | { kind: "session"; host: string; id: string; tab: SessionTab }
  | { kind: "diff"; host: string; id: string; path: string; against: "base" | "head" }
  | { kind: "plan"; host: string; terminal: number; ask: string; from?: Screen };

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

/** Per host, the changes events made while a load runs. */
const loads = new Map<string, Change[]>();

/** Loads everything a connected host's screens show. */
export async function loadHost(host: string) {
  const during: Change[] = [];
  loads.set(host, during);
  try {
    const fetched = await fetchHostData(host);
    // What events changed meanwhile wins over the replies they overtook.
    patchData(host, applyChanges(fetched, during));
  } finally {
    if (loads.get(host) === during) loads.delete(host);
  }
}

async function fetchHostData(host: string): Promise<HostData> {
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
  return {
    terminals: Object.fromEntries(terminals.map((t) => [t.id, t])),
    sessions,
    projects,
    workspaces,
    sections,
    reads,
    chats: Object.fromEntries(chats.map((c) => [c.id, c.state])),
  };
}

function onEvent(e: DaemonEvent) {
  const { host, name, data } = e;
  const changes = eventChanges(name, data);
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
