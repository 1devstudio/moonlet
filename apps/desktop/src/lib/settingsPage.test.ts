import { describe, expect, it } from "vitest";
import { accountNote, hostOrder, installHooksMessage, saveKeySaves, appUpdateLine, claudeUpdateLine, daemonHint, daemonLine, daemonOn, daemonToast, offStopsDaemon, opensLoginItems, escapeAction, hookRows, hooksDone, phoneAccessLine, radioKey, routeKey, settingsCrumbs, hostActions, hostLine, hostNotice, updateCommand, profileLine, removeAsks, profilesNeedSignIn, settingsNav, settingsWorkspaces, activeNavKey } from "./settingsPage";
import type { HookStatus, HostInfo, MobileStatus, ProfileAccount, ProfileInfo, Workspace } from "./protocol";

describe("settings nav (X43)", () => {
  const app = (page: string, label: string, extra = {}) => ({ key: page, route: { page }, label, ...extra });
  const none = { remoteHosts: 0, phones: 0, profilesNeedSignIn: false, workspaces: [], projects: [] };

  it("lists the app, Claude Code and machine pages with their counts", () => {
    expect(settingsNav({ ...none, remoteHosts: 2, phones: 1, profilesNeedSignIn: true })).toEqual([
      {
        title: "App",
        entries: [app("general", "General"), app("appearance", "Appearance"), app("terminal", "Terminal"), app("agents", "Agents"), app("git", "Git"), app("notifications", "Notifications"), app("trackers", "Task trackers"), app("shortcuts", "Keyboard shortcuts")],
      },
      { title: "Claude Code", entries: [app("profiles", "Profiles", { dot: "a profile is not signed in" }), app("hooks", "Hooks")] },
      { title: "Machines", entries: [app("hosts", "Hosts", { count: 2 }), app("workers", "Workers"), app("cloud", "Cloud workers"), app("phones", "Phones", { count: 1 })] },
    ]);
  });

  it("names the central host whose workers the Workers page shows (X62)", () => {
    const [, , machines] = settingsNav({ ...none, central: "studio-mini" });
    expect(machines.entries[1]).toEqual(app("workers", "Workers", { host: "studio-mini" }));
  });

  it("lists Cloud workers on the central host, with a dot while a machine is not removed (X63)", () => {
    const [, , machines] = settingsNav({ ...none, central: "studio-mini", cloudRemovalFailed: true });
    expect(machines.entries[2]).toEqual(app("cloud", "Cloud workers", { host: "studio-mini", dot: "a cloud machine could not be removed" }));
    expect(settingsNav({ ...none, central: "studio-mini" })[2].entries[2]).toEqual(app("cloud", "Cloud workers", { host: "studio-mini" }));
    expect(settingsCrumbs({ page: "cloud" })).toEqual(["Settings", "Machines", "Cloud workers"]);
  });

  it("shows no count of zero and no dot when every profile in use is signed in", () => {
    const [, claude, machines] = settingsNav(none);
    expect(claude.entries[0]).toEqual(app("profiles", "Profiles"));
    expect(machines.entries).toEqual([app("hosts", "Hosts"), app("workers", "Workers"), app("cloud", "Cloud workers"), app("phones", "Phones")]);
  });

  it("lists every workspace and project, naming the host of remote ones", () => {
    const groups = settingsNav({
      ...none,
      workspaces: [
        { host: "local", id: "personal", name: "Personal", color: "clay", remote: null },
        { host: "devbox", id: "acme", name: "Acme", color: "blue", remote: "devbox" },
      ],
      projects: [
        { host: "local", id: "p1", name: "storefront", remote: null },
        { host: "devbox", id: "p2", name: "payments-api", remote: "devbox" },
      ],
    });
    expect(groups.slice(3)).toEqual([
      {
        title: "Workspaces",
        entries: [
          { key: "ws:local:personal", route: { page: "workspace", host: "local", id: "personal" }, label: "Personal", mark: "clay" },
          { key: "ws:devbox:acme", route: { page: "workspace", host: "devbox", id: "acme" }, label: "Acme", mark: "blue", host: "devbox" },
        ],
      },
      {
        title: "Projects",
        entries: [
          { key: "project:local:p1", route: { page: "project", host: "local", id: "p1" }, label: "storefront" },
          { key: "project:devbox:p2", route: { page: "project", host: "devbox", id: "p2" }, label: "payments-api", host: "devbox" },
        ],
      },
    ]);
  });
});

