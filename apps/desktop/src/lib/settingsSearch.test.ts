import { describe, expect, it } from "vitest";
import { moveSelection, searchSettings, type SearchContext } from "./settingsSearch";
import { defaultTermSettings } from "./terminals";

const ctx: SearchContext = {
  settings: {
    term: defaultTermSettings,
    notifyWhenFocused: false,
    defaultMode: "auto",
    sounds: { blocked: "Glass", done: "Hero", error: "" },
    toolCalls: "collapsed",
    shortcuts: { commit: "alt+cmd+g" },
    planApproveMode: "auto",
    editorTheme: "github-dark",
    autoUpdateCheck: true,
  },
  appVersion: "0.1.16",
  claudeInstalled: "2.1.292",
  profiles: 3,
  remoteHosts: 2,
  phones: 0,
  workspaces: [
    { host: "local", id: "personal", name: "Personal", color: "clay", profile: "Default" },
    { host: "local", id: "acme", name: "Acme", color: "blue", profile: "Work" },
  ],
  projects: [{ host: "local", id: "p1", name: "storefront", base_branch: "main" }],
};

const shown = (q: string) => searchSettings(q, ctx).map((r) => [r.before + r.hit + r.after, r.path, r.value]);

describe("searching settings (X43)", () => {
  it("finds the daemon's login item by the names macOS uses (X56)", () => {
    for (const q of ["login items", "background items", "SMAppService"]) {
      expect(shown(q)).toEqual([["Start the moonlet daemon at login", "App › General › Background daemon", ""]]);
    }
  });

  it("finds the session row style with the style chosen (X48)", () => {
    expect(shown("session rows")).toEqual([["Session rows", "App › Appearance", "A · Issue number column"]]);
    expect(searchSettings("session rows", { ...ctx, settings: { ...ctx.settings, sessionRows: "task" } })[0].value).toBe("B · Task as a sub-header");
  });

  it("finds every setting whose name has the words, with its page and current value", () => {
    expect(shown("claude")).toEqual([
      ["Claude Code version", "App › General › Updates", "2.1.292"],
      ["Default permission mode for new Claude sessions", "App › Agents", "Auto"],
      ["Claude profiles", "Claude Code › Profiles", "3 profiles"],
      ["Claude Code hooks", "Claude Code › Hooks", ""],
      ["Claude profile", "Workspaces › Personal", "Default"],
      ["Claude profile", "Workspaces › Acme", "Work"],
    ]);
  });

  it("finds This Mac's Git settings with their values (X55)", () => {
    const git = { ...ctx, git: { branch_prefix: "marcin/", start_from: "origin" as const, archive_worktree: "remove" as const, archive_branch: "merged" as const, delete_remote_branch: false, warn_unpushed: true, stage_all: true, draft_prs: true, fetch_minutes: 15, fast_forward_base: false } };
    expect(searchSettings("draft", git).map((r) => [r.before + r.hit + r.after, r.path, r.value, r.route, r.setting])).toEqual([
      ["Open pull requests as drafts", "App › Git", "On", { page: "git" }, "git-draft-prs"],
    ]);
    expect(searchSettings("stage all", git)[0]).toMatchObject({ path: "App › Git", value: "On", setting: "git-stage-all" });
    expect(searchSettings("prefix", git).map((r) => [r.path, r.value, r.setting])).toEqual([
      ["App › Git", "marcin/", "git-branch-prefix"],
      ["Projects › storefront", "", "project-branch-prefix"],
    ]);
    expect(searchSettings("archiving", git).map((r) => [r.before + r.hit + r.after, r.value])).toEqual([
      ["Worktree folder when archiving", "Remove"],
      ["Local branch when archiving", "Delete when its PR merged"],
    ]);
    expect(searchSettings("unpushed", git)[0]).toMatchObject({ value: "On", setting: "git-warn-unpushed" });
    expect(searchSettings("fetch from origin", git)[0]).toMatchObject({ value: "15 min", setting: "git-fetch" });
    expect(searchSettings("start new branches", git)[0]).toMatchObject({ value: "origin/main", setting: "git-start-from" });
  });

  it("splits the name around the match, whatever its case", () => {
    const [mode] = searchSettings("CLAUDE S", ctx);
    expect(mode).toMatchObject({ before: "Default permission mode for new ", hit: "Claude s", after: "essions" });
  });

  it("opens the setting's page at its row", () => {
    expect(searchSettings("base branch", ctx)).toEqual([
      { key: "project:local:p1:project-base", before: "", hit: "Base branch", after: "", path: "Projects › storefront", value: "main", route: { page: "project", host: "local", id: "p1" }, setting: "project-base" },
    ]);
    expect(searchSettings("tool calls", ctx)[0]).toMatchObject({ route: { page: "agents" }, setting: "tool-calls", value: "Collapsed" });
  });

  it("finds a setting by another word for it, without a highlight", () => {
    expect(searchSettings("webgl", ctx)).toMatchObject([{ before: "GPU rendering", hit: "", after: "", path: "App › Terminal", value: "On" }]);
  });

  it("shows switches as On or Off and sounds by name", () => {
    expect(shown("sound")).toEqual([
      ["Mute all sounds", "App › Notifications", "Off"],
      ["Sound when an agent needs you", "App › Notifications", "Glass"],
      ["Sound when an agent is done", "App › Notifications", "Hero"],
      ["Sound when an agent fails", "App › Notifications", "Off"],
    ]);
    expect(shown("notify even")).toEqual([["Notify even while moonlet is focused", "App › Notifications", "Off"]]);
  });

  it("finds the notification per event and mute, on unless turned off", () => {
    const quiet: SearchContext = { ...ctx, settings: { ...ctx.settings, banners: { done: false }, muted: true } };
    expect(searchSettings("notification when", quiet).map((r) => [r.before + r.hit + r.after, r.path, r.value])).toEqual([
      ["Notification when an agent needs you", "App › Notifications", "On"],
      ["Notification when an agent is done", "App › Notifications", "Off"],
      ["Notification when an agent fails", "App › Notifications", "On"],
      ["Notification when a file differs between machines", "App › Notifications", "On"],
    ]);
    const off: SearchContext = { ...ctx, settings: { ...ctx.settings, syncBanner: false } };
    expect(searchSettings("differs between", off).map((r) => [r.before + r.hit + r.after, r.path, r.value])).toEqual([["Notification when a file differs between machines", "App › Notifications", "Off"]]);
    expect(searchSettings("mute all sounds", quiet).map((r) => [r.before + r.hit + r.after, r.value])).toEqual([["Mute all sounds", "On"]]);
  });

  it("finds an action's shortcut, with its key", () => {
    expect(searchSettings("commit…", ctx)).toEqual([
      { key: "shortcuts:shortcut-commit", before: "", hit: "Commit…", after: "", path: "App › Keyboard shortcuts", value: "⌥⌘G", route: { page: "shortcuts" }, setting: "shortcut-commit" },
    ]);
    expect(shown("split pane right")).toEqual([["Split pane right", "App › Keyboard shortcuts", "⌘D"]]);
  });

  it("shows a project's scripts and agents once its config is known", () => {
    const withConfig: SearchContext = {
      ...ctx,
      projects: [{ host: "local", id: "p1", name: "storefront", base_branch: "main", config: { setup: "pnpm install", run: "pnpm dev --port 4000", archive: null, default_agent: "aider", base_branch: "develop", agents: { aider: "aider --model sonnet" } } }],
    };
    expect(searchSettings("script", withConfig).filter((r) => r.path === "Projects › storefront").map((r) => [r.before + r.hit + r.after, r.value])).toEqual([
      ["Setup script", "pnpm install"],
      ["Run script", "pnpm dev --port 4000"],
      ["Archive script", "Not set"],
    ]);
    expect(searchSettings("agent", withConfig).filter((r) => r.path === "Projects › storefront").map((r) => [r.before + r.hit + r.after, r.value])).toEqual([
      ["Default agent", "aider"],
      ["Custom agents", "1 agent"],
    ]);
    expect(searchSettings("base branch", withConfig)[0].value).toBe("develop");
  });

  it("finds nothing for a blank query", () => {
    expect(searchSettings("  ", ctx)).toEqual([]);
  });
});

