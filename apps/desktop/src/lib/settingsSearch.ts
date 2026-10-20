// Search across the settings page (X43): every setting with its page, the
// row it is on (`data-setting`) and its current value. Pure.

import { CLAUDE_MODES, PLAN_APPROVE_MODES, resolveMode, resolvePlanMode } from "./agents";
import { EDITOR_THEMES, resolveEditorTheme } from "./editorThemes";
import type { GitSettings, ProjectConfig, WorkspaceColor } from "./protocol";
import { routeKey, type SettingsRoute } from "./settingsPage";
import { ARCHIVE_BRANCHES, fetchLabel } from "./gitSettings";
import { ACTIONS, effectiveKeys, keyLabel } from "./runActions";
import { soundFor } from "./sounds";
import { bannerOn } from "./alerts";
import { originText } from "./addBoard";
import { trackerName } from "./tasks";
import { ROW_STYLES, rowStyle } from "./sessionRows";
import type { Settings } from "./store";
import { WORKSPACE_COLORS } from "./workspaces";
import type { TrackersConfig } from "./tasksStore";
import { GITHUB_RULES, RULE_SETTINGS, SYNC_INTERVALS } from "./trackersPage";

export interface SearchContext {
  settings: Settings;
  appVersion: string | null;
  claudeInstalled: string | null;
  /** This Mac's profiles, the default included. */
  profiles: number;
  remoteHosts: number;
  phones: number;
  /** `profile`: the name of the profile the workspace uses. */
  workspaces: { host: string; id: string; name: string; color: WorkspaceColor; profile: string }[];
  /** `config`: the project's `.moonlet/config.toml`, once read. */
  projects: { host: string; id: string; name: string; base_branch: string; config?: ProjectConfig | null }[];
  /** This Mac's Git settings (X55), once read. */
  git?: GitSettings | null;
  /** `trackers.toml` (X44), once read. */
  trackers?: TrackersConfig;
}

interface Entry {
  label: string;
  /** Other words that find it, such as "WebGL" for GPU rendering. */
  also?: string;
  path: string;
  route: SettingsRoute;
  /** The row's `data-setting`; none for a whole page. */
  setting?: string;
  value: string;
}

export interface SearchResult {
  key: string;
  /** The label around the match; `hit` is empty when another word matched. */
  before: string;
  hit: string;
  after: string;
  path: string;
  value: string;
  route: SettingsRoute;
  setting?: string;
}

const onOff = (on: boolean) => (on ? "On" : "Off");
const DEFAULT_AGENTS = [
  { id: "", label: "None (ask each time)" },
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
];
const n = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;
const labelOf = (list: readonly { id: string; label: string }[], id: string) => list.find((x) => x.id === id)?.label ?? id;

/** Settings › Task trackers rows as `[setting, label, value, also]`. */
function trackerEntries(t: TrackersConfig | undefined): [string | undefined, string, string, string?][] {
  if (!t) return [];
  return [
    [undefined, "Task trackers", "GitHub", "linear jira clickup issues connect"],
    ...GITHUB_RULES.map((r): [string, string, string] => [`rule-${r.id}`, `${r.when} → ${r.then}`, labelOf(RULE_SETTINGS, t.github.rules[r.id])]),
    ["branch-template", "Branch name for new sessions", t.github.branch_template || "{number}-{title}", "template"],
    ...[...new Set((t.connections ?? []).map((c) => c.kind))].map((kind): [string, string, string, string] => [
      `branch-template-${kind}`,
      `${trackerName(kind)} branch name for new sessions`,
      t[kind]?.branch_template || "{key}-{title}",
      "template",
    ]),
    ["branch-max", "Max length of branch names", String(t.github.max_length)],
    ["sync-interval", "Refresh issues", SYNC_INTERVALS.find((i) => i.value === t.sync.interval)?.label ?? `Every ${t.sync.interval} s`, "sync"],
    ["sync-notify", "Notify when a task changes state outside moonlet", onOff(t.sync.notify), "notification"],
    ["link-branch", "Link a session when its branch name contains the issue key", onOff(t.link?.branch ?? true), "linking"],
    ["link-pr", "Link a session when its pull request mentions the key or closes the issue", onOff(t.link?.pr ?? true), "linking"],
    ["link-title", "Suggest a task whose title is a session's name", onOff(t.link?.title ?? true), "linking"],
    // Boards (X50): the section, and each board by its name.
    ["boards", "Boards", `${(t.boards ?? []).length} ${(t.boards ?? []).length === 1 ? "board" : "boards"}`, "add board pin remove manage"],
    ...(t.boards ?? []).map((b): [string, string, string, string] => [`board-${b.id}`, b.name, originText(b.origin), "board"]),
  ];
}

