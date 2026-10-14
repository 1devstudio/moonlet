import { describe, expect, it } from "vitest";
import { appUpdateLine, claudeUpdateLine, daemonLine, escapeAction, hookRows, hooksDone, phoneAccessLine, radioKey, settingsCrumbs, hostLine, profileLine, profilesNeedSignIn, settingsNav } from "./settingsPage";
import type { HookStatus, HostInfo, MobileStatus, ProfileAccount, ProfileInfo, Workspace } from "./protocol";

describe("settings nav (X43)", () => {
  it("lists the app, Claude Code and machine pages with their counts", () => {
    expect(settingsNav({ remoteHosts: 2, phones: 1, profilesNeedSignIn: true })).toEqual([
      {
        title: "App",
        entries: [
          { page: "general", label: "General" },
          { page: "appearance", label: "Appearance" },
          { page: "terminal", label: "Terminal" },
          { page: "agents", label: "Agents" },
          { page: "notifications", label: "Notifications" },
        ],
      },
      {
        title: "Claude Code",
        entries: [
          { page: "profiles", label: "Profiles", dot: "a profile is not signed in" },
          { page: "hooks", label: "Hooks" },
        ],
      },
      {
        title: "Machines",
        entries: [
          { page: "hosts", label: "Hosts", count: 2 },
          { page: "phones", label: "Phones", count: 1 },
        ],
      },
    ]);
  });

  it("shows no count of zero and no dot when every profile in use is signed in", () => {
    const [, claude, machines] = settingsNav({ remoteHosts: 0, phones: 0, profilesNeedSignIn: false });
    expect(claude.entries[0]).toEqual({ page: "profiles", label: "Profiles" });
    expect(machines.entries).toEqual([
      { page: "hosts", label: "Hosts" },
      { page: "phones", label: "Phones" },
    ]);
  });
});

describe("profiles that need a sign-in (X43)", () => {
  const ws = (name: string, claude_profile: string | null): Workspace => ({ id: name.toLowerCase(), name, color: "clay", section_ids: [], created_at: 0, claude_profile });
  const account = (logged_in: boolean): ProfileAccount => ({ logged_in, email: logged_in ? "dev@example.com" : null, org_name: null });
  const profile = (id: string, a: ProfileAccount | null): ProfileInfo => ({ id, name: id, path: `/Users/alex/.claude-${id}`, created_at: 0, account: a, hooks_installed: true });

  it("is true when a workspace uses a signed-out profile", () => {
    expect(profilesNeedSignIn([ws("Personal", null), ws("Acme", "work")], [profile("work", account(false))], account(true))).toBe(true);
  });

  it("is true when a workspace uses the default profile and it is signed out", () => {
    expect(profilesNeedSignIn([ws("Personal", null)], [], account(false))).toBe(true);
  });

  it("is false for a signed-out profile no workspace uses, or one still being checked", () => {
    expect(profilesNeedSignIn([ws("Personal", null)], [profile("console", account(false))], account(true))).toBe(false);
    expect(profilesNeedSignIn([ws("Acme", "work")], [profile("work", null)], null)).toBe(false);
  });
});

describe("General's background daemon line (X43)", () => {
  const plist = "/Users/alex/Library/LaunchAgents/dev.onedevstudio.moonlet.daemon.plist";

  it("names launchd and the plist when the daemon runs under it", () => {
    expect(daemonLine({ installed: true, loaded: true, plist }, "/Users/alex")).toEqual({
      tone: "done",
      text: "Running under launchd",
      path: "~/Library/LaunchAgents/dev.onedevstudio.moonlet.daemon.plist",
    });
  });

  it("warns when the login item is installed but not loaded", () => {
    expect(daemonLine({ installed: true, loaded: false, plist }, "/Users/alex")).toEqual({
      tone: "blocked",
      text: "Installed but not loaded",
      path: "~/Library/LaunchAgents/dev.onedevstudio.moonlet.daemon.plist",
    });
  });

  it("says the daemon only runs with the app when there is no login item", () => {
    expect(daemonLine({ installed: false, loaded: false, plist }, "/Users/alex")).toEqual({ tone: "muted", text: "Not installed: moonletd runs while moonlet is open" });
  });
});