describe("moving through the search results (X43)", () => {
  it("moves with ↑ and ↓ and stops at the ends", () => {
    expect(moveSelection(0, 6, "ArrowDown")).toBe(1);
    expect(moveSelection(5, 6, "ArrowDown")).toBe(5);
    expect(moveSelection(0, 6, "ArrowUp")).toBe(0);
    expect(moveSelection(3, 6, "ArrowUp")).toBe(2);
  });

  it("ignores other keys", () => {
    expect(moveSelection(2, 6, "a")).toBeNull();
  });
});

describe("Task trackers in the search (X44)", () => {
  const trackers = {
    sync: { interval: 300, notify: true },
    github: { branch_template: "", max_length: 48, rules: { session_starts: "auto", pr_opens: "auto", all_merged: "suggest", pr_comment: "off", issue_done: "suggest" } },
  } as const;
  const found = (q: string) => searchSettings(q, { ...ctx, trackers }).map((r) => [r.before + r.hit + r.after, r.path, r.value]);

  it("finds the branch template, the rules and the sync interval with their values", () => {
    expect(found("branch name for")).toEqual([["Branch name for new sessions", "App › Task trackers", "{number}-{title}"]]);
    expect(found("close the issue")).toEqual([["Every session's PR is merged → close the issue", "App › Task trackers", "Suggest"]]);
    expect(found("closes #")).toEqual([["A pull request opens → add Closes #<number> to it", "App › Task trackers", "Off"]]);
    expect(found("refresh issues")).toEqual([["Refresh issues", "App › Task trackers", "Every 5 minutes"]]);
    expect(found("changes state outside")).toEqual([["Notify when a task changes state outside moonlet", "App › Task trackers", "On"]]);
    expect(found("pull request mentions")).toEqual([["Link a session when its pull request mentions the key or closes the issue", "App › Task trackers", "On"]]);
  });

  it("finds each connected tracker's own branch name", () => {
    const withLinear = { ...trackers, linear: { ...trackers.github, branch_template: "" }, connections: [{ id: "linear:acme", kind: "linear" as const, site: "acme", account: "Ada", auth: "api_key", sources: [] }] };
    const hits = searchSettings("linear branch", { ...ctx, trackers: withLinear }).map((r) => [r.before + r.hit + r.after, r.value]);
    expect(hits).toEqual([["Linear branch name for new sessions", "{key}-{title}"]]);
  });

  it("finds the Boards section and each board by its name, with what it is built from (X50)", () => {
    const withBoards = { ...trackers, boards: [{ id: "jira:ops.atlassian.net/10@local/w", name: "Operations", connection: "jira:ops.atlassian.net", workspace: "local/w", origin: { kind: "jira_board" as const, board: 10 } }] };
    const hits = (q: string) => searchSettings(q, { ...ctx, trackers: withBoards }).map((r) => [r.before + r.hit + r.after, r.value, r.setting]);
    expect(hits("boards")).toEqual([["Boards", "1 board", "boards"]]);
    expect(hits("operations")).toEqual([["Operations", "Jira board 10", "board-jira:ops.atlassian.net/10@local/w"]]);
  });
});

