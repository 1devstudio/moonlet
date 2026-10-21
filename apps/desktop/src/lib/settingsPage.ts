// The settings page (X43): which page is open, the nav and the header's
// breadcrumb, and the status lines its pages show. Pure: the page itself is
// components/settings/.

import { accountLabel, accountState, tildePath } from "./profiles";
import type { DaemonService, HookStatus, HostInfo, MobileStatus, ProfileAccount, ProfileInfo, Workspace, WorkspaceColor } from "./protocol";
import { claudeOffer, claudeStatus, type ClaudeUpdateState, type ClaudeVersions } from "./claudeUpdate";
import { mobileLine } from "./mobile";
import { DEV_BUILD_NOTE, updateButton, updateStatus, type UpdateState } from "./updater";

/** The app-wide pages, in nav order. */
export type AppPage = "general" | "appearance" | "terminal" | "agents" | "git" | "notifications" | "trackers" | "shortcuts" | "profiles" | "hooks" | "hosts" | "phones";

export type SettingsRoute =
  /** `focus` is a row's `data-setting`, scrolled to and highlighted (X50 Manage › Boards). */
  | { page: AppPage; focus?: string }
  | { page: "workspace"; host: string; id: string } | { page: "project"; host: string; id: string; focus?: "run" };

export interface NavEntry {
  /** Unique within the nav. */
  key: string;
  route: SettingsRoute;
  label: string;
  /** A number on the right, such as the remote hosts. */
  count?: number;
  /** A warning dot on the right; the text is its accessible label. */
  dot?: string;
  /** A workspace's colour square. */
  mark?: WorkspaceColor;
  /** The remote host a workspace or project is on. */
  host?: string;
}

export interface NavGroup {
  title: string;
  entries: NavEntry[];
}

/** A workspace or project in the nav; `remote` names its host if remote. */
export interface NavItem {
  host: string;
  id: string;
  name: string;
  remote: string | null;
}

export interface NavInput {
  remoteHosts: number;
  phones: number;
  profilesNeedSignIn: boolean;
  /** Tracker connections whose token was rejected (X44). */
  trackersNeedAttention?: number;
  workspaces: (NavItem & { color: WorkspaceColor })[];
  projects: NavItem[];
}

const app = (page: AppPage, label: string, extra: Partial<NavEntry> = {}): NavEntry => ({ key: page, route: { page }, label, ...extra });
const counted = (page: AppPage, label: string, n: number): NavEntry => app(page, label, n ? { count: n } : {});
const onHost = (remote: string | null) => (remote ? { host: remote } : {});

const trackerDot = (n: number): Partial<NavEntry> => (n ? { dot: n === 1 ? "1 connection needs attention" : `${n} connections need attention` } : {});

export function settingsNav(input: NavInput): NavGroup[] {
  const groups: NavGroup[] = [
    {
      title: "App",
      entries: [app("general", "General"), app("appearance", "Appearance"), app("terminal", "Terminal"), app("agents", "Agents"), app("git", "Git"), app("notifications", "Notifications"), app("trackers", "Task trackers", trackerDot(input.trackersNeedAttention ?? 0)), app("shortcuts", "Keyboard shortcuts")],
    },
    {
      title: "Claude Code",
      entries: [app("profiles", "Profiles", input.profilesNeedSignIn ? { dot: "a profile is not signed in" } : {}), app("hooks", "Hooks")],
    },
    { title: "Machines", entries: [counted("hosts", "Hosts", input.remoteHosts), counted("phones", "Phones", input.phones)] },
  ];
  if (input.workspaces.length)
    groups.push({
      title: "Workspaces",
      entries: input.workspaces.map((w) => ({ key: routeKey({ page: "workspace", host: w.host, id: w.id }), route: { page: "workspace", host: w.host, id: w.id }, label: w.name, mark: w.color, ...onHost(w.remote) })),
    });
  if (input.projects.length)
    groups.push({
      title: "Projects",
      entries: input.projects.map((p) => ({ key: routeKey({ page: "project", host: p.host, id: p.id }), route: { page: "project", host: p.host, id: p.id }, label: p.name, ...onHost(p.remote) })),
    });
  return groups;
}

/** The key of the nav entry for `route`. */
/** The row an app page route opens on (its `data-setting`), if it names one. */
export const routeFocus = (route: SettingsRoute): string | undefined => (route.page !== "project" && "focus" in route ? route.focus : undefined);