/** Settings › Git rows (X55) as `[setting, label, value, also]`. */
function gitEntries(g: GitSettings | null | undefined): [string, string, string, string?][] {
  if (!g) return [];
  return [
    ["git-branch-prefix", "Branch prefix", g.branch_prefix || "None", "git new session"],
    ["git-start-from", "Start new branches from", g.start_from === "origin" ? "origin/main" : "main", "git new session base fetch"],
    ["git-worktrees", "Worktrees folder", "", "git reveal finder"],
    ["git-archive-worktree", "Worktree folder when archiving", g.archive_worktree === "keep" ? "Keep" : "Remove", "git archive remove keep"],
    ["git-archive-branch", "Local branch when archiving", ARCHIVE_BRANCHES.find((b) => b.id === g.archive_branch)?.label ?? g.archive_branch, "git archive delete merged"],
    ["git-delete-remote", "Also delete the branch on origin", onOff(g.delete_remote_branch), "git archive remote push"],
    ["git-warn-unpushed", "Warn before losing unpushed work", onOff(g.warn_unpushed), "git archive uncommitted push"],
    ["git-stage-all", "Stage all changes before committing", onOff(g.stage_all), "commit"],
    ["git-draft-prs", "Open pull requests as drafts", onOff(g.draft_prs), "pull request PR"],
    ["git-fetch", "Fetch from origin", fetchLabel(g.fetch_minutes), "git interval pull chip"],
    ["git-fast-forward", "Fast-forward base branches automatically", onOff(g.fast_forward_base), "git pull main"],
  ];
}