describe("a host's line on the Hosts page (X43)", () => {
  const host = (patch: Partial<HostInfo>): HostInfo => ({ id: "devbox", label: "devbox", remote: true, status: "connected", message: null, daemon_version: "0.1.16", hostname: null, home: null, ...patch });

  it("shows the daemon's version and the session count when connected", () => {
    expect(hostLine(host({}), 2)).toEqual({ tone: "done", text: "Connected · moonletd 0.1.16 · 2 sessions" });
    expect(hostLine(host({}), 1)).toEqual({ tone: "done", text: "Connected · moonletd 0.1.16 · 1 session" });
  });

  it("leaves the version out for this Mac", () => {
    expect(hostLine(host({ id: "local", remote: false }), 7)).toEqual({ tone: "done", text: "Connected · 7 sessions" });
  });

  it("says a host without moonletd needs the helper", () => {
    expect(hostLine(host({ status: "needs_install", daemon_version: null }), 0)).toEqual({ tone: "error", text: "Needs install · no moonletd on the host" });
  });

  it("shows the error, and the connection state while it connects", () => {
    expect(hostLine(host({ status: "error", message: "ssh: Could not resolve hostname devbox" }), 0)).toEqual({ tone: "error", text: "ssh: Could not resolve hostname devbox" });
    expect(hostLine(host({ status: "reconnecting" }), 2)).toEqual({ tone: "blocked", text: "Reconnecting…" });
    expect(hostLine(host({ status: "connecting" }), 0)).toEqual({ tone: "blocked", text: "Connecting…" });
  });
});

describe("a profile's line on the Profiles page (X43)", () => {
  const signedIn: ProfileAccount = { logged_in: true, email: "ops@example.com", org_name: "Example Org" };
  const signedOut: ProfileAccount = { logged_in: false, email: null, org_name: null };

  it("names the account", () => {
    expect(profileLine(signedIn, ["Personal"])).toEqual({ tone: "muted", text: "Signed in as ops@example.com · Example Org" });
  });

  it("says so when no workspace uses the profile", () => {
    expect(profileLine(signedIn, [])).toEqual({ tone: "muted", text: "Signed in as ops@example.com · Example Org · not used by a workspace" });
  });

  it("warns which workspaces can't start Claude when signed out", () => {
    expect(profileLine(signedOut, ["Acme"])).toEqual({ tone: "blocked", text: "Not signed in · Acme's sessions can't start Claude" });
    expect(profileLine(signedOut, ["Acme", "Personal"])).toEqual({ tone: "blocked", text: "Not signed in · sessions in Acme and Personal can't start Claude" });
  });

  it("is quiet for a signed-out profile nobody uses, and while checking", () => {
    expect(profileLine(signedOut, [])).toEqual({ tone: "muted", text: "Not signed in · not used by a workspace" });
    expect(profileLine(null, ["Acme"])).toEqual({ tone: "muted", text: "Checking…" });
  });
});

describe("the Hooks page's rows (X43)", () => {
  const status = (patch: Partial<HookStatus>): HookStatus => ({
    claude_settings: "/Users/alex/.claude/settings.json",
    claude_installed: true,
    claude_missing_events: [],
    codex_config: "/Users/alex/.codex/config.toml",
    codex_installed: false,
    codex_conflict: null,
    claude_skill: true,
    codex_skill: false,
    ...patch,
  });

  it("shows Claude Code's state hooks and skill, and Codex not installed", () => {
    expect(hookRows(status({}), "/Users/alex")).toEqual([
      { agent: "claude", name: "Claude Code", state: { tone: "done", text: "Installed" }, path: "~/.claude/settings.json", parts: [{ label: "State hooks", ok: true }, { label: "moonlet skill", ok: true }] },
      { agent: "codex", name: "Codex", state: { tone: "muted", text: "Not installed" }, path: "~/.codex/config.toml", parts: [] },
    ]);
  });

  it("marks what is missing from a partial Claude Code install", () => {
    const [claude] = hookRows(status({ claude_installed: false, claude_missing_events: ["SubagentStop"], claude_skill: true }), "/Users/alex");
    expect(claude.state).toEqual({ tone: "muted", text: "Not installed" });
    expect(claude.parts).toEqual([{ label: "State hooks", ok: false }, { label: "moonlet skill", ok: true }]);
  });

  it("names the other notify command when Codex was skipped", () => {
    const [, codex] = hookRows(status({ codex_conflict: "terminal-notifier" }), "/Users/alex");
    expect(codex.state).toEqual({ tone: "blocked", text: 'Skipped: already notifies "terminal-notifier"' });
  });

  it("has nothing left to install once Claude Code is in and Codex is in or skipped", () => {
    expect(hooksDone(status({ codex_installed: true }))).toBe(true);
    expect(hooksDone(status({ codex_conflict: "terminal-notifier" }))).toBe(true);
    expect(hooksDone(status({}))).toBe(false);
    expect(hooksDone(status({ claude_installed: false, codex_installed: true }))).toBe(false);
  });

  it("keeps Install available when the status could not be read", () => {
    expect(hooksDone(null)).toBe(false);
  });

  it("lists Codex's notify hook and skill once installed", () => {
    const [, codex] = hookRows(status({ codex_installed: true, codex_skill: true }), "/Users/alex");
    expect(codex).toEqual({ agent: "codex", name: "Codex", state: { tone: "done", text: "Installed" }, path: "~/.codex/config.toml", parts: [{ label: "Notify hook", ok: true }, { label: "moonlet skill", ok: true }] });
  });
});