export function routeKey(route: SettingsRoute): string {
  if (route.page === "workspace") return `ws:${route.host}:${route.id}`;
  if (route.page === "project") return `project:${route.host}:${route.id}`;
  return route.page;
}

/** The header's breadcrumb. App pages sit right under Settings; a workspace
 * or project page shows `name`. */
export function settingsCrumbs(route: SettingsRoute, name = ""): string[] {
  if (route.page === "workspace") return ["Settings", "Workspaces", name];
  if (route.page === "project") return ["Settings", "Projects", name];
  const groups = settingsNav({ remoteHosts: 0, phones: 0, profilesNeedSignIn: false, workspaces: [], projects: [] });
  const group = groups.find((g) => g.entries.some((e) => e.key === route.page))!;
  const label = group.entries.find((e) => e.key === route.page)!.label;
  return group.title === "App" ? ["Settings", label] : ["Settings", group.title, label];
}

/** A workspace's sessions can't start Claude: the profile it uses (or the
 * default, `defaultAccount`) is known to be signed out. */
export function profilesNeedSignIn(workspaces: Workspace[], profiles: ProfileInfo[], defaultAccount: ProfileAccount | null): boolean {
  return workspaces.some((w) => {
    const p = profiles.find((x) => x.id === w.claude_profile);
    const account = p ? p.account : defaultAccount;
    return accountState(account) === "signed-out";
  });
}

export type Tone = "done" | "accent" | "blocked" | "error" | "muted";

export interface StatusLine {
  tone: Tone;
  text: string;
  /** A file path shown after the text, in mono. */
  path?: string;
}

/** The hint under "Start the moonlet daemon at login", in the words of the mechanism. */
export function daemonHint(st: DaemonService | null): string {
  const how = st?.mechanism === "plist" ? "Under launchd" : "As a login item";
  return `Agents run in moonletd, not in this window. ${how} it starts at login and restarts if it ever crashes.`;
}

/** Whether "Start the moonlet daemon at login" shows as on. */
export function daemonOn(st: DaemonService): boolean {
  return st.mechanism === "login_item" ? st.state === "enabled" : st.state !== "not_installed";
}

/** Whether turning it off stops the daemon that launchd runs, so the app asks first. */
export function offStopsDaemon(st: DaemonService): boolean {
  return st.state === "enabled" || st.state === "loaded";
}

/** Whether the line offers Open Login Items: only the user can allow the login item again there. */
export function opensLoginItems(st: DaemonService): boolean {
  return st.mechanism === "login_item" && st.state === "requires_approval";
}

/** The toast after the toggle changed, given the state it left. */
export function daemonToast(on: boolean, st: DaemonService): string {
  if (!on) return "Login item removed";
  return opensLoginItems(st) ? "Allow moonlet in System Settings › Login Items" : "The moonlet daemon now starts at login";
}

/** The line under "Start the moonlet daemon at login". */
export function daemonLine(st: DaemonService, home: string | null): StatusLine {
  if (st.mechanism === "login_item") {
    switch (st.state) {
      case "enabled":
        return { tone: "done", text: "Starts at login · moonlet in System Settings › Login Items" };
      case "requires_approval":
        return { tone: "blocked", text: "Turned off in System Settings › Login Items" };
      case "not_found":
        return { tone: "error", text: "macOS cannot find moonlet's login item. Reinstall moonlet." };
      default:
        return { tone: "muted", text: "Not starting at login: moonletd runs while moonlet is open" };
    }
  }
  if (st.state === "not_installed") return { tone: "muted", text: "Not installed: moonletd runs while moonlet is open" };
  const path = tildePath(st.plist, home);
  return st.state === "loaded" ? { tone: "done", text: "Running under launchd", path } : { tone: "blocked", text: "Installed but not loaded", path };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Is version `a` older than `b`? Compares `x.y.z` numerically. */
function older(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0;
  }
  return false;
}

/** The command that installs or updates moonlet on a Linux host (X58). */
export const INSTALL_COMMAND = "curl -fsSL https://github.com/1devstudio/moonlet/releases/latest/download/install.sh | sh";

/** The host, not this Mac, is the one to update. */
const hostIsOlder = (h: HostInfo, appVersion: string) => !!h.daemon_version && !!appVersion && older(h.daemon_version, appVersion);

/** A tailnet host and this Mac speak different protocols: which to update,
 * and how on the host (X57, X58). */