function index(c: SearchContext): Entry[] {
  const s = c.settings;
  const t = s.term;
  const app = (page: Exclude<SettingsRoute["page"], "workspace" | "project">, path: string, setting: string | undefined, label: string, value: string, also?: string): Entry => ({
    label,
    also,
    path,
    route: { page },
    setting,
    value,
  });
  const custom = Object.keys(s.shortcuts ?? {}).length;
  const keys = effectiveKeys(s.shortcuts);
  return [
    app("general", "App › General › Updates", "updates", "moonlet version and updates", c.appVersion ?? "", "check now update"),
    app("general", "App › General › Updates", "claude-update", "Claude Code version", c.claudeInstalled ?? ""),
    app("general", "App › General › Updates", "auto-update", "Check for updates automatically", onOff(s.autoUpdateCheck)),
    app("general", "App › General › Background daemon", "daemon", "Start the moonlet daemon at login", "", "launchd login items background items SMAppService"),
    app("appearance", "App › Appearance", "font-size", "Font size", `${t.fontSize}px`, "text zoom scale"),
    app("appearance", "App › Appearance", "editor-theme", "Colour theme of files and diffs", labelOf(EDITOR_THEMES, resolveEditorTheme(s.editorTheme)), "color syntax editor"),
    app("appearance", "App › Appearance", "session-rows", "Session rows", labelOf(ROW_STYLES, rowStyle(s.sessionRows)), "sidebar task issue number"),
    app("terminal", "App › Terminal", "font-family", "Font family", t.fontFamily.split(",")[0].replace(/"/g, "").trim(), "terminal font"),
    app("terminal", "App › Terminal", "new-shells", "New shells", t.classicPrompt ? "Classic" : "Blocks", "classic blocks prompt input editor"),
    app("terminal", "App › Terminal", "option-meta", "Use Option as Meta", onOff(t.optionIsMeta), "alt"),
    app("terminal", "App › Terminal", "osc52", "Let programs write to the clipboard", onOff(t.allowOsc52), "OSC 52 copy"),
    app("terminal", "App › Terminal", "webgl", "GPU rendering", onOff(t.webgl), "WebGL"),
    app("agents", "App › Agents", "default-mode", "Default permission mode for new Claude sessions", labelOf(CLAUDE_MODES, resolveMode(s.defaultMode))),
    app("agents", "App › Agents", "plan-approve", "When a plan is approved, switch to", labelOf(PLAN_APPROVE_MODES, resolvePlanMode(s.planApproveMode))),
    app("agents", "App › Agents", "tool-calls", "Tool calls in the conversation", s.toolCalls === "expanded" ? "Expanded" : "Collapsed"),
    app("notifications", "App › Notifications", "notify-focused", "Notify even while moonlet is focused", onOff(s.notifyWhenFocused), "desktop notification"),
    app("notifications", "App › Notifications", "banner-blocked", "Notification when an agent needs you", onOff(bannerOn(s.banners, "blocked")), "desktop banner"),
    app("notifications", "App › Notifications", "banner-done", "Notification when an agent is done", onOff(bannerOn(s.banners, "done")), "desktop banner"),
    app("notifications", "App › Notifications", "banner-error", "Notification when an agent fails", onOff(bannerOn(s.banners, "error")), "desktop banner"),
    app("notifications", "App › Notifications", "muted", "Mute all sounds", onOff(!!s.muted), "silence quiet bell"),
    app("notifications", "App › Notifications", "sound-blocked", "Sound when an agent needs you", soundFor(s.sounds, "blocked") ?? "Off"),
    app("notifications", "App › Notifications", "sound-done", "Sound when an agent is done", soundFor(s.sounds, "done") ?? "Off"),
    app("notifications", "App › Notifications", "sound-error", "Sound when an agent fails", soundFor(s.sounds, "error") ?? "Off"),
    ...gitEntries(c.git).map(([setting, label, value, also]) => app("git", "App › Git", setting, label, value, also)),
    ...trackerEntries(c.trackers).map(([setting, label, value, also]) => app("trackers", "App › Task trackers", setting, label, value, also)),
    app("shortcuts", "App › Keyboard shortcuts", undefined, "Keyboard shortcuts", custom ? `${custom} custom` : "", "keys bindings"),
    ...ACTIONS.map((a) => app("shortcuts", "App › Keyboard shortcuts", `shortcut-${a.id}`, a.label, keys[a.id] ? keyLabel(keys[a.id]) : "Not set", "shortcut key")),
    app("profiles", "Claude Code › Profiles", undefined, "Claude profiles", n(c.profiles, "profile"), "sign in account"),
    app("hooks", "Claude Code › Hooks", undefined, "Claude Code hooks", "", "Codex skill install"),
    app("hosts", "Machines › Hosts", undefined, "Remote hosts", n(c.remoteHosts, "host"), "ssh helper"),
    app("phones", "Machines › Phones", "phones", "Allow phones on my tailnet", "", "mobile pair Tailscale"),
    ...c.workspaces.flatMap((w): Entry[] => {
      const route: SettingsRoute = { page: "workspace", host: w.host, id: w.id };
      const path = `Workspaces › ${w.name}`;
      return [
        { label: "Workspace name", path, route, setting: "ws-name", value: w.name },
        { label: "Workspace colour", also: "color", path, route, setting: "ws-color", value: labelOf(WORKSPACE_COLORS, w.color) },
        { label: "Claude profile", path, route, setting: "ws-profile", value: w.profile },
        { label: "Delete workspace", path, route, setting: "ws-delete", value: "" },
      ];
    }),
    ...c.projects.flatMap((p): Entry[] => {
      const route: SettingsRoute = { page: "project", host: p.host, id: p.id };
      const path = `Projects › ${p.name}`;
      const cfg = p.config;
      // Unknown until the config has been read: no value rather than a wrong one.
      const script = (v: string | null | undefined) => (cfg ? v?.trim() || "Not set" : "");
      const agents = cfg ? Object.keys(cfg.agents ?? {}).length : 0;
      return [
        { label: "Setup script", path, route, setting: "project-setup", value: script(cfg?.setup) },
        { label: "Run script", path, route, setting: "project-run", value: script(cfg?.run) },
        { label: "Archive script", path, route, setting: "project-archive", value: script(cfg?.archive) },
        { label: "Default agent", path, route, setting: "project-default-agent", value: cfg ? labelOf(DEFAULT_AGENTS, cfg.default_agent ?? "") : "" },
        { label: "Custom agents", path, route, setting: "project-agents", value: cfg ? (agents ? n(agents, "agent") : "None") : "" },
        { label: "Base branch", path, route, setting: "project-base", value: cfg?.base_branch?.trim() || p.base_branch },
        { label: "Branch prefix", path, route, setting: "project-branch-prefix", value: cfg?.branch_prefix?.trim() ?? "", also: "git" },
      ];
    }),
  ];
}

/** Settings whose name (or another word for them) contains `q`, in page order. */
export function searchSettings(q: string, c: SearchContext): SearchResult[] {
  const query = q.trim().toLowerCase();
  if (!query) return [];
  return index(c).flatMap((e): SearchResult[] => {
    const at = e.label.toLowerCase().indexOf(query);
    const base = { key: `${routeKey(e.route)}:${e.setting ?? ""}`, path: e.path, value: e.value, route: e.route, ...(e.setting ? { setting: e.setting } : {}) };
    if (at >= 0) return [{ ...base, before: e.label.slice(0, at), hit: e.label.slice(at, at + query.length), after: e.label.slice(at + query.length) }];
    if (e.also?.toLowerCase().includes(query)) return [{ ...base, before: e.label, hit: "", after: "" }];
    return [];
  });
}

/** The result ↑ or ↓ moves to from `index` of `count`; null for other keys. */
export function moveSelection(index: number, count: number, key: string): number | null {
  if (key === "ArrowDown") return Math.min(count - 1, index + 1);
  if (key === "ArrowUp") return Math.max(0, index - 1);
  return null;
}
