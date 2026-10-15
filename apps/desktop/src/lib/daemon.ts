// Bridge to the Tauri core: RPCs to daemons, PTY input, and the binary
// output stream (one channel per host, demultiplexed by session id).

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { HostInfo } from "./protocol";

export interface RpcError {
  code: string;
  message: string;
}

export class DaemonError extends Error {
  code: string;
  constructor(e: RpcError) {
    super(e.message);
    this.code = e.code;
  }
}

export async function rpc<T = unknown>(host: string, method: string, params: unknown = {}): Promise<T> {
  try {
    return await invoke<T>("rpc", { host, method, params });
  } catch (e) {
    if (e && typeof e === "object" && "message" in e) throw new DaemonError(e as RpcError);
    throw new DaemonError({ code: "failed", message: String(e) });
  }
}

export function sendInput(host: string, session: number, data: string) {
  return invoke("send_input", { host, session, data }).catch(() => {});
}

export const hostsApi = {
  list: () => invoke<HostInfo[]>("host_list"),
  add: (id: string) => invoke<HostInfo>("host_add", { id }),
  remove: (id: string) => invoke("host_remove", { id }),
  reconnect: (id: string) => invoke("host_reconnect", { id }),
  sshHosts: () => invoke<string[]>("ssh_hosts"),
  install: (host: string) => invoke<{ triple: string; version: string }>("remote_install", { host }),
  openTargets: () => invoke<{ id: string; label: string }[]>("open_targets"),
  openIn: (target: string, path: string, host?: string) => invoke("open_in", { target, path, host }),
  playSound: (name: string) => invoke("play_sound", { name }),
  service: (action: "install" | "uninstall" | "status") => invoke<{ installed: boolean; loaded: boolean; plist: string }>("daemon_service", { action }),
  appInfo: () => invoke<{ version: string }>("app_info"),
  claudeLatest: () => invoke<string>("claude_latest_version"),
  /** Linear, Jira and ClickUp from the app (X44): sign in, sources, tasks, moves. */
  trackerConnect: (req: { kind: "linear" | "jira" | "clickup"; site?: string; email?: string; token: string }) =>
    invoke<{ connection: import("./tasksStore").Connection; sources: { key: string; name: string }[] }>("tracker_connect", { req }),
  trackerDisconnect: (id: string) => invoke("tracker_disconnect", { id }),
  trackerSources: (id: string) => invoke<{ key: string; name: string }[]>("tracker_sources", { id }),
  trackerTask: (id: string, key: string) => invoke<import("./tasks").Task | null>("tracker_task", { id, key }),
  trackerTasks: (id: string, mine: boolean) => invoke<import("./tasks").Task[]>("tracker_tasks", { id, mine }),
  trackerUpdate: (req: { id: string; task: string; source: string; column?: string | null; assign_me?: boolean; comment?: string | null }) =>
    invoke("tracker_update", { req }),
  trackerOauthAvailable: () => invoke<boolean>("tracker_oauth_available"),
  trackerOauthLinear: () => invoke<{ connection: import("./tasksStore").Connection; sources: { key: string; name: string }[] }>("tracker_oauth_linear"),
  trackerStates: (id: string, source: string) => invoke<{ name: string; column: import("./tasks").Column }[]>("tracker_states", { id, source }),
  /** `~/.moonlet/trackers.toml`, or its defaults (X44). */
  trackersConfig: () => invoke<Partial<import("./tasksStore").TrackersConfig>>("trackers_config"),
  trackersSave: (config: import("./tasksStore").TrackersConfig) => invoke("trackers_save", { config }),
  /** A key or issue URL pasted into the link dialog, or null (X46). */
  parsePasted: (input: string) => invoke<import("./taskLinking").Pasted | null>("task_parse_pasted", { input }),
  /** The branch for a session started from a task (X46); `kind` is the tracker. */
  taskBranch: (o: { kind: "linear" | "jira" | "clickup" | "github"; key: string; title: string; number?: number; template?: string; maxLen?: number; user?: string; issueType?: string }) =>
    invoke<string>("task_branch_name", {
      kind: o.kind,
      template: o.template ?? null,
      key: o.key,
      title: o.title,
      number: o.number ?? null,
      maxLen: o.maxLen ?? null,
      user: o.user ?? null,
      issueType: o.issueType ?? null,
    }),
};

/** Must match `RESET_FLAG` in src-tauri/src/hosts.rs. */
export const RESET_FLAG = 0x8000_0000;

export interface OutputSink {
  /** Called with an attach snapshot: reset the terminal, then write it. */
  reset(data: Uint8Array): void;
  write(data: Uint8Array): void;
}

const sinks = new Map<string, OutputSink>();
const subscribed = new Set<string>();

export const sinkKey = (host: string, session: number) => `${host}:${session}`;

export function registerSink(host: string, session: number, sink: OutputSink) {
  sinks.set(sinkKey(host, session), sink);
  return () => {
    if (sinks.get(sinkKey(host, session)) === sink) sinks.delete(sinkKey(host, session));
  };
}

/** Parses `[u32 session][u32 len][bytes]` records. Exported for tests. */
export function parseBatch(buf: ArrayBuffer, emit: (session: number, reset: boolean, data: Uint8Array) => void) {
  const view = new DataView(buf);
  let off = 0;
  while (off + 8 <= buf.byteLength) {
    const raw = view.getUint32(off);
    const len = view.getUint32(off + 4);
    off += 8;
    if (off + len > buf.byteLength) break;
    const data = new Uint8Array(buf, off, len);
    off += len;
    const reset = (raw & RESET_FLAG) !== 0;
    emit(reset ? raw - RESET_FLAG : raw, reset, data);
  }
}

/** Opens the output channel for a host once; safe to call repeatedly. */
export async function subscribeHost(host: string) {
  if (subscribed.has(host)) return;
  subscribed.add(host);
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = (msg) => {
    const buf = msg instanceof ArrayBuffer ? msg : new Uint8Array(msg as unknown as number[]).buffer;
    parseBatch(buf, (session, reset, data) => {
      const sink = sinks.get(sinkKey(host, session));
      if (!sink) return;
      if (reset) sink.reset(data);
      else sink.write(data);
    });
  };
  try {
    await invoke("host_subscribe", { host, channel });
  } catch (e) {
    subscribed.delete(host);
    throw e;
  }
}

export interface DaemonEvent {
  host: string;
  name: string;
  data: unknown;
}

export function onDaemonEvent(cb: (e: DaemonEvent) => void): Promise<UnlistenFn> {
  return listen<DaemonEvent>("daemon-event", (e) => cb(e.payload));
}

export function onHostStatus(cb: (h: HostInfo) => void): Promise<UnlistenFn> {
  return listen<HostInfo>("host-status", (e) => cb(e.payload));
}