function updateText(h: HostInfo, appVersion: string): string {
  const theirs = h.daemon_version ?? "";
  if (theirs && appVersion && older(appVersion, theirs)) return `Update moonlet on this Mac (${h.label} runs ${theirs})`;
  if (!hostIsOlder(h, appVersion)) return `Update moonlet on ${h.label}`;
  const which = `Update moonlet on ${h.label} (it runs ${theirs}, this Mac ${appVersion})`;
  if (h.os === "linux") return `${which}: run this there`;
  if (h.os === "macos") return `${which} from its Settings › Updates`;
  return which;
}

/** What to run on a Linux host that needs an update; null otherwise (X58). */
export function updateCommand(h: HostInfo, appVersion: string): string | null {
  return h.status === "needs_update" && h.os === "linux" && hostIsOlder(h, appVersion) ? INSTALL_COMMAND : null;
}

/** A host that no longer accepts this Mac's token (X57). */
const refusedText = (h: HostInfo) => `${h.label} no longer accepts this Mac. Pair it again.`;

/** A host's state on the Hosts page, with its open sessions. */
export function hostLine(h: HostInfo, sessions: number, appVersion = ""): StatusLine {
  switch (h.status) {
    case "connected":
      return { tone: "done", text: ["Connected", h.remote && h.daemon_version && `moonletd ${h.daemon_version}`, plural(sessions, "session")].filter(Boolean).join(" · ") };
    case "needs_install":
      return { tone: "error", text: "Needs install · no moonletd on the host" };
    case "needs_update":
      return { tone: "error", text: updateText(h, appVersion) };
    case "refused":
      return { tone: "error", text: refusedText(h) };
    case "error":
      return { tone: "error", text: h.message ?? "Can't connect" };
    case "reconnecting":
      return { tone: "blocked", text: "Reconnecting…" };
    default:
      return { tone: "blocked", text: "Connecting…" };
  }
}

/** What the sidebar says under a host that is not connected; null when it is. */
export function hostNotice(h: HostInfo, appVersion: string): string | null {
  switch (h.status) {
    case "connected":
      return null;
    case "needs_install":
      return `${h.label}: helper not installed`;
    case "needs_update":
      return updateText(h, appVersion);
    case "refused":
      return refusedText(h);
    case "error":
      return `${h.label}: ${h.message ?? "connection failed"}`;
    default:
      return `${h.label}: reconnecting…`;
  }
}

export type HostAction = "install" | "reinstall" | "pair-again" | "retry";

/** The buttons on a remote host's row (R2, X57). A host that waits for the
 * user (`needs_update`, an error) is retried by hand once they act. */
export function hostActions(h: HostInfo): HostAction[] {
  const ssh = h.kind !== "tailnet";
  switch (h.status) {
    case "needs_install":
      return ssh ? ["install"] : [];
    case "connected":
      return ssh ? ["reinstall"] : [];
    case "refused":
      return ["pair-again"];
    case "needs_update":
    case "error":
      return ["retry"];
    default:
      return [];
  }
}

/** The question Remove asks first, or null. A tailnet host that is not
 * connected cannot be told to forget this Mac (X57). */
export function removeAsks(h: HostInfo): { title: string; message: string } | null {
  if (h.kind !== "tailnet" || h.status === "connected") return null;
  return { title: `Remove ${h.id}?`, message: `${h.id} will still list this Mac until you remove it there.` };
}

const andList = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** A profile's account on the Profiles page; `usedBy`: the workspaces using it. */
export function profileLine(account: ProfileAccount | null | undefined, usedBy: string[]): StatusLine {
  const state = accountState(account);
  if (state === "checking") return { tone: "muted", text: "Checking…" };
  const who = state === "signed-in" && account ? `Signed in as ${accountLabel(account)}` : "Not signed in";
  if (!usedBy.length) return { tone: "muted", text: `${who} · not used by a workspace` };
  if (state === "signed-in") return { tone: "muted", text: who };
  const whose = usedBy.length === 1 ? `${usedBy[0]}'s sessions` : `sessions in ${andList(usedBy)}`;
  return { tone: "blocked", text: `${who} · ${whose} can't start Claude` };
}

export interface HookRow {
  agent: "claude" | "codex";
  name: string;
  state: StatusLine;
  /** The file moonlet adds its hooks to. */
  path: string;
  /** What is in place, as chips. */
  parts: { label: string; ok: boolean }[];
}

/** Claude Code and Codex on the Hooks page (A2). Codex's notify hook is only
 * known to be there once everything is. */
