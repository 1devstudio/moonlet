// Bridge to the Tauri core: RPCs to daemons, PTY input, and the binary
// output stream (one channel per host, demultiplexed by session id).

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DaemonService, HostInfo, LinkInfo } from "./protocol";
import { EarlyOutput, parseCopyHost, routeCall, unwrapEvent } from "./copyHost";

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
  if (parseCopyHost(host)) return rpcCopy<T>(host, method, params);
  try {
    return await invoke<T>("rpc", { host, method, params });
  } catch (e) {
    if (e && typeof e === "object" && "message" in e) throw new DaemonError(e as RpcError);
    throw new DaemonError({ code: "failed", message: String(e) });
  }
}

export function sendInput(host: string, session: number, data: string) {
  const copy = parseCopyHost(host);
  if (copy) {
    // A terminal of another member: typed into through its relay (X72).
    const relay = relays.get(sinkKey(host, session));
    if (relay === undefined) return Promise.resolve();
    return invoke("send_input", { host: copy.host, session: relay, data }).catch(() => {});
  }
  return invoke("send_input", { host, session, data }).catch(() => {});
}

/** A copy host's terminals (X72): the relay id of each attached one, and
 * the copy host terminal each relay's output is for. */
const relays = new Map<string, number>();
const relayed = new Map<string, string>();
const early = new EarlyOutput();

/** A call to a copy host, through its central host (X72). An attached
 * terminal keeps its own id here; its output comes under its relay id. */
async function rpcCopy<T>(host: string, method: string, params: unknown): Promise<T> {
  const copy = parseCopyHost(host)!;
  const route = routeCall(host, method, params, (t) => relays.get(sinkKey(host, t)));
  const terminal = (params as { id?: number } | null)?.id;
  if (!route) return true as T;
  const out = await rpc<T>(route.host, route.method, route.params);
  if (method === "terminal.attach" && terminal !== undefined) {
    const reply = out as unknown as { info: { id: number } };
    relays.set(sinkKey(host, terminal), reply.info.id);
    relayed.set(sinkKey(copy.host, reply.info.id), sinkKey(host, terminal));
    // The snapshot and output that came before this reply was read.
    const sink = sinks.get(sinkKey(host, terminal));
    for (const o of early.take(sinkKey(copy.host, reply.info.id))) {
      if (!sink) break;
      if (o.reset) sink.reset(o.data);
      else sink.write(o.data);
    }
    reply.info.id = terminal;
  }
  if (method === "terminal.detach" && terminal !== undefined) {
    const relay = relays.get(sinkKey(host, terminal));
    relays.delete(sinkKey(host, terminal));
    if (relay !== undefined) relayed.delete(sinkKey(copy.host, relay));
  }
  return out;
}

export const hostsApi = {
  list: () => invoke<HostInfo[]>("host_list"),
  add: (id: string) => invoke<HostInfo>("host_add", { id }),
  /** Pairs with a host over the tailnet (X57); `addrs` from a pasted link, or null to look up `name`. */
  pair: (name: string, addrs: string[] | null, code: string) => invoke<HostInfo>("host_pair", { name, addrs, code }),
  remove: (id: string) => invoke("host_remove", { id }),
  reconnect: (id: string) => invoke("host_reconnect", { id }),
  /** The version of this app's bundle on disk (X69); null for a dev build. */
  bundleVersion: () => invoke<string | null>("bundle_version"),
  /** Updates a tailnet host to `version` (X69): `{from, to}` once it hands over. */
  update: (id: string, version: string) => invoke<{ from: string; to: string }>("host_update", { id, version }),
  /** Makes a tailnet host this Mac's central host, or clears it; the app passes the token on (X41). */
  setCentral: (id: string | null) => invoke<LinkInfo>("host_set_central", { id }),
  sshHosts: () => invoke<string[]>("ssh_hosts"),
  install: (host: string) => invoke<{ triple: string; version: string }>("remote_install", { host }),
  openTargets: () => invoke<{ id: string; label: string }[]>("open_targets"),
  openIn: (target: string, path: string, host?: string) => invoke("open_in", { target, path, host }),
  playSound: (name: string) => invoke("play_sound", { name }),
  service: (action: "install" | "uninstall" | "status") => invoke<DaemonService>("daemon_service", { action }),
  openLoginItems: () => invoke("open_login_items"),
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
  /** An issue's comments, oldest first, at most 100 (X66); `task` is its id in the tracker. */
  trackerComments: (id: string, task: string) =>
    invoke<{ comments: { id: string; author: string; body: string; markdown: boolean; createdMs: number }[]; more: boolean }>("tracker_comments", { id, task }),
  /** Posts the user's Markdown as a comment on an issue (X66). */
  trackerComment: (id: string, task: string, text: string) => invoke("tracker_comment", { id, task, text }),
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
    invoke<{ me: string; people: { id: string; name: string }[]; labels: { id: string; name: string }[]; issueTypes?: { id: string; name: string }[]; missing?: string[]; fields?: string[] }>("tracker_create_options", {
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
  // A copy host's output comes on its central host's channel (X72).
  const copy = parseCopyHost(host);
  if (copy) return subscribeHost(copy.host);
  if (subscribed.has(host)) return;
  subscribed.add(host);
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = (msg) => {
    const buf = msg instanceof ArrayBuffer ? msg : new Uint8Array(msg as unknown as number[]).buffer;
    parseBatch(buf, (session, reset, data) => {
      const key = sinkKey(host, session);
      const sink = sinks.get(key) ?? sinks.get(relayed.get(key) ?? "");
      if (!sink) {
        // A relay whose attach reply is not read yet (X72).
        early.keep(key, session, reset, data);
        return;
      }
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
  return listen<DaemonEvent>("daemon-event", (e) => {
    cb(e.payload);
    // Another member's session events, as its copy host's own (X72).
    const copy = unwrapEvent(e.payload);
    if (copy) cb(copy);
  });
}

export function onHostStatus(cb: (h: HostInfo) => void): Promise<UnlistenFn> {
  return listen<HostInfo>("host-status", (e) => cb(e.payload));
}