describe("the workspaces settings lists (X68)", () => {
  const ws = (id: string, name: string): Workspace => ({ id, name, color: "clay", section_ids: [], created_at: 0, claude_profile: null });
  const personal = ws("c05254bf1786", "Personal");
  const mini = ws("fe2837aa4788", "Personal Mini");

  it("lists each workspace of an account once, this Mac's copy first and untagged, and a host outside the account apart under its name", () => {
    const devbox = ws("c05254bf1786", "Personal");
    expect(
      settingsWorkspaces([
        { host: "studio-mini", label: "studio-mini", remote: true, account: "8605e2c4", workspaces: [personal, mini] },
        { host: "devbox", label: "devbox", remote: true, workspaces: [devbox] },
        { host: "local", label: "This Mac", remote: false, account: "8605e2c4", workspaces: [personal, mini] },
      ]),
    ).toEqual([
      { host: "local", id: "c05254bf1786", account: "8605e2c4", ws: personal, remote: null },
      { host: "local", id: "fe2837aa4788", account: "8605e2c4", ws: mini, remote: null },
      { host: "devbox", id: "c05254bf1786", account: "devbox", ws: devbox, remote: "devbox" },
    ]);
  });

  it("lists a shared workspace from another member, untagged, while this Mac does not list it yet", () => {
    const fresh = ws("a1b2c3d4e5f6", "Acme");
    expect(
      settingsWorkspaces([
        { host: "local", label: "This Mac", remote: false, account: "8605e2c4", workspaces: [] },
        { host: "studio-mini", label: "studio-mini", remote: true, account: "8605e2c4", workspaces: [fresh] },
      ]),
    ).toEqual([{ host: "studio-mini", id: "a1b2c3d4e5f6", account: "8605e2c4", ws: fresh, remote: null }]);
  });

  it("highlights a shared workspace's entry when its page is open on another member's copy", () => {
    const listed = [
      { host: "local", id: "c05254bf1786", account: "8605e2c4" },
      { host: "devbox", id: "c05254bf1786", account: "devbox" },
    ];
    expect(activeNavKey({ page: "workspace", host: "studio-mini", id: "c05254bf1786" }, listed, "8605e2c4")).toBe("ws:local:c05254bf1786");
    expect(activeNavKey({ page: "workspace", host: "devbox", id: "c05254bf1786" }, listed, "devbox")).toBe("ws:devbox:c05254bf1786");
    expect(activeNavKey({ page: "hooks" }, listed, "local")).toBe("hooks");
  });
});

