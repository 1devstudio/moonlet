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
  /** A connection's teams, projects or lists; a Linear team that uses cycles says so, a ClickUp list names its space and folder. */
  trackerSources: (id: string) => invoke<{ key: string; name: string; cycles?: boolean; group?: string }[]>("tracker_sources", { id }),
  trackerTask: (id: string, key: string) => invoke<import("./tasks").Task | null>("tracker_task", { id, key }),
  trackerUpdate: (req: { id: string; task: string; source: string; column?: string | null; status?: string | null; assign_me?: boolean; comment?: string | null }) =>
    invoke("tracker_update", { req }),
  trackerOauthAvailable: () => invoke<boolean>("tracker_oauth_available"),
  trackerOauthLinear: () => invoke<{ connection: import("./tasksStore").Connection; sources: { key: string; name: string }[] }>("tracker_oauth_linear"),
  trackerStates: (id: string, source: string) => invoke<{ name: string; column: import("./tasks").Column }[]>("tracker_states", { id, source }),
  /** A Jira connection's boards (X50 Add a board). */
  trackerBoards: (id: string) => invoke<{ id: number; name: string; kind: string; project: string | null }[]>("tracker_boards", { id }),
  /** A GitHub Project's columns from its Status options (X50). */
  githubProjectColumns: (options: { id: string; name: string }[]) => invoke<import("./boards").BoardColumn[]>("github_project_columns", { options }),
  /** A Jira board's columns, filter and story points field (X50). */
  trackerBoardSetup: (id: string, board: number) =>
    invoke<{ filterId: string; filterJql?: string; subQuery: string | null; pointsField: string | null; sprints: boolean; statusNames: Record<string, string>; columns: import("./boards").BoardColumn[] }>("tracker_board_setup", { id, board }),
  /** The new-issue form's lists for a place (X52): the user, people and labels, by id and name. */
  trackerCreateOptions: (id: string, place: string, issueType?: string) =>
    invoke<{ me: string; people: { id: string; name: string }[]; labels: { id: string; name: string }[]; issueTypes?: { id: string; name: string }[]; missing?: string[] }>("tracker_create_options", {
      id,
      place,
      issueType: issueType ?? null,
    }),
  /** Creates an issue in a column's status (X52), answering with it as a board shows it. */
  /** `statuses` and `column` place a Jira issue; `sprint` is the one its board follows. `failed` follows "Created <key>" in the notice. */
  trackerCreate: (req: { id: string; place: string; issue: import("./newIssue").NewIssue & { status: string }; inCycle: boolean; statuses: string[]; column: string; sprint?: number }) =>
    invoke<{ issue: import("./boards").BoardIssue; failed?: string }>("tracker_create", { req }),
  /**
   * A board's issues, its active sprint, and a Jira board's columns as Jira
   * has them now (X50). `sync` names the sync the read is in: its reads share
   * the connection's lookups.
   */
  trackerBoardTasks: (query: { id: string; origin: import("./boards").Origin; narrow?: string; mine: boolean; finished: number | "sprint"; sync?: number }) =>
    invoke<{ issues: import("./boards").BoardIssue[]; sprint: { id: number; name: string; startMs: number; endMs: number } | null; columns: import("./boards").BoardColumn[] | null; kind?: string; statusNames?: Record<string, string> }>(
      "tracker_board_tasks",
      { query },
    ),
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