describe("tailnet access in the search (X57)", () => {
  it("finds the setting on Hosts and on Phones", () => {
    expect(searchSettings("connections from my tailnet", ctx).map((r) => [r.path, r.route, r.setting])).toEqual([
      ["Machines › Hosts", { page: "hosts" }, "tailnet"],
      ["Machines › Phones", { page: "phones" }, "phones"],
    ]);
  });
});

describe("the worker link in the search (X41)", () => {
  it("finds Use this Mac for heavy commands on Hosts, also as the central host", () => {
    const found = (q: string) => searchSettings(q, ctx).map((r) => [r.path, r.route, r.setting]);
    expect(found("use this mac for heavy")).toEqual([["Machines › Hosts", { page: "hosts" }, "heavy-commands"]]);
    expect(found("central host")).toEqual([
      ["Machines › Hosts", { page: "hosts" }, "heavy-commands"],
      ["Machines › Workers", { page: "workers" }, undefined],
    ]);
  });
});

describe("heavy commands in the search (X62)", () => {
  it("finds the Workers page, the run-at-most row and a project's Heavy commands", () => {
    const found = (q: string) => searchSettings(q, ctx).map((r) => [r.before + r.hit + r.after, r.path, r.setting]);
    expect(found("workers")).toEqual([
      ["Workers", "Machines › Workers", undefined],
      ["Heavy commands", "Projects › storefront", "project-heavy"],
    ]);
    expect(found("run at most")).toEqual([["Run at most", "Machines › Hosts", "heavy-slots"]]);
    expect(found("heavy commands")).toEqual([
      ["Use this Mac for heavy commands", "Machines › Hosts", "heavy-commands"],
      ["Heavy commands", "Projects › storefront", "project-heavy"],
    ]);
  });
});