describe("the nav entry a page belongs to (X43)", () => {
  it("is the entry with the route's key, whatever the focus", () => {
    expect(routeKey({ page: "hooks" })).toBe("hooks");
    expect(routeKey({ page: "workspace", host: "devbox", id: "acme" })).toBe("ws:devbox:acme");
    expect(routeKey({ page: "project", host: "local", id: "p1", focus: "run" })).toBe("project:local:p1");
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

describe("General's background daemon line (X43, X56)", () => {
  const plist = "/Users/alex/Library/LaunchAgents/dev.onedevstudio.moonlet.daemon.plist";
  const viaPlist = (state: "loaded" | "installed" | "not_installed") => ({ mechanism: "plist" as const, state, plist });
  const viaLoginItem = (state: "enabled" | "requires_approval" | "not_registered" | "not_found") => ({ mechanism: "login_item" as const, state });

  it("points at Login Items when the login item starts the daemon", () => {
    expect(daemonLine(viaLoginItem("enabled"), "/Users/alex")).toEqual({ tone: "done", text: "Starts at login · moonlet in System Settings › Login Items" });
  });

  it("says when the login item was switched off in System Settings", () => {
    expect(daemonLine(viaLoginItem("requires_approval"), "/Users/alex")).toEqual({ tone: "blocked", text: "Turned off in System Settings › Login Items" });
  });

  it("says the daemon only runs with the app when the login item is not registered", () => {
    expect(daemonLine(viaLoginItem("not_registered"), "/Users/alex")).toEqual({ tone: "muted", text: "Not starting at login: moonletd runs while moonlet is open" });
  });

  it("says when macOS cannot find the login item", () => {
    expect(daemonLine(viaLoginItem("not_found"), "/Users/alex")).toEqual({ tone: "error", text: "macOS cannot find moonlet's login item. Reinstall moonlet." });
    expect(daemonOn(viaLoginItem("not_found"))).toBe(false);
  });

  it("explains the toggle in the words of the mechanism", () => {
    expect(daemonHint(viaLoginItem("enabled"))).toBe("Agents run in moonletd, not in this window. As a login item it starts at login and restarts if it ever crashes.");
    expect(daemonHint(viaPlist("loaded"))).toBe("Agents run in moonletd, not in this window. Under launchd it starts at login and restarts if it ever crashes.");
    expect(daemonHint(null)).toBe("Agents run in moonletd, not in this window. As a login item it starts at login and restarts if it ever crashes.");
  });

  it("names launchd and the plist when the daemon runs under it", () => {
    expect(daemonLine(viaPlist("loaded"), "/Users/alex")).toEqual({
      tone: "done",
      text: "Running under launchd",
      path: "~/Library/LaunchAgents/dev.onedevstudio.moonlet.daemon.plist",
    });
  });

  it("warns when the plist is installed but not loaded", () => {
    expect(daemonLine(viaPlist("installed"), "/Users/alex")).toEqual({
      tone: "blocked",
      text: "Installed but not loaded",
      path: "~/Library/LaunchAgents/dev.onedevstudio.moonlet.daemon.plist",
    });
  });

  it("says the daemon only runs with the app when there is no plist", () => {
    expect(daemonLine(viaPlist("not_installed"), "/Users/alex")).toEqual({ tone: "muted", text: "Not installed: moonletd runs while moonlet is open" });
  });

  it("shows the toggle on only while something starts the daemon at login", () => {
    expect(daemonOn(viaLoginItem("enabled"))).toBe(true);
    expect(daemonOn(viaLoginItem("requires_approval"))).toBe(false);
    expect(daemonOn(viaLoginItem("not_registered"))).toBe(false);
    expect(daemonOn(viaPlist("loaded"))).toBe(true);
    expect(daemonOn(viaPlist("installed"))).toBe(true);
    expect(daemonOn(viaPlist("not_installed"))).toBe(false);
  });

  it("offers Open Login Items only when the login item was switched off there", () => {
    expect(opensLoginItems(viaLoginItem("requires_approval"))).toBe(true);
    expect(opensLoginItems(viaLoginItem("enabled"))).toBe(false);
    expect(opensLoginItems(viaLoginItem("not_registered"))).toBe(false);
    expect(opensLoginItems(viaPlist("installed"))).toBe(false);
  });

  it("says what turning the toggle did, or that macOS still needs the user", () => {
    expect(daemonToast(true, viaLoginItem("enabled"))).toBe("The moonlet daemon now starts at login");
    expect(daemonToast(true, viaLoginItem("requires_approval"))).toBe("Allow moonlet in System Settings › Login Items");
    expect(daemonToast(true, viaPlist("loaded"))).toBe("The moonlet daemon now starts at login");
    expect(daemonToast(false, viaLoginItem("not_registered"))).toBe("Login item removed");
  });

  it("asks before turning off only when that stops the daemon launchd runs", () => {
    expect(offStopsDaemon(viaLoginItem("enabled"))).toBe(true);
    expect(offStopsDaemon(viaLoginItem("requires_approval"))).toBe(false);
    expect(offStopsDaemon(viaPlist("loaded"))).toBe(true);
    expect(offStopsDaemon(viaPlist("installed"))).toBe(false);
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

describe("a tailnet host's line (X57)", () => {
  const host = (patch: Partial<HostInfo>): HostInfo => ({ id: "studio-mini", label: "studio-mini", remote: true, kind: "tailnet", status: "connected", message: null, daemon_version: "0.1.26", hostname: null, home: null, ...patch });

  it("says which side to update when the protocols differ", () => {
    expect(hostLine(host({ status: "needs_update", daemon_version: "0.1.26" }), 0, "0.1.30")).toEqual({
      tone: "error",
      text: "Update moonlet on studio-mini (it runs 0.1.26, this Mac 0.1.30)",
    });
    expect(hostLine(host({ status: "needs_update", daemon_version: "0.1.30" }), 0, "0.1.26")).toEqual({
      tone: "error",
      text: "Update moonlet on this Mac (studio-mini runs 0.1.30)",
    });
    // 0.1.9 is older than 0.1.10.
    expect(hostLine(host({ status: "needs_update", daemon_version: "0.1.9" }), 0, "0.1.10").text).toBe("Update moonlet on studio-mini (it runs 0.1.9, this Mac 0.1.10)");
  });

  it("says how to update a Linux host and a Mac (X58)", () => {
    const linux = host({ id: "build-box", label: "build-box", status: "needs_update", daemon_version: "0.1.26", os: "linux" });
    expect(hostLine(linux, 0, "0.1.30").text).toBe("Update moonlet on build-box (it runs 0.1.26, this Mac 0.1.30): run this there");
    expect(updateCommand(linux, "0.1.30")).toBe("curl -fsSL https://github.com/1devstudio/moonlet/releases/latest/download/install.sh | sh");
    const mac = host({ status: "needs_update", daemon_version: "0.1.26", os: "macos" });
    expect(hostLine(mac, 0, "0.1.30").text).toBe("Update moonlet on studio-mini (it runs 0.1.26, this Mac 0.1.30) from its Settings › Updates");
    expect(updateCommand(mac, "0.1.30")).toBeNull();
    // This Mac is the older one: nothing to run on the host.
    expect(updateCommand({ ...linux, daemon_version: "0.1.31" }, "0.1.30")).toBeNull();
  });

  it("says a host that removed this Mac needs pairing again", () => {
    expect(hostLine(host({ status: "refused", message: "this phone is not paired with this Mac" }), 0, "0.1.30")).toEqual({
      tone: "error",
      text: "studio-mini no longer accepts this Mac. Pair it again.",
    });
  });

  it("says only which host to update when both run the same version", () => {
    // Development builds can differ in protocol at the same version.
    expect(hostLine(host({ status: "needs_update", daemon_version: "0.1.30" }), 0, "0.1.30").text).toBe("Update moonlet on studio-mini");
  });

  it("offers Retry where waiting is all the host does, and Pair again where it refused", () => {
    expect(hostActions(host({ status: "needs_update" }))).toEqual(["retry"]);
    expect(hostActions(host({ status: "refused" }))).toEqual(["pair-again"]);
    expect(hostActions(host({ status: "connected" }))).toEqual([]);
    expect(hostActions(host({ status: "error", message: "cannot reach the host over Tailscale" }))).toEqual(["retry"]);
    expect(hostActions(host({ kind: "ssh", status: "needs_install" }))).toEqual(["install"]);
    expect(hostActions(host({ kind: "ssh", status: "connected" }))).toEqual(["reinstall"]);
    expect(hostActions(host({ kind: "ssh", status: "error", message: "ssh: Could not resolve hostname" }))).toEqual(["retry"]);
  });

  it("asks before removing a tailnet host it cannot tell", () => {
    expect(removeAsks(host({ status: "connected" }))).toBeNull();
    expect(removeAsks(host({ status: "reconnecting" }))).toEqual({
      title: "Remove studio-mini?",
      message: "studio-mini will still list this Mac until you remove it there.",
    });
    expect(removeAsks(host({ kind: "ssh", status: "error" }))).toBeNull();
  });

  it("puts the same words in the sidebar's notice", () => {
    expect(hostNotice(host({}), "0.1.30")).toBeNull();
    expect(hostNotice(host({ status: "needs_update", daemon_version: "0.1.26" }), "0.1.30")).toBe("Update moonlet on studio-mini (it runs 0.1.26, this Mac 0.1.30)");
    expect(hostNotice(host({ status: "refused", message: "this phone is not paired with this Mac" }), "0.1.30")).toBe(
      "studio-mini no longer accepts this Mac. Pair it again.",
    );
    expect(hostNotice(host({ kind: "ssh", status: "needs_install" }), "0.1.30")).toBe("studio-mini: helper not installed");
    expect(hostNotice(host({ status: "error", message: null }), "0.1.30")).toBe("studio-mini: connection failed");
    expect(hostNotice(host({ status: "error", message: "ssh: Could not resolve hostname" }), "0.1.30")).toBe("studio-mini: ssh: Could not resolve hostname");
    expect(hostNotice(host({ status: "reconnecting" }), "0.1.30")).toBe("studio-mini: reconnecting…");
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

  it("names the files Install hooks changes", () => {
    expect(installHooksMessage(status({}))).toBe(
      'moonlet will add its hooks to:\n• /Users/alex/.claude/settings.json\n• /Users/alex/.codex/config.toml\n\nand a "moonlet" skill to the skills folder next to each.\n\nA backup of each file is written first and your own settings are kept.',
    );
  });

  it("names Claude Code's and Codex's settings when the status could not be read", () => {
    expect(installHooksMessage(null)).toBe(
      'moonlet will add its hooks to Claude Code\'s and Codex\'s settings, and a "moonlet" skill next to each.\n\nA backup of each file is written first and your own settings are kept.',
    );
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
    expect(settingsCrumbs({ page: "shortcuts" })).toEqual(["Settings", "Keyboard shortcuts"]);
  });

  it("puts the other pages under their group", () => {
    expect(settingsCrumbs({ page: "profiles" })).toEqual(["Settings", "Claude Code", "Profiles"]);
    expect(settingsCrumbs({ page: "hooks" })).toEqual(["Settings", "Claude Code", "Hooks"]);
    expect(settingsCrumbs({ page: "phones" })).toEqual(["Settings", "Machines", "Phones"]);
    expect(settingsCrumbs({ page: "workers" })).toEqual(["Settings", "Machines", "Workers"]);
  });

  it("names the workspace or project of its page", () => {
    expect(settingsCrumbs({ page: "workspace", host: "local", id: "acme" }, "Acme")).toEqual(["Settings", "Workspaces", "Acme"]);
    expect(settingsCrumbs({ page: "project", host: "local", id: "p1" }, "storefront")).toEqual(["Settings", "Projects", "storefront"]);
  });
});

describe("what Esc does on the settings page (X43)", () => {
  it("closes the page from anywhere else", () => {
    expect(escapeAction({ dialogShown: false, editable: false, recording: false })).toBe("close");
  });

  it("leaves a text field first, so its own Esc (such as cancelling a rename) runs", () => {
    expect(escapeAction({ dialogShown: false, editable: true, recording: false })).toBe("leave-field");
  });

  it("leaves Esc to a shortcut being recorded, which it cancels", () => {
    expect(escapeAction({ dialogShown: false, editable: false, recording: true })).toBe("ignore");
  });

  it("does nothing while a dialog or the confirm modal is over the page, wherever focus is", () => {
    expect(escapeAction({ dialogShown: true, editable: false, recording: false })).toBe("ignore");
    expect(escapeAction({ dialogShown: true, editable: true, recording: false })).toBe("ignore");
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

  it("is a quiet note, not a warning, in a development build", () => {
    expect(appUpdateLine({ phase: "idle" }, false, "Development builds don't update themselves")).toEqual({ tone: "muted", text: "Development builds don't update themselves" });
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

describe("the order of hosts in the nav (X43)", () => {
  it("puts this Mac first, then the remote hosts by name", () => {
    expect(hostOrder(["gpu-runner", "local", "devbox"])).toEqual(["local", "devbox", "gpu-runner"]);
  });
});

describe("⌘↵ on a workspace or project page (X43)", () => {
  it("saves from the page", () => {
    expect(saveKeySaves({ dialogShown: false, inOwnForm: false, searching: false })).toBe(true);
  });

  it("doesn't save while the search hides the page, over a dialog, or from a form with its own Enter", () => {
    expect(saveKeySaves({ dialogShown: false, inOwnForm: false, searching: true })).toBe(false);
    expect(saveKeySaves({ dialogShown: true, inOwnForm: false, searching: false })).toBe(false);
    expect(saveKeySaves({ dialogShown: false, inOwnForm: true, searching: false })).toBe(false);
  });
});

describe("the account under a workspace's Claude profile (X43)", () => {
  it("names the account, or warns that the profile is signed out", () => {
    expect(accountNote("Work", { logged_in: true, email: "dev@example.com", org_name: null })).toEqual({ tone: "muted", text: "Signed in as dev@example.com" });
    expect(accountNote("Work", { logged_in: false, email: null, org_name: null })).toEqual({ tone: "blocked", text: "Work is not signed in" });
    expect(accountNote("Default", null)).toEqual({ tone: "muted", text: "Checking…" });
  });
});

describe("Task trackers in the nav (X44)", () => {
  it("shows a dot when a connection needs attention", () => {
    const none = { remoteHosts: 0, phones: 0, profilesNeedSignIn: false, workspaces: [], projects: [] };
    const trackers = (input: object) => settingsNav({ ...none, ...input })[0].entries.find((e) => e.key === "trackers");
    expect(trackers({})?.dot).toBe(undefined);
    expect(trackers({ trackersNeedAttention: 1 })?.dot).toBe("1 connection needs attention");
    expect(trackers({ trackersNeedAttention: 2 })?.dot).toBe("2 connections need attention");
  });
});