describe("the settings header's breadcrumb (X43)", () => {
  it("names an app page under Settings", () => {
    expect(settingsCrumbs({ page: "general" })).toEqual(["Settings", "General"]);
    expect(settingsCrumbs({ page: "notifications" })).toEqual(["Settings", "Notifications"]);
  });

  it("puts the other pages under their group", () => {
    expect(settingsCrumbs({ page: "profiles" })).toEqual(["Settings", "Claude Code", "Profiles"]);
    expect(settingsCrumbs({ page: "hooks" })).toEqual(["Settings", "Claude Code", "Hooks"]);
    expect(settingsCrumbs({ page: "phones" })).toEqual(["Settings", "Machines", "Phones"]);
  });
});

describe("what Esc does on the settings page (X43)", () => {
  it("closes the page from anywhere else", () => {
    expect(escapeAction({ dialogShown: false, editable: false })).toBe("close");
  });

  it("leaves a text field first, so its own Esc (such as cancelling a rename) runs", () => {
    expect(escapeAction({ dialogShown: false, editable: true })).toBe("leave-field");
  });

  it("does nothing while a dialog or the confirm modal is over the page, wherever focus is", () => {
    expect(escapeAction({ dialogShown: true, editable: false })).toBe("ignore");
    expect(escapeAction({ dialogShown: true, editable: true })).toBe("ignore");
  });
});

describe("arrow keys in a radio group (X43)", () => {
  it("moves to the next option with → and ↓, wrapping at the end", () => {
    expect(radioKey("ArrowRight", 0, 4)).toBe(1);
    expect(radioKey("ArrowDown", 3, 4)).toBe(0);
  });

  it("moves to the previous option with ← and ↑, wrapping at the start", () => {
    expect(radioKey("ArrowLeft", 2, 4)).toBe(1);
    expect(radioKey("ArrowUp", 0, 4)).toBe(3);
  });

  it("jumps to the ends with Home and End, and ignores other keys", () => {
    expect(radioKey("Home", 2, 4)).toBe(0);
    expect(radioKey("End", 1, 4)).toBe(3);
    expect(radioKey("Enter", 1, 4)).toBeNull();
  });
});

describe("General's update lines (X43)", () => {
  it("is green when moonlet is up to date and accent when a release is waiting", () => {
    expect(appUpdateLine({ phase: "current" }, false, null)).toEqual({ tone: "done", text: "Up to date" });
    expect(appUpdateLine({ phase: "available", version: "0.1.18" }, false, null)).toEqual({ tone: "accent", text: "0.1.18 is available" });
    expect(appUpdateLine({ phase: "ready", version: "0.1.18" }, false, null)).toEqual({ tone: "accent", text: "0.1.18 is installed" });
  });

  it("warns with a failed check's error, and is quiet while checking or before any check", () => {
    expect(appUpdateLine({ phase: "current" }, false, "Could not reach github.com")).toEqual({ tone: "blocked", text: "Could not reach github.com" });
    expect(appUpdateLine({ phase: "current" }, true, null)).toEqual({ tone: "muted", text: "Checking…" });
    expect(appUpdateLine({ phase: "idle" }, false, null)).toBeNull();
  });

  it("offers Claude Code's newer release, and warns when claude is missing", () => {
    expect(claudeUpdateLine({ phase: "idle" }, { installed: "2.1.292", latest: "2.1.301" }, false)).toEqual({ tone: "accent", text: "2.1.301 is available" });
    expect(claudeUpdateLine({ phase: "idle" }, { installed: "2.1.301", latest: "2.1.301" }, false)).toEqual({ tone: "done", text: "Up to date" });
    expect(claudeUpdateLine({ phase: "idle" }, { installed: null, latest: "2.1.301" }, false)).toEqual({ tone: "blocked", text: "Not found on the PATH" });
    expect(claudeUpdateLine({ phase: "idle" }, { installed: null, latest: null }, true)).toEqual({ tone: "muted", text: "Checking…" });
  });
});

describe("the Phones page's access line (X43)", () => {
  const st = (patch: Partial<MobileStatus>): MobileStatus => ({ enabled: true, port: 7878, tailscale: true, addresses: ["100.64.0.2"], listening: ["100.64.0.2:7878"], host: "studio-mini", devices: [], ...patch });

  it("is green while listening", () => {
    expect(phoneAccessLine(st({}))).toEqual({ tone: "done", text: "Listening on 100.64.0.2:7878" });
  });

  it("warns when Tailscale is not running, and is quiet when off or starting", () => {
    expect(phoneAccessLine(st({ tailscale: false, listening: [] }))).toEqual({ tone: "blocked", text: "Tailscale is not running on this Mac" });
    expect(phoneAccessLine(st({ enabled: false, listening: [] }))).toEqual({ tone: "muted", text: "Off" });
    expect(phoneAccessLine(st({ listening: [] }))).toEqual({ tone: "muted", text: "Starting…" });
  });
});