export function hookRows(st: HookStatus, home: string | null): HookRow[] {
  const installed: StatusLine = { tone: "done", text: "Installed" };
  const missing: StatusLine = { tone: "muted", text: "Not installed" };
  return [
    {
      agent: "claude",
      name: "Claude Code",
      state: st.claude_installed ? installed : missing,
      path: tildePath(st.claude_settings, home),
      parts: [
        { label: "State hooks", ok: st.claude_missing_events.length === 0 },
        { label: "moonlet skill", ok: !!st.claude_skill },
      ],
    },
    {
      agent: "codex",
      name: "Codex",
      state: st.codex_installed ? installed : st.codex_conflict ? { tone: "blocked", text: `Skipped: already notifies "${st.codex_conflict}"` } : missing,
      path: tildePath(st.codex_config, home),
      parts: st.codex_installed
        ? [
            { label: "Notify hook", ok: true },
            { label: "moonlet skill", ok: true },
          ]
        : [],
    },
  ];
}

/** Esc on the settings page. A dialog over it (sign-in, confirm, the
 * palette) or a shortcut being recorded has the key wherever focus is;
 * a text field gives up focus
 * first, after its own Esc handling; otherwise the page closes. */
export function escapeAction(s: { dialogShown: boolean; editable: boolean; recording: boolean }): "close" | "leave-field" | "ignore" {
  if (s.dialogShown || s.recording) return "ignore";
  return s.editable ? "leave-field" : "close";
}

/** The option a key moves to in a radio group of `count` (WAI-ARIA radio
 * pattern), or null for any other key. */
export function radioKey(key: string, index: number, count: number): number | null {
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (index + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** moonlet's update status under its version (X35); null before a check. */
export function appUpdateLine(u: UpdateState, checking: boolean, error: string | null): StatusLine | null {
  const text = updateStatus(u, checking, error);
  if (!text) return null;
  if (checking) return { tone: "muted", text };
  if (error) return { tone: error === DEV_BUILD_NOTE ? "muted" : "blocked", text };
  return { tone: updateButton(u) ? "accent" : "done", text };
}

/** Claude Code's update status under its version (X36). */
export function claudeUpdateLine(s: ClaudeUpdateState, v: ClaudeVersions, checking: boolean): StatusLine | null {
  const text = claudeStatus(s, v, checking);
  if (!text) return null;
  if (checking || s.phase === "updating") return { tone: "muted", text };
  if (!v.installed) return { tone: "blocked", text };
  return { tone: claudeOffer(s, v) ? "accent" : "done", text };
}

/** The line under "Allow connections from my tailnet" (X39, X57). */
export function phoneAccessLine(st: MobileStatus): StatusLine {
  const text = mobileLine(st);
  if (st.enabled && !st.tailscale) return { tone: "blocked", text };
  return { tone: st.enabled && st.listening.length ? "done" : "muted", text };
}

/** Install hooks has nothing left to do: Claude Code is in, and Codex is in
 * or skipped. An unknown status (the read failed) still offers it. */
export function hooksDone(st: HookStatus | null): boolean {
  return !!st?.claude_installed && (st.codex_installed || !!st.codex_conflict);
}

/** Hosts as the nav lists their workspaces and projects: this Mac first. */
export function hostOrder(ids: string[]): string[] {
  return [...ids].sort((a, b) => (a === "local" ? -1 : b === "local" ? 1 : a.localeCompare(b)));
}

/** ⌘↵ saves a workspace or project page only when the page is what the
 * user sees and no dialog or nested form (New profile) has the key. */
export function saveKeySaves(s: { dialogShown: boolean; inOwnForm: boolean; searching: boolean }): boolean {
  return !s.dialogShown && !s.inOwnForm && !s.searching;
}

/** The confirm before Install hooks (A2); `st` is null when the status could
 * not be read, so the files are named by their agent. */
export function installHooksMessage(st: HookStatus | null): string {
  const backup = "A backup of each file is written first and your own settings are kept.";
  if (!st) return `moonlet will add its hooks to Claude Code's and Codex's settings, and a "moonlet" skill next to each.\n\n${backup}`;
  return `moonlet will add its hooks to:\n• ${st.claude_settings}\n• ${st.codex_config}\n\nand a "moonlet" skill to the skills folder next to each.\n\n${backup}`;
}

/** Under a workspace's Claude profile: who it signs in as, or a warning. */
export function accountNote(profile: string, account: ProfileAccount | null | undefined): StatusLine {
  const state = accountState(account);
  if (state === "signed-in" && account) return { tone: "muted", text: `Signed in as ${accountLabel(account)}` };
  return state === "signed-out" ? { tone: "blocked", text: `${profile} is not signed in` } : { tone: "muted", text: "Checking…" };
}
