// The settings page (X43): which page is open, the nav and the header's
// breadcrumb, and the status lines its pages show. Pure: the page itself is
// components/settings/.

import { accountLabel, accountState, tildePath } from "./profiles";
import type { HookStatus, HostInfo, MobileStatus, ProfileAccount, ProfileInfo, Workspace, WorkspaceColor } from "./protocol";
import { claudeOffer, claudeStatus, type ClaudeUpdateState, type ClaudeVersions } from "./claudeUpdate";
import { mobileLine } from "./mobile";
import { DEV_BUILD_NOTE, updateButton, updateStatus, type UpdateState } from "./updater";

/** The app-wide pages, in nav order. */
export type AppPage = "general" | "appearance" | "terminal" | "agents" | "notifications" | "shortcuts" | "profiles" | "hooks" | "hosts" | "phones";

export type SettingsRoute = { page: AppPage } | { page: "workspace"; host: string; id: string } | { page: "project"; host: string; id: string; focus?: "run" };

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
  workspaces: (NavItem & { color: WorkspaceColor })[];
  projects: NavItem[];
}

const app = (page: AppPage, label: string, extra: Partial<NavEntry> = {}): NavEntry => ({ key: page, route: { page }, label, ...extra });
const counted = (page: AppPage, label: string, n: number): NavEntry => app(page, label, n ? { count: n } : {});
const onHost = (remote: string | null) => (remote ? { host: remote } : {});

export function settingsNav(input: NavInput): NavGroup[] {
  const groups: NavGroup[] = [
    {
      title: "App",
      entries: [app("general", "General"), app("appearance", "Appearance"), app("terminal", "Terminal"), app("agents", "Agents"), app("notifications", "Notifications"), app("shortcuts", "Keyboard shortcuts")],
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

/** The line under "Start the moonlet daemon at login" (S1b). */
export function daemonLine(st: { installed: boolean; loaded: boolean; plist: string }, home: string | null): StatusLine {
  if (!st.installed) return { tone: "muted", text: "Not installed: moonletd runs while moonlet is open" };
  const path = tildePath(st.plist, home);
  return st.loaded ? { tone: "done", text: "Running under launchd", path } : { tone: "blocked", text: "Installed but not loaded", path };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** A host's state on the Hosts page, with its open sessions. */
export function hostLine(h: HostInfo, sessions: number): StatusLine {
  switch (h.status) {
    case "connected":
      return { tone: "done", text: ["Connected", h.remote && h.daemon_version && `moonletd ${h.daemon_version}`, plural(sessions, "session")].filter(Boolean).join(" · ") };
    case "needs_install":
      return { tone: "error", text: "Needs install · no moonletd on the host" };
    case "error":
      return { tone: "error", text: h.message ?? "Can't connect" };
    case "reconnecting":
      return { tone: "blocked", text: "Reconnecting…" };
    default:
      return { tone: "blocked", text: "Connecting…" };
  }
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

/** The line under "Allow phones on my tailnet" (X39). */
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
