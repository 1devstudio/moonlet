import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GhTask, Section, Session, Workspace } from "./protocol";
import { migrateSources } from "./boards";
import { workspaceViews } from "./boardScreen";
import { DEFAULT_RULES } from "./keepInStep";
import { useStore } from "./store";
import { answerConfirm } from "./confirm";
import { rpc } from "./daemon";
import { createIssue, setColumnShow } from "./tasksStore";
import { type TasksData, type TrackersConfig, activityOf, autoFixed, boardInput, openBoard, removeBoard, previewBoard, showBoard, branchUser, DEFAULT_CONFIG, ensureTasks, failureOf, fixDrift, isTasksMode, loadTrackersConfig, lookUpPasted, moveTask, reconnected, refreshTasks, retryTask, rulesFor, runAutoFixes, pollTasks, saveTrackersConfig, settleSaves, setAssignee, setExpanded, setFilters, setKeepInStep, startedFromTask, syncTasks, toggleExpanded, toggleTasksMode, trackersConfig, useTasks } from "./tasksStore";

const answers: Record<string, (params: { path?: string; id?: string }) => unknown> = {};
vi.mock("./daemon", () => ({
  rpc: vi.fn((_host: string, method: string, params: { path?: string; id?: string }) => {
    const answer = answers[method];
    return answer ? Promise.resolve().then(() => answer(params)) : Promise.reject(new Error(`no ${method}`));
  }),
  sendInput: vi.fn(),
  hostsApi: {
    trackersConfig: () =>
      new Promise((r) => setTimeout(r, configDelay.ms)).then(() => (configFails.length ? Promise.reject(configFails.shift()) : (file.config ?? { sync: { interval: 300, notify: true }, boards: [WEB_REPO] }))),
    trackersSave: (c: object) => new Promise<void>((r, no) => setTimeout(() => (saveFails.length ? no(saveFails.shift()) : (saved.push(c), r())), 5)),
    trackerUpdate: (req: object) =>
      held.on
        ? new Promise<void>((r, no) => (held.settle = (error) => (error ? no(error) : (sent.push(req), r()))))
        : failNext.length
          ? Promise.reject(failNext.shift())
          : (sent.push(req), Promise.resolve()),
    trackerTask: (id: string, key: string) => Promise.resolve(answers[`tracker_task ${id} ${key}`]?.({}) ?? null),
    // A Linear team's or ClickUp list's board (X50): that source's issues
    // from the tracker_tasks answers, and its columns when a test gives them.
    // The app's command, tested in Rust (states.rs a_github_projects_columns_start_with_no_status).
    githubProjectColumns: (options: { id: string; name: string }[]) =>
      Promise.resolve([{ id: "", name: "No Status" }, ...options].map(({ id, name }) => ({ name, statuses: [id], category: name === "Done" ? "done" : name === "In Progress" ? "in_progress" : "todo", ...(name === "Done" && { show: "fold" }) }))),
    // A new issue from a column (X52): what was asked, and the tracker's answer.
    trackerCreateOptions: (id: string, place: string) => Promise.resolve(answers[`tracker_create_options ${id} ${place}`]?.({}) ?? { me: "u1", people: [], labels: [] }),
    // The command answers with the issue and what failed once it existed; a test may give either.
    trackerCreate: (req: { id: string }) => {
      creates.push(req);
      const answer = answers[`tracker_create ${req.id}`]?.(req as object) as { issue?: object } | undefined;
      return answer ? Promise.resolve(answer.issue ? answer : { issue: answer }) : Promise.reject(new Error("Linear: no such team"));
    },
    trackerBoardTasks: (q: { id: string; origin: { team?: string; list?: string; query?: string }; mine: boolean; sync?: number }) => {
      boardQueries.push(q);
      const answer = answers[`tracker_tasks ${q.id}${q.mine ? "" : " all"}`] ?? answers[`tracker_tasks ${q.id}`];
      if (!answer) return Promise.reject(new Error(`no tracker_board_tasks ${q.id}`));
      const source = q.origin.team ?? q.origin.list;
      return Promise.resolve().then(() => ({
        issues: (answer({ id: source }) as { tracker?: { source: string } }[]).filter((t) => !source || t.tracker?.source === source).map((t) => ({ ...t, statusId: "" })),
        sprint: null,
        columns: answers[`board_columns ${q.id}`]?.({}) ?? null,
        ...(answers[`board_kind ${q.id}`] && { kind: answers[`board_kind ${q.id}`]({}) }),
        ...(answers[`status_names ${q.id}`] && { statusNames: answers[`status_names ${q.id}`]({}) }),
      }));
    },
  },
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: () => Promise.resolve() }) }));
const shown = vi.hoisted(() => [] as { title: string; body: string }[]);
const sent = vi.hoisted(() => [] as object[]);
const failNext = vi.hoisted(() => [] as object[]);
/** While on, a tracker_update waits for the test to settle it, with the tracker's refusal or none. */
const held = vi.hoisted(() => ({ on: false, settle: (_error?: object) => {} }));
const configFails = vi.hoisted(() => [] as object[]);
const configDelay = vi.hoisted(() => ({ ms: 0 }));
/** What trackers.toml holds, when a test gives it; else the acme/web board the user added. */
const file = vi.hoisted(() => ({ config: null as object | null }));
const WEB_REPO = vi.hoisted(() => ({ id: "github:github.com/acme/web@local/personal", name: "acme/web", connection: "github:github.com", workspace: "local/personal", origin: { kind: "github_repo" as const, repo: "acme/web" } }));
const saved = vi.hoisted(() => [] as object[]);
const saveFails = vi.hoisted(() => [] as object[]);
/** The links the app opened in the browser. */
const opened = vi.hoisted(() => [] as string[]);
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (url: string) => (opened.push(url), Promise.resolve()) }));
/** The tracker_create requests made (X52). */
const creates = vi.hoisted(() => [] as object[]);
/** The tracker_board_tasks queries made, in order. */
const boardQueries = vi.hoisted(() => [] as { id: string; mine: boolean; sync?: number }[]);
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(true),
  requestPermission: () => Promise.resolve("granted"),
  sendNotification: (n: { title: string; body: string }) => shown.push(n),
}));

/** The shown board's columns of local/personal, each with its cards' keys, as Tasks mode draws them (X53). */
function boardCards(config: TrackersConfig): [string, string[]][] {
  const data = useTasks.getState().data["local/personal"];
  return workspaceViews(config.boards ?? [], data, boardInput(useStore.getState(), "local", "personal", data, config))[0].views.map((v) => [v.name, v.cards.map((c) => c.task.key)]);
}

const ws = (id: string, section_ids: string[]): Workspace => ({ id, name: id, color: "clay", section_ids, created_at: 0 });
const sec = (id: string, project_ids: string[]): Section => ({ id, name: id, project_ids, view: { group_by: "project", sort_by: "created", filter: [] }, created_at: 0 });
const issue: GhTask = {
  repo: "acme/web",
  number: 12,
  title: "Fix checkout button",
  body: "",
  url: "https://github.com/acme/web/issues/12",
  closed: false,
  state_reason: null,
  assignees: ["sam-rivera"],
  labels: [],
  updated_ms: 1,
  closing_prs: [],
};

beforeEach(async () => {
  // A sync saves new board columns without waiting for the write: let any
  // still on its way land before the next test empties `saved`.
  await settleSaves();
  configDelay.ms = 0;
  for (const k of Object.keys(answers)) delete answers[k];
  useTasks.setState({ data: {} });
  useStore.setState({
    hosts: { local: { id: "local", label: "This Mac", remote: false, status: "connected", message: null, daemon_version: null, hostname: null, home: null } },
    projects: {
      local: [
        { id: "web", name: "web", path: "/r/web", base_branch: "main" },
        { id: "notes", name: "notes", path: "/r/notes", base_branch: "main" },
      ],
    },
    workspaces: { local: [ws("personal", ["a"]), ws("acme", ["b"])] },
    sections: { local: [sec("a", ["web", "notes"]), sec("b", [])] },
    workspace: { host: "local", id: "personal" },
    mode: {},
  });
});

describe("Tasks mode switch (X45)", () => {
  it("toggles the shown workspace only", () => {
    expect(isTasksMode(useStore.getState())).toBe(false);
    toggleTasksMode();
    expect(isTasksMode(useStore.getState())).toBe(true);
    useStore.setState({ workspace: { host: "local", id: "acme" } });
    expect(isTasksMode(useStore.getState())).toBe(false);
    useStore.setState({ workspace: { host: "local", id: "personal" } });
    toggleTasksMode();
    expect(isTasksMode(useStore.getState())).toBe(false);
  });
});

describe("refreshTasks (X44 GitHub source)", () => {
  it("loads the issues of projects with a GitHub origin, and every project's worktrees", async () => {
    answers["git.origin_url"] = ({ path }) => (path === "/r/web" ? "https://github.com/acme/web.git" : "https://gitlab.com/me/notes.git");
    answers["gh.tasks"] = ({ path }) => (path === "/r/web" ? [issue] : []);
    answers["project.worktrees"] = ({ id }) => (id === "web" ? [{ path: "/w/12-fix", branch: "12-fix", last_commit_ms: 1 }] : []);
    await refreshTasks("local", "personal", 5_000);
    const d = useTasks.getState().data["local/personal"];
    expect(d.sources).toEqual(["acme/web"]);
    expect(d.tasks.map((t) => [t.connection, t.key, t.column])).toEqual([["github:github.com", "acme/web#12", "open"]]);
    expect(d.worktrees).toEqual([{ path: "/w/12-fix", branch: "12-fix", originRepo: "acme/web", project: "web" }]);
    expect([d.syncedAt, d.error]).toEqual([5_000, null]);
  });

  it("keeps the last good list when a sync fails", async () => {
    answers["git.origin_url"] = () => "https://github.com/acme/web.git";
    answers["gh.tasks"] = () => [issue];
    answers["project.worktrees"] = () => [];
    await refreshTasks("local", "personal", 5_000);
    answers["gh.tasks"] = () => {
      throw new Error("gh: authentication required");
    };
    await refreshTasks("local", "personal", 9_000);
    const d = useTasks.getState().data["local/personal"];
    expect(d.tasks.map((t) => t.key)).toEqual(["acme/web#12"]);
    expect([d.syncedAt, d.error]).toEqual([5_000, "gh: authentication required"]);
  });
});

describe("ensureTasks (X46: a linked session outside Tasks mode)", () => {
  it("loads a workspace's tasks once, then again only after a minute", async () => {
    answers["git.origin_url"] = () => "https://github.com/acme/web.git";
    answers["gh.tasks"] = () => [issue];
    answers["project.worktrees"] = () => [];
    const synced = () => useTasks.getState().data["local/personal"]?.syncedAt;
    ensureTasks("local", "personal", 1_000);
    await vi.waitFor(() => expect(synced()).toBe(1_000));
    ensureTasks("local", "personal", 30_000);
    await new Promise((r) => setTimeout(r, 20));
    expect(synced()).toBe(1_000);
    ensureTasks("local", "personal", 62_000);
    await vi.waitFor(() => expect(synced()).toBe(62_000));
  });

  it("waits a minute after a failed sync too, and asks only once while one runs", async () => {
    answers["git.origin_url"] = () => "https://github.com/acme/web.git";
    answers["project.worktrees"] = () => [];
    answers["gh.tasks"] = () => {
      throw new Error("gh: not signed in");
    };
    useTasks.setState({ data: {} });
    ensureTasks("local", "personal", 1_000);
    ensureTasks("local", "personal", 1_001);
    await vi.waitFor(() => expect(useTasks.getState().data["local/personal"]?.error).toBe("gh: not signed in"));
    answers["gh.tasks"] = () => [issue];
    ensureTasks("local", "personal", 30_000);
    await new Promise((r) => setTimeout(r, 20));
    expect(useTasks.getState().data["local/personal"].tasks).toEqual([]);
    ensureTasks("local", "personal", 62_000);
    await vi.waitFor(() => expect(useTasks.getState().data["local/personal"].tasks).toHaveLength(1));
  });

  it("does not refresh by itself when Sync is manual, once there is a list", async () => {
    answers["git.origin_url"] = () => "https://github.com/acme/web.git";
    answers["gh.tasks"] = () => [issue];
    answers["project.worktrees"] = () => [];
    useTasks.setState({ data: {}, config: { ...DEFAULT_CONFIG, sync: { interval: 0, notify: true } } });
    const synced = () => useTasks.getState().data["local/personal"]?.syncedAt;
    ensureTasks("local", "personal", 500_000);
    await vi.waitFor(() => expect(synced()).toBe(500_000));
    ensureTasks("local", "personal", 900_000);
    await new Promise((r) => setTimeout(r, 20));
    expect(synced()).toBe(500_000);
    useTasks.setState({ config: null });
  });
});

describe("syncTasks (X44 Sync)", () => {
  it("refreshes when the window comes to the front, but not under manual Sync", async () => {
    answers["git.origin_url"] = () => "https://github.com/acme/web.git";
    answers["gh.tasks"] = () => [issue];
    answers["project.worktrees"] = () => [];
    vi.useFakeTimers({ toFake: ["Date"] });
    const synced = () => useTasks.getState().data["local/personal"]?.syncedAt;
    for (const [interval, at, after] of [
      [0, 100_000, 100_000],
      [60, 200_000, 250_000],
    ]) {
      vi.setSystemTime(at);
      const stop = syncTasks("local", "personal", interval);
      await vi.waitFor(() => expect(synced()).toBe(at));
      vi.setSystemTime(at + 50_000);
      window.dispatchEvent(new Event("focus"));
      await new Promise((r) => setTimeout(r, 20));
      expect(synced()).toBe(after);
      stop();
    }
    vi.useRealTimers();
  });
});

describe("syncTasks timer (X44 Sync)", () => {
  it("refreshes on the chosen interval, and sets no timer when Sync is manual", async () => {
    answers["git.origin_url"] = () => "https://github.com/acme/web.git";
    answers["gh.tasks"] = () => [issue];
    answers["project.worktrees"] = () => [];
    vi.useFakeTimers();
    try {
      const synced = () => useTasks.getState().data["local/personal"]?.syncedAt;
      for (const [interval, after] of [
        [60, 160_000],
        [0, 100_000],
      ]) {
        vi.setSystemTime(100_000);
        const stop = syncTasks("local", "personal", interval);
        await vi.waitFor(() => expect(synced()).toBe(100_000));
        await vi.advanceTimersByTimeAsync(60_000);
        await vi.waitFor(() => expect(synced()).toBe(after));
        stop();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a linked task changed outside moonlet (X44 Sync)", () => {
  it("is announced once, and not at all with the switch off", async () => {
    shown.length = 0;
    answers["git.origin_url"] = ({ path }) => (path === "/r/web" ? "https://github.com/acme/web.git" : null);
    answers["project.worktrees"] = () => [];
    useStore.setState({
      sessions: {
        local: [
          {
            id: "s1",
            project_id: "web",
            name: "Checkout",
            branch: "12-checkout",
            base: "main",
            path: "/w/12-checkout",
            agent: null,
            archived: false,
            created_at: 1,
            workspace_id: "personal",
            terminals: [],
            layout: null,
          },
        ],
      },
    });
    answers["gh.tasks"] = () => [issue];
    await refreshTasks("local", "personal", 1_000);
    answers["gh.tasks"] = () => [{ ...issue, closed: true, state_reason: "completed" }];
    await refreshTasks("local", "personal", 2_000);
    await vi.waitFor(() => expect(shown).toEqual([{ title: "acme/web#12 was closed", body: "Fix checkout button" }]));
    // The notice also goes into the task's Activity.
    expect(activityOf({ connection: "github:github.com", key: "acme/web#12" }).map((e) => e.text)).toContain("Outside moonlet: acme/web#12 was closed");

    useTasks.setState({ config: { ...DEFAULT_CONFIG, sync: { interval: 60, notify: false }, boards: [WEB_REPO] } });
    answers["gh.tasks"] = () => [issue];
    await refreshTasks("local", "personal", 3_000);
    await new Promise((r) => setTimeout(r, 20));
    expect(shown).toHaveLength(1);
    useTasks.setState({ config: null });
  });

  it("is not announced when moonlet closed it, even if a sync from before the close lands first", async () => {
    shown.length = 0;
    answers["git.origin_url"] = ({ path }) => (path === "/r/web" ? "https://github.com/acme/web.git" : null);
    answers["project.worktrees"] = () => [];
    answers["gh.task_update"] = () => true;
    useStore.setState({ sessions: { local: [{ id: "s1", project_id: "web", name: "Checkout", branch: "12-checkout", base: "main", path: "/w/12-checkout", agent: null, archived: false, created_at: 1, workspace_id: "personal", terminals: [], layout: null }] } });
    answers["gh.tasks"] = () => [issue];
    await refreshTasks("local", "personal", 1_000);
    const t = useTasks.getState().data["local/personal"].tasks[0];
    const merged = { kind: "merged" as const, text: "#70 merged", fix: "Close the issue" };
    // fixDrift's own refresh still sees the issue open (GitHub lags)…
    await fixDrift("local", "personal", { task: t, column: "in_progress", rows: [], needsYou: false, orphans: [], empty: null, drift: merged });
    // …and the next one sees it closed.
    answers["gh.tasks"] = () => [{ ...issue, closed: true, state_reason: "completed" }];
    await refreshTasks("local", "personal", 3_000);
    await new Promise((r) => setTimeout(r, 20));
    expect(shown).toEqual([]);
  });
});

describe("outside changes with a state mapping (X44)", () => {
  it("does not announce a move moonlet made onto a state the user mapped to that column", async () => {
    shown.length = 0;
    answers["git.origin_url"] = () => null;
    answers["project.worktrees"] = () => [];
    const lt = (state: string, column: string) => ({ connection: "linear:acme", key: "MOON-1", title: "Hosts", url: "", column, priority: 0, assignees: [], labels: [], description: "", updatedMs: 0, tracker: { id: "i1", state, source: "MOON" } });
    // As the file loads: the source is a board carrying the mapping (X50).
    useTasks.setState({
      config: migrateSources({ ...DEFAULT_CONFIG, connections: [{ id: "linear:acme", kind: "linear", site: "acme", account: "Sam", auth: "api_key", sources: [{ key: "MOON", name: "Moonlet", workspace: "local/personal" }], states: { QA: "in_progress", "In Progress": "in_review" } }] }),
    });
    useStore.setState({ sessions: { local: [{ id: "s1", project_id: "web", name: "Hosts", branch: "hosts", base: "main", path: "/w/hosts", agent: null, archived: false, created_at: 1, workspace_id: "personal", terminals: [], layout: null, task: { connection: "linear:acme", key: "MOON-1", url: "" } }] } });
    answers["tracker_tasks linear:acme"] = () => [lt("Todo", "todo")];
    // The team's states as the board's columns; the old mapping (X44) gives their categories (X50).
    answers["board_columns linear:acme"] = () => [
      { name: "Todo", statuses: ["Todo"], category: "todo" },
      { name: "In Progress", statuses: ["In Progress"], category: "in_progress" },
      { name: "QA", statuses: ["QA"], category: "in_review" },
    ];
    await refreshTasks("local", "personal", 1_000);
    const t = useTasks.getState().data["local/personal"].tasks[0];
    // moonlet moves it to In Progress, which in this team is the QA state (by default In Review).
    await moveTask("local", "personal", t, "in_progress", 1_500);
    answers["tracker_tasks linear:acme"] = () => [lt("QA", "in_review")];
    await refreshTasks("local", "personal", 2_000);
    await new Promise((r) => setTimeout(r, 20));
    expect(shown).toEqual([]);
    useTasks.setState({ config: null });
  });
});

describe("tasks from Linear, Jira and ClickUp (X44)", () => {
  const linearTask = (key: string, source: string) => ({
    connection: "linear:acme",
    key,
    title: key,
    url: "",
    column: "todo",
    priority: 0,
    assignees: [],
    labels: [],
    description: "",
    updatedMs: 0,
    tracker: { id: key, state: "Todo", source },
  });
  // A file with sources, as it is once loaded: one board per source (X50).
  const config = (sources: { key: string; workspace: string }[]) =>
    migrateSources({
      ...DEFAULT_CONFIG,
      connections: [{ id: "linear:acme", kind: "linear" as const, site: "acme", account: "Sam", auth: "api_key", sources: sources.map((x) => ({ ...x, name: x.key })) }],
    });

  it("adds the tasks of the workspace's sources, and the projects that link them", async () => {
    answers["git.origin_url"] = () => null;
    answers["project.worktrees"] = () => [];
    // Project settings › Task trackers (X44): both projects handle MOON.
    answers["project.config"] = ({ id }) => ({ agents: {}, trackers: id === "web" ? ["linear:acme/MOON", "linear:acme/DES"] : ["linear:acme/MOON"] });
    answers["tracker_tasks linear:acme"] = () => [linearTask("MOON-1", "MOON"), linearTask("DES-2", "DES")];
    useTasks.setState({ config: config([{ key: "MOON", workspace: "local/personal" }, { key: "DES", workspace: "local/acme" }]) });
    await refreshTasks("local", "personal", 1_000);
    const d = useTasks.getState().data["local/personal"];
    expect(d.tasks.map((t) => t.key)).toEqual(["MOON-1"]);
    expect(d.sources).toEqual(["linear:acme"]);
    expect(d.sourceProjects).toEqual({ "linear:acme MOON": ["web", "notes"], "linear:acme DES": ["web"] });
    useTasks.setState({ config: null });
  });

  it("keeps the last tasks only of a source that failed, and takes the others fresh", async () => {
    answers["git.origin_url"] = ({ path }) => (path === "/r/web" ? "https://github.com/acme/web.git" : null);
    answers["project.worktrees"] = () => [];
    answers["gh.tasks"] = () => [];
    answers["tracker_tasks linear:acme"] = () => [linearTask("MOON-1", "MOON")];
    const moon = config([{ key: "MOON", workspace: "local/personal" }]);
    useTasks.setState({ config: { ...moon, boards: [...(moon.boards ?? []), WEB_REPO] }, attention: {} });
    await refreshTasks("local", "personal", 1_000);
    answers["gh.tasks"] = ({ path }) => (path === "/r/web" ? [issue] : []);
    answers["tracker_tasks linear:acme"] = () => {
      throw { auth: false, message: "cannot reach the tracker" };
    };
    await refreshTasks("local", "personal", 2_000);
    const d = useTasks.getState().data["local/personal"];
    expect(d.tasks.map((t) => t.key).sort()).toEqual(["MOON-1", "acme/web#12"]);
    expect(d.error).toBe("cannot reach the tracker");
    useTasks.setState({ config: null, attention: {} });
  });

  it("marks a connection whose token stopped working, keeping the last list", async () => {
    answers["git.origin_url"] = () => null;
    answers["project.worktrees"] = () => [];
    answers["tracker_tasks linear:acme"] = () => [linearTask("MOON-1", "MOON")];
    useTasks.setState({ config: config([{ key: "MOON", workspace: "local/personal" }]), attention: {} });
    await refreshTasks("local", "personal", 1_000);
    answers["tracker_tasks linear:acme"] = () => {
      throw { auth: true, message: "Linear no longer accepts this token. Create a new one and paste it here." };
    };
    await refreshTasks("local", "personal", 2_000);
    expect(useTasks.getState().data["local/personal"].tasks.map((t) => t.key)).toEqual(["MOON-1"]);
    expect(useTasks.getState().attention).toEqual({ "linear:acme": "Linear no longer accepts this token. Create a new one and paste it here." });

    // No more requests with the rejected token until the user reconnects.
    answers["tracker_tasks linear:acme"] = () => [linearTask("MOON-2", "MOON")];
    await refreshTasks("local", "personal", 3_000);
    expect(useTasks.getState().data["local/personal"].tasks.map((t) => t.key)).toEqual(["MOON-1"]);
    reconnected("linear:acme");
    await refreshTasks("local", "personal", 4_000);
    expect(useTasks.getState().data["local/personal"].tasks.map((t) => t.key)).toEqual(["MOON-2"]);
    expect(useTasks.getState().attention).toEqual({});
    useTasks.setState({ config: null, attention: {} });
  });
});

describe("boards (X50 Sync)", () => {
  const lt = (key: string, state: string) => ({ connection: "linear:acme", key, title: key, url: "", column: "todo", priority: 0, assignees: [], labels: [], description: "", updatedMs: 0, tracker: { id: key, state, source: "MOON" } });
  const board = (o: object = {}) => ({ id: "moon", name: "Moonlet", connection: "linear:acme", workspace: "local/personal", origin: { kind: "linear_team" as const, team: "MOON" }, ...o });

  it("gives a workspace's GitHub repository no board of its own: a sync saves none and shows none", async () => {
    answers["git.origin_url"] = ({ path }) => (path === "/r/web" ? "https://github.com/acme/web.git" : null);
    answers["project.worktrees"] = () => [];
    answers["gh.tasks"] = () => [issue];
    saved.length = 0;
    file.config = { sync: { interval: 300, notify: true } };
    useTasks.setState({ config: null, attention: {} });
    try {
      await refreshTasks("local", "personal", 1_000);
      expect(saved).toEqual([]);
      expect(useTasks.getState().config?.boards ?? []).toEqual([]);
      expect(useTasks.getState().data["local/personal"].tasks).toEqual([]);
    } finally {
      file.config = null;
      useTasks.setState({ config: null });
    }
  });

  it("turns the file's sources into boards when it loads", async () => {
    answers["git.origin_url"] = ({ path }) => (path === "/r/web" ? "https://github.com/acme/web.git" : null);
    answers["project.worktrees"] = () => [];
    answers["gh.tasks"] = () => [issue];
    answers["tracker_tasks linear:acme"] = () => [lt("MOON-1", "Todo")];
    saved.length = 0;
    file.config = { sync: { interval: 300, notify: true }, connections: [{ id: "linear:acme", kind: "linear", site: "acme", account: "Sam", auth: "api_key", sources: [{ key: "MOON", name: "Moonlet", workspace: "local/acme" }] }] };
    useTasks.setState({ config: null, attention: {} });
    try {
      await refreshTasks("local", "personal", 1_000);
      // Written to trackers.toml: the source as a board in its workspace.
      await vi.waitFor(() => expect((saved.at(-1) as { boards?: { name: string; workspace: string }[] })?.boards?.map((b) => [b.name, b.workspace])).toEqual([["Moonlet", "local/acme"]]));
      expect((saved.at(-1) as { connections: { sources: unknown[] }[] }).connections[0].sources).toEqual([]);
    } finally {
      file.config = null;
      useTasks.setState({ config: null });
    }
  });

  it("keeps a board's columns as its tracker has them, with the user's folding, and places tasks by their column", async () => {
    answers["git.origin_url"] = () => null;
    answers["project.worktrees"] = () => [];
    answers["tracker_tasks linear:acme"] = () => [lt("MOON-1", "In Review"), lt("MOON-2", "Triage")];
    answers["board_columns linear:acme"] = () => [
      { name: "Triage", statuses: ["Triage"], category: "todo", show: "hide" },
      { name: "In Progress", statuses: ["In Progress"], category: "in_progress" },
      { name: "In Review", statuses: ["In Review"], category: "in_review" },
    ];
    // The user folded In Progress; Triage and In Review are new to the board, and go where Linear has them.
    useTasks.setState({
      config: { ...DEFAULT_CONFIG, boards: [board({ columns: [{ name: "In Progress", statuses: ["In Progress"], category: "in_progress", show: "fold" }] })] },
      attention: {},
    });
    await refreshTasks("local", "personal", 1_000);
    expect(useTasks.getState().config?.boards?.[0].columns).toEqual([
      { name: "Triage", statuses: ["Triage"], category: "todo", show: "hide" },
      { name: "In Progress", statuses: ["In Progress"], category: "in_progress", show: "fold" },
      { name: "In Review", statuses: ["In Review"], category: "in_review" },
    ]);
    expect(useTasks.getState().data["local/personal"].tasks.map((t) => [t.key, t.column])).toEqual([
      ["MOON-1", "in_review"],
      ["MOON-2", "hidden"],
    ]);
    useTasks.setState({ config: null });
  });

  it("keeps a failed board's own last tasks with why it failed, and takes its connection's other boards fresh", async () => {
    answers["git.origin_url"] = () => null;
    answers["project.worktrees"] = () => [];
    const des = (key: string) => ({ ...lt(key, "Todo"), tracker: { id: key, state: "Todo", source: "DES" } });
    answers["tracker_tasks linear:acme"] = () => [lt("MOON-1", "Todo"), des("DES-1")];
    const boards = [board(), board({ id: "des", name: "Design", origin: { kind: "linear_team" as const, team: "DES" } })];
    useTasks.setState({ config: { ...DEFAULT_CONFIG, boards }, attention: {} });
    await refreshTasks("local", "personal", 1_000);
    answers["tracker_tasks linear:acme"] = ({ id }) => {
      if (id === "MOON") throw { auth: false, message: "cannot reach Linear" };
      return [des("DES-2")];
    };
    await refreshTasks("local", "personal", 2_000);
    expect(useTasks.getState().data["local/personal"].tasks.map((t) => t.key).sort()).toEqual(["DES-2", "MOON-1"]);
    expect(useTasks.getState().data["local/personal"].error).toBe("cannot reach Linear");
    // The board that failed says why on its own (X50: a board whose origin is gone); the other doesn't.
    expect([useTasks.getState().data["local/personal"].boards?.moon?.error, useTasks.getState().data["local/personal"].boards?.des?.error]).toEqual(["cannot reach Linear", undefined]);
    // A board that never read keeps no sprint, so no "No active sprint" either.
    const ops = board({ id: "ops", name: "OPS", origin: { kind: "linear_team" as const, team: "OPS" }, finished: "sprint" as const });
    useTasks.setState({ config: { ...DEFAULT_CONFIG, boards: [...boards, ops] } });
    answers["tracker_tasks linear:acme"] = ({ id }) => {
      if (id === "OPS") throw { auth: false, message: "Linear: Entity not found: Team" };
      return [lt("MOON-1", "Todo"), des("DES-2")];
    };
    await refreshTasks("local", "personal", 2_500);
    expect(useTasks.getState().data["local/personal"].boards?.ops).toEqual({ keys: [], error: "Linear: Entity not found: Team" });
    useTasks.setState({ config: { ...DEFAULT_CONFIG, boards } });
    // Once it reads again, the error goes.
    answers["tracker_tasks linear:acme"] = () => [lt("MOON-1", "Todo"), des("DES-2")];
    await refreshTasks("local", "personal", 3_000);
    expect(useTasks.getState().data["local/personal"].boards?.moon?.error).toBe(undefined);
    useTasks.setState({ config: null });
  });

  it("moves a task to the first status of its board's column of that category", async () => {
    answers["git.origin_url"] = () => null;
    answers["project.worktrees"] = () => [];
    answers["tracker_tasks linear:acme"] = () => [lt("MOON-1", "Todo")];
    // The team's in-progress column, Building, holds "Doing" first.
    const columns = [
      { name: "Todo", statuses: ["Todo"], category: "todo" as const },
      { name: "Building", statuses: ["Doing", "In Progress"], category: "in_progress" as const },
    ];
    useTasks.setState({ config: { ...DEFAULT_CONFIG, boards: [board({ columns })] }, attention: {} });
    await refreshTasks("local", "personal", 1_000);
    sent.length = 0;
    await moveTask("local", "personal", useTasks.getState().data["local/personal"].tasks[0], "in_progress", 1_500);
    expect(sent).toEqual([{ id: "linear:acme", task: "MOON-1", source: "MOON", column: "in_progress", status: "Doing" }]);
    // Activity names the column as the tracker does.
    expect(activityOf({ connection: "linear:acme", key: "MOON-1" })[0].text).toBe("moonlet moved it to Building");
    // The State menu names the column: its status, not the category's first.
    sent.length = 0;
    await moveTask("local", "personal", useTasks.getState().data["local/personal"].tasks[0], "in_progress", 1_600, "In Progress");
    expect(sent).toEqual([{ id: "linear:acme", task: "MOON-1", source: "MOON", column: "in_progress", status: "In Progress" }]);
    useTasks.setState({ config: null });
  });

  it("shows a moved card in its new column at once, through a sync that lands meanwhile, back where it was when the tracker refuses, and placed by the tracker once done (X53)", async () => {
    answers["git.origin_url"] = () => null;
    answers["project.worktrees"] = () => [];
    answers["tracker_tasks linear:acme"] = () => [lt("MOON-1", "Todo")];
    const columns = [
      { name: "Todo", statuses: ["Todo"], category: "todo" as const },
      { name: "Building", statuses: ["Doing", "In Progress"], category: "in_progress" as const },
    ];
    const config = { ...DEFAULT_CONFIG, boards: [board({ columns })] };
    useTasks.setState({ config, attention: {}, failures: {} });
    useStore.setState({ toasts: [] });
    await refreshTasks("local", "personal", 1_000);
    const cardsIn = () => boardCards(config);
    expect(cardsIn()).toEqual([["Todo", ["MOON-1"]], ["Building", []]]);
    held.on = true;
    try {
      const refused = moveTask("local", "personal", useTasks.getState().data["local/personal"].tasks[0], "in_progress", 1_500, "Doing");
      expect(cardsIn()).toEqual([["Todo", []], ["Building", ["MOON-1"]]]);
      // A sync from before the move still has it in Todo.
      await refreshTasks("local", "personal", 1_600);
      expect(cardsIn()).toEqual([["Todo", []], ["Building", ["MOON-1"]]]);
      held.settle({ message: "Linear: no such state" });
      await refused;
      expect(cardsIn()).toEqual([["Todo", ["MOON-1"]], ["Building", []]]);
      expect(useStore.getState().toasts.map((t) => t.text)).toEqual(["MOON-1: Linear: no such state"]);
      expect(failureOf({ connection: "linear:acme", key: "MOON-1" })).toBe("Linear: no such state");

      const moved = moveTask("local", "personal", useTasks.getState().data["local/personal"].tasks[0], "in_progress", 2_000, "Doing");
      answers["tracker_tasks linear:acme"] = () => [lt("MOON-1", "Doing")];
      held.settle();
      await moved;
      await vi.waitFor(() => expect(useTasks.getState().data["local/personal"].tasks[0].tracker?.state).toBe("Doing"));
      expect(cardsIn()).toEqual([["Todo", []], ["Building", ["MOON-1"]]]);
    } finally {
      held.on = false;
    }
    // Moved back in Linear afterwards: the tracker's answer places it, not the move.
    answers["tracker_tasks linear:acme"] = () => [lt("MOON-1", "Todo")];
    await refreshTasks("local", "personal", 3_000);
    expect(cardsIn()).toEqual([["Todo", ["MOON-1"]], ["Building", []]]);
    useTasks.setState({ config: null });
  });

  it("keeps a done move's card in its new column until a sync reads that task: not one that kept the board's last tasks, nor another workspace's (X53)", async () => {
    answers["git.origin_url"] = () => null;
    answers["project.worktrees"] = () => [];
    answers["tracker_tasks linear:acme"] = () => [lt("MOON-1", "Todo")];
    const columns = [
      { name: "Todo", statuses: ["Todo"], category: "todo" as const },
      { name: "Building", statuses: ["Doing"], category: "in_progress" as const },
    ];
    const config = { ...DEFAULT_CONFIG, boards: [board({ columns })] };
    useTasks.setState({ config, attention: {}, failures: {} });
    await refreshTasks("local", "personal", 1_000);
    const cardsIn = () => boardCards(config);
    // Linear took the move, then stopped accepting the token: the sync after it keeps the board's last tasks.
    answers["tracker_tasks linear:acme"] = () => {
      throw { auth: true, message: "Linear no longer accepts this token. Create a new one and paste it here." };
    };
    await moveTask("local", "personal", useTasks.getState().data["local/personal"].tasks[0], "in_progress", 1_500, "Doing");
    await vi.waitFor(() => expect(useTasks.getState().attention["linear:acme"]).toBeTruthy());
    expect(cardsIn()).toEqual([["Todo", []], ["Building", ["MOON-1"]]]);
    // Another workspace's sync reads none of this board's tasks.
    await refreshTasks("local", "acme", 1_600);
    expect(cardsIn()).toEqual([["Todo", []], ["Building", ["MOON-1"]]]);
    // Reconnected, Linear's answer places it.
    answers["tracker_tasks linear:acme"] = () => [lt("MOON-1", "Doing")];
    useTasks.setState({ attention: {} });
    await refreshTasks("local", "personal", 2_000);
    answers["tracker_tasks linear:acme"] = () => [lt("MOON-1", "Todo")];
    await refreshTasks("local", "personal", 3_000);
    expect(cardsIn()).toEqual([["Todo", ["MOON-1"]], ["Building", []]]);
    useTasks.setState({ config: null, attention: {} });
  });

  it("previews a board not saved yet: everyone's issues, the user's own marked, and the tracker's columns (Add a board)", async () => {
    answers["git.origin_url"] = () => null;
    answers["tracker_tasks linear:acme all"] = () => [lt("MOON-1", "Todo"), lt("MOON-2", "Todo")];
    answers["tracker_tasks linear:acme"] = () => [lt("MOON-2", "Todo")];
    answers["board_columns linear:acme"] = () => [{ name: "Todo", statuses: ["Todo"], category: "todo" }];
    useTasks.setState({ attention: {} });
    const p = await previewBoard("local", "personal", board());
    // Only a GitHub Project has a number field to offer.
    expect(p.numberField).toBe(null);
    expect([p.error, p.tasks.map((t) => [t.key, t.mine]), p.columns]).toEqual([
      null,
      [
        ["MOON-1", false],
        ["MOON-2", true],
      ],
      [{ name: "Todo", statuses: ["Todo"], category: "todo" }],
    ]);
    answers["tracker_tasks linear:acme all"] = () => {
      throw { auth: false, message: "Linear: no team MOON" };
    };
    expect((await previewBoard("local", "personal", board())).error).toBe("Linear: no team MOON");
  });

  it("keeps only the issues with any of a board's labels, whatever their case (Add a board, Issues)", async () => {
    answers["git.origin_url"] = () => null;
    answers["tracker_tasks linear:acme all"] = () => [
      { ...lt("MOON-1", "Todo"), labels: ["Frontend", "bug"] },
      { ...lt("MOON-2", "Todo"), labels: ["backend"] },
      { ...lt("MOON-3", "Todo"), labels: ["design"] },
    ];
    answers["tracker_tasks linear:acme"] = () => [];
    useTasks.setState({ attention: {} });
    const p = await previewBoard("local", "personal", board({ labels: ["frontend", "design"] }));
    expect(p.tasks.map((t) => t.key)).toEqual(["MOON-1", "MOON-3"]);
  });

  it("keeps a board's type as its sync read it, for the board switcher", async () => {
    answers["git.origin_url"] = () => null;
    answers["project.worktrees"] = () => [];
    answers["tracker_tasks linear:acme"] = () => [lt("MOON-1", "Todo")];
    answers["board_kind linear:acme"] = () => "kanban";
    useTasks.setState({ config: { ...DEFAULT_CONFIG, boards: [board()] }, attention: {} });
    await refreshTasks("local", "personal", 1_000);
    expect(useTasks.getState().data["local/personal"].boards?.moon).toEqual({ keys: ["linear:acme MOON-1"], sprint: null, kind: "kanban" });
    delete answers["board_kind linear:acme"];
    useTasks.setState({ config: null });
  });

  it("removes a board only after asking, and leaves the sessions and their task links alone", async () => {
    const link = { connection: "linear:acme", key: "MOON-1", url: "" };
    useStore.setState({ sessions: { local: [{ id: "s1", project_id: "web", name: "Hosts", branch: "moon-1-hosts", base: "main", path: "/w/hosts", agent: null, archived: false, created_at: 1, workspace_id: "personal", terminals: [], layout: null, task: link }] } });
    const other = board({ id: "des", name: "Design", origin: { kind: "linear_team" as const, team: "DES" } });
    useTasks.setState({ config: { ...DEFAULT_CONFIG, boards: [board(), other] } });
    saved.length = 0;
    vi.mocked(rpc).mockClear();
    // Kept: nothing saved.
    const kept = removeBoard(board());
    expect(useStore.getState().confirm?.options.title).toBe("Remove Moonlet?");
    answerConfirm(false, false);
    expect(await kept).toBe(false);
    expect(saved).toEqual([]);
    const removed = removeBoard(board());
    answerConfirm(true, false);
    expect(await removed).toBe(true);
    // Only that board goes.
    expect((saved.at(-1) as { boards?: { id: string }[] }).boards?.map((b) => b.id)).toEqual(["des"]);
    // No session is touched: it keeps its link to the task.
    expect(vi.mocked(rpc).mock.calls.filter(([, method]) => String(method).startsWith("session."))).toEqual([]);
    expect(useStore.getState().sessions.local[0].task).toEqual(link);
    useTasks.setState({ config: null });
  });

  it("opens a board of another workspace there, in Tasks mode", () => {
    useStore.setState({ workspace: { host: "local", id: "personal" }, mode: { "local/personal": "tasks" } });
    openBoard("local", "acme", "acme-board");
    expect(useStore.getState().workspace).toEqual({ host: "local", id: "acme", account: "local" });
    expect(useStore.getState().mode["local/acme"]).toBe("tasks");
    expect(useTasks.getState().shownBoard["local/acme"]).toBe("acme-board");
    useTasks.setState({ shownBoard: {} });
  });

  it("previews a JQL board with the site's status names, for a column whose status no issue is in", async () => {
    answers["git.origin_url"] = () => null;
    answers["tracker_tasks jira:acme.atlassian.net"] = () => [];
    answers["status_names jira:acme.atlassian.net"] = () => ({ "10030": "Acceptance Testing" });
    const jql = { id: "ex", name: "Example", connection: "jira:acme.atlassian.net", workspace: "local/personal", origin: { kind: "jql" as const, query: "project = EX" } };
    useTasks.setState({ attention: {} });
    expect((await previewBoard("local", "personal", jql)).statusNames).toEqual({ "10030": "Acceptance Testing" });
  });

  it("names the sync each board read belongs to, so a connection's boards share its lookups within it; a preview belongs to none", async () => {
    answers["git.origin_url"] = () => null;
    answers["project.worktrees"] = () => [];
    answers["tracker_tasks linear:acme"] = () => [lt("MOON-1", "Todo")];
    const design = board({ id: "des", name: "Design", origin: { kind: "linear_team" as const, team: "DES" } });
    useTasks.setState({ config: { ...DEFAULT_CONFIG, boards: [board({ assignee: "anyone" }), design] }, attention: {}, assignee: {} });
    boardQueries.length = 0;
    await refreshTasks("local", "personal", 1_000);
    // Moonlet's two reads (the user's issues and everyone's) and Design's, all one sync.
    expect(boardQueries.length).toBe(3);
    expect(new Set(boardQueries.map((q) => q.sync)).size).toBe(1);
    expect(boardQueries[0].sync).toEqual(expect.any(Number));
    const first = boardQueries[0].sync;
    boardQueries.length = 0;
    await refreshTasks("local", "personal", 2_000);
    expect(boardQueries.every((q) => q.sync !== undefined && q.sync !== first)).toBe(true);
    boardQueries.length = 0;
    await previewBoard("local", "personal", board());
    expect(boardQueries.map((q) => q.sync)).toEqual([undefined, undefined]);
    useTasks.setState({ config: null });
  });

  it("syncs the board shown even when it is not pinned, keeping each board's tasks apart", async () => {
    answers["git.origin_url"] = () => null;
    answers["project.worktrees"] = () => [];
    answers["tracker_tasks linear:acme"] = () => [lt("MOON-1", "Todo")];
    useTasks.setState({ config: { ...DEFAULT_CONFIG, boards: [board({ pinned: false })] }, attention: {} });
    await refreshTasks("local", "personal", 1_000);
    expect(useTasks.getState().data["local/personal"].tasks).toEqual([]);
    showBoard("local", "personal", "moon");
    await vi.waitFor(() => expect(useTasks.getState().data["local/personal"].boards?.moon).toEqual({ keys: ["linear:acme MOON-1"], sprint: null }));
    expect(useTasks.getState().shownBoard["local/personal"]).toBe("moon");
    useTasks.setState({ config: null, shownBoard: {} });
  });
});

describe("moving Linear, Jira and ClickUp issues (X46 Keep in step)", () => {
  const hosts = {
    connection: "linear:acme",
    key: "MOON-142",
    title: "Remote hosts",
    url: "",
    column: "in_progress" as const,
    priority: 0,
    assignees: [],
    labels: [],
    description: "",
    updatedMs: 0,
    tracker: { id: "issue-1", state: "In Progress", source: "MOON" },
  };
  const card = (drift: { kind: "pr_open" | "merged"; text: string; fix: string }) => ({ task: hosts, column: "in_progress" as const, rows: [], needsYou: false, orphans: [], empty: null, drift });

  it("sends the move a chip's fix asks for", async () => {
    sent.length = 0;
    await fixDrift("local", "personal", card({ kind: "pr_open", text: "#131 open", fix: "Move to In Review" }));
    await fixDrift("local", "personal", card({ kind: "merged", text: "#131 merged", fix: "Move to Done" }));
    expect(sent).toEqual([
      { id: "linear:acme", task: "issue-1", source: "MOON", column: "in_review" },
      { id: "linear:acme", task: "issue-1", source: "MOON", column: "done" },
    ]);
  });

  it("runs an automatic fix once: remembered only when it worked, a failure waits for Retry", async () => {
    sent.length = 0;
    localStorage.clear();
    const board = (key: string) => ({ todo: [], in_progress: [{ ...card({ kind: "pr_open", text: "#131 open", fix: "Move to In Review" }), task: { ...hosts, key } }], in_review: [], done: [] });
    failNext.push({ message: "Linear is not answering" });
    await runAutoFixes("local", "personal", board("MOON-142"), () => DEFAULT_RULES);
    expect(autoFixed()).toEqual({});
    expect(failureOf({ ...hosts, key: "MOON-142" })).toBe("Linear is not answering");
    await runAutoFixes("local", "personal", board("MOON-142"), () => DEFAULT_RULES);
    expect(sent).toEqual([]);

    await runAutoFixes("local", "personal", board("MOON-143"), () => DEFAULT_RULES);
    await runAutoFixes("local", "personal", board("MOON-143"), () => DEFAULT_RULES);
    expect(sent).toEqual([{ id: "linear:acme", task: "issue-1", source: "MOON", column: "in_review" }]);
    expect(Object.keys(autoFixed())).toHaveLength(1);
  });

  it("records each PR that opens on a task's sessions once, whatever the rules", async () => {
    const pr = { number: 131, url: "https://github.com/acme/app/pull/131", state: "open", title: "Hosts", checks: [], review_decision: null };
    const t = { ...hosts, key: "MOON-170", column: "in_review" as const };
    const row = { session: { id: "s9", name: "Hosts", branch: "moon-170", path: "/w/moon-170", archived: false, task: null, task_unlinked: false, state: "idle" as const, pr, additions: 0, subagents: 0, originRepo: null }, meta: { text: "#131", tone: "open" as const } };
    const board = { todo: [], in_progress: [], in_review: [{ task: t, column: "in_review" as const, rows: [row], needsYou: false, orphans: [], empty: null, drift: null }], done: [] };
    const off = () => ({ ...DEFAULT_RULES, pr_comment: "off" as const });
    await runAutoFixes("local", "personal", board, off, 7_000);
    await runAutoFixes("local", "personal", board, off, 8_000);
    expect(activityOf(t).filter((e) => e.text.startsWith("PR"))).toEqual([{ at: 7_000, text: "PR #131 opened: Hosts" }]);
  });

  it("moves a tracker issue to In Progress and assigns it when a session starts from it", async () => {
    sent.length = 0;
    await startedFromTask("local", "personal", { ref: { connection: "linear:acme", key: "MOON-151", url: "" }, kind: "linear", key: "MOON-151", title: "Drag", description: "", projects: [], tracker: { id: "issue-2", source: "MOON" } }, { session: "Drag", assign: true });
    expect(sent).toEqual([{ id: "linear:acme", task: "issue-2", source: "MOON", column: "in_progress", assign_me: true }]);
  });
});

describe("loadTrackersConfig", () => {
  it("fills in the trackers the file leaves out because they are at their defaults", async () => {
    useTasks.setState({ config: null });
    await loadTrackersConfig(true);
    const c = trackersConfig(useTasks.getState());
    expect([c.sync.interval, c.github.rules.session_starts, c.github.max_length, c.connections]).toEqual([300, "auto", 48, []]);
    useTasks.setState({ config: null });
  });
});

describe("saveTrackersConfig", () => {
  it("lets a caller wait for writes still on their way, such as a board's columns a sync saves", async () => {
    saved.length = 0;
    await loadTrackersConfig(true);
    void saveTrackersConfig((c) => ({ ...c, sync: { ...c.sync, interval: 45 } }));
    await settleSaves();
    expect((saved.at(-1) as { sync: { interval: number } }).sync.interval).toBe(45);
    useTasks.setState({ config: null });
  });

  it("keeps both of two quick changes", async () => {
    saved.length = 0;
    await loadTrackersConfig(true);
    await Promise.all([
      saveTrackersConfig((c) => ({ ...c, sync: { ...c.sync, notify: false } })),
      saveTrackersConfig((c) => ({ ...c, sync: { ...c.sync, interval: 30 } })),
    ]);
    expect((saved.at(-1) as { sync: object }).sync).toEqual({ interval: 30, notify: false });
    useTasks.setState({ config: null });
  });

  it("waits for the file before changing it, and shows the file again when a write fails", async () => {
    useTasks.setState({ config: null, configError: null });
    await expect(saveTrackersConfig((c) => c)).rejects.toThrow("Task tracker settings are still loading");
    await loadTrackersConfig(true);
    saveFails.push(new Error("disk full"));
    await expect(saveTrackersConfig((c) => ({ ...c, sync: { ...c.sync, interval: 30 } }))).rejects.toThrow("disk full");
    expect(trackersConfig(useTasks.getState()).sync.interval).toBe(300);
    useTasks.setState({ config: null });
  });

  it("drops a change queued behind a write that failed, so the file and the page agree", async () => {
    saved.length = 0;
    await loadTrackersConfig(true);
    saveFails.push(new Error("disk full"));
    const results = await Promise.allSettled([
      saveTrackersConfig((c) => ({ ...c, sync: { ...c.sync, notify: false } })),
      saveTrackersConfig((c) => ({ ...c, sync: { ...c.sync, interval: 30 } })),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(saved).toEqual([]);
    expect(trackersConfig(useTasks.getState()).sync).toEqual({ interval: 300, notify: true });
    useTasks.setState({ config: null });
  });

  it("a change made while a failed write reloads the file is dropped too", async () => {
    saved.length = 0;
    await loadTrackersConfig(true);
    saveFails.push(new Error("disk full"));
    configDelay.ms = 30;
    const failing = saveTrackersConfig((c) => ({ ...c, sync: { ...c.sync, notify: false } }));
    // Made after the failure, while the file is still reloading.
    await new Promise((r) => setTimeout(r, 12));
    const during = saveTrackersConfig((c) => ({ ...c, sync: { ...c.sync, interval: 30 } }));
    const results = await Promise.allSettled([failing, during]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(saved).toEqual([]);
    useTasks.setState({ config: null });
  });

  it("shows no board while trackers.toml can't be read, not even the workspace's repository", async () => {
    answers["git.origin_url"] = ({ path }) => (path === "/r/web" ? "https://github.com/acme/web.git" : null);
    answers["project.worktrees"] = () => [];
    answers["gh.tasks"] = () => [issue];
    useTasks.setState({ config: null, configError: null });
    configFails.push(new Error("TOML parse error at line 3"));
    await refreshTasks("local", "personal", 1_000);
    expect(useTasks.getState().data["local/personal"].tasks).toEqual([]);
    expect(useTasks.getState().data["local/personal"].sources).toEqual([]);
    useTasks.setState({ config: null, configError: null });
  });

  it("does not write over a file it could not read", async () => {
    saved.length = 0;
    configFails.push(new Error("TOML parse error at line 3"));
    await loadTrackersConfig(true);
    await expect(saveTrackersConfig((c) => c)).rejects.toThrow("~/.moonlet/trackers.toml could not be read (TOML parse error at line 3), so it is left as it is");
    expect(saved).toEqual([]);
    useTasks.setState({ config: null, configError: null });
  });
});

describe("moving a task from its state menu, and its activity (X45, X46)", () => {
  const linearTask = {
    connection: "linear:acme",
    key: "MOON-142",
    title: "Remote hosts",
    url: "",
    column: "in_progress" as const,
    priority: 0,
    assignees: [],
    labels: [],
    description: "",
    updatedMs: 0,
    tracker: { id: "issue-1", state: "In Progress", source: "MOON" },
  };

  it("moves a tracker issue to the chosen column and records it", async () => {
    sent.length = 0;
    await moveTask("local", "personal", linearTask, "in_review", 5_000);
    expect(sent).toEqual([{ id: "linear:acme", task: "issue-1", source: "MOON", column: "in_review" }]);
    expect(activityOf(linearTask)[0]).toEqual({ at: 5_000, text: "moonlet moved it to In Review" });
  });


  it("reopens a closed GitHub issue through gh", async () => {
    const asked: object[] = [];
    answers["git.origin_url"] = ({ path }) => (path === "/r/web" ? "https://github.com/acme/web.git" : null);
    answers["project.worktrees"] = () => [];
    answers["gh.tasks"] = () => [];
    await refreshTasks("local", "personal", 1_000);
    answers["gh.task_update"] = (p) => (asked.push(p), true);
    const closed = { ...linearTask, connection: "github:github.com", key: "acme/web#7", column: "done" as const, tracker: undefined, github: { repo: "acme/web", number: 7, closingPrs: [] } };
    await moveTask("local", "personal", closed, null, 6_000);
    expect(asked).toEqual([{ path: "/r/web", number: 7, reopen: true }]);
    expect(activityOf(closed)[0].text).toBe("moonlet reopened it");
  });
});

describe("moving a GitHub repository's issue (X53)", () => {
  it("shows it in Closed at once while gh closes it", async () => {
    answers["git.origin_url"] = ({ path }) => (path === "/r/web" ? "https://github.com/acme/web.git" : null);
    answers["project.worktrees"] = () => [];
    answers["gh.tasks"] = () => [issue];
    let answer = () => {};
    answers["gh.task_update"] = () => new Promise<boolean>((r) => (answer = () => r(true)));
    useTasks.setState({ config: null, attention: {} });
    await refreshTasks("local", "personal", 1_000);
    const config = trackersConfig(useTasks.getState());
    const cardsIn = () => boardCards(config);
    expect(cardsIn()).toEqual([["Open", ["acme/web#12"]], ["Closed", []]]);
    const closing = moveTask("local", "personal", useTasks.getState().data["local/personal"].tasks[0], "done", 2_000, "completed");
    await vi.waitFor(() => expect(cardsIn()).toEqual([["Open", []], ["Closed", ["acme/web#12"]]]));
    answer();
    await closing;
    expect(activityOf({ connection: "github:github.com", key: "acme/web#12" })[0].text).toBe("moonlet closed it");
  });
});

describe("the Task tab's Keep in step switch (X46)", () => {
  it("turns every rule off for that task only, and back on", () => {
    const t = { connection: "linear:acme", key: "MOON-142" };
    expect(rulesFor(DEFAULT_CONFIG, t).session_starts).toBe("auto");
    setKeepInStep(t, false);
    expect(Object.values(rulesFor(DEFAULT_CONFIG, t))).toEqual(["off", "off", "off", "off", "off"]);
    expect(rulesFor(DEFAULT_CONFIG, { connection: "linear:acme", key: "MOON-144" }).session_starts).toBe("auto");
    setKeepInStep(t, true);
    expect(rulesFor(DEFAULT_CONFIG, t).all_merged).toBe("suggest");
  });
});

describe("a failed action shows on its task with Retry (X46)", () => {
  it("keeps the error until a retry works", async () => {
    sent.length = 0;
    const t = { connection: "linear:acme", key: "MOON-9", title: "x", url: "", column: "todo" as const, priority: 0, assignees: [], labels: [], description: "", updatedMs: 0, tracker: { id: "issue-9", state: "Todo", source: "MOON" } };
    failNext.push({ message: "No Jira transition leads to that column from here" });
    useStore.setState({ toasts: [] });
    await moveTask("local", "personal", t, "done", 1_000);
    expect(failureOf(t)).toBe("No Jira transition leads to that column from here");
    // Said at once too: the session's task bar has no detail panel to show it.
    expect(useStore.getState().toasts.map((x) => x.text)).toEqual(["MOON-9: No Jira transition leads to that column from here"]);
    await retryTask(t);
    expect(failureOf(t)).toBe(undefined);
    expect(sent).toEqual([{ id: "linear:acme", task: "issue-9", source: "MOON", column: "done" }]);
  });
});

describe("Retry on a chip's fix (X46)", () => {
  it("fixes the task as it is now: nothing left to fix clears the error without a request", async () => {
    sent.length = 0;
    answers["git.origin_url"] = () => null;
    answers["project.worktrees"] = () => [];
    const t = { connection: "linear:acme", key: "MOON-142", title: "Hosts", url: "", column: "in_progress" as const, priority: 0, assignees: [], labels: [], description: "", updatedMs: 0, tracker: { id: "issue-1", state: "In Progress", source: "MOON" } };
    failNext.push({ message: "Linear is not answering" });
    await fixDrift("local", "personal", { task: t, column: "in_progress", rows: [], needsYou: false, orphans: [], empty: null, drift: { kind: "pr_open", text: "#131 open", fix: "Move to In Review" } });
    expect(failureOf(t)).toBe("Linear is not answering");
    // Meanwhile someone moved it to In Review in Linear.
    useTasks.setState({ data: { "local/personal": { tasks: [{ ...t, column: "in_review" }], worktrees: [], sources: ["linear:acme"], repos: {}, sourceProjects: {}, syncedAt: 2, error: null } } });
    await retryTask(t);
    expect(failureOf(t)).toBe(undefined);
    expect(sent).toEqual([]);
  });
});

describe("each board's Assignee decides whose issues it fetches (X45, X50)", () => {
  const lt = (key: string, source: string, who: string[]) => ({ connection: "linear:acme", key, title: key, url: "", column: "todo", priority: 0, assignees: who, labels: [], description: "", updatedMs: 0, tracker: { id: key, state: "Todo", source } });
  const linear = {
    id: "linear:acme",
    kind: "linear" as const,
    site: "acme",
    account: "Sam",
    auth: "api_key" as const,
    sources: [
      { key: "MOON", name: "Moonlet", workspace: "local/personal" },
      { key: "DES", name: "Design", workspace: "local/personal" },
    ],
  };
  const shown = () => Object.fromEntries(useTasks.getState().data["local/personal"].tasks.map((t) => [t.key, t.mine]));
  const MOON = "linear:acme/MOON@local/personal";
  const DES = "linear:acme/DES@local/personal";
  const WEB = "github:github.com/acme/web@local/personal";
  const anyone = { to: "anyone", over: "me" } as const;
  const me = { to: "me", over: "me" } as const;

  it("takes only the account's issues on a board at Assignee: me, and everyone's open issues on one at anyone", async () => {
    answers["git.origin_url"] = () => null;
    answers["project.worktrees"] = () => [];
    answers["tracker_tasks linear:acme all"] = () => [lt("MOON-1", "MOON", ["Kim"]), lt("MOON-2", "MOON", ["Sam"]), lt("DES-1", "DES", ["Kim"]), lt("DES-3", "DES", ["Sam"])];
    // The tracker's own "assigned to me": DES-3 belongs to another Sam.
    answers["tracker_tasks linear:acme"] = () => [lt("MOON-2", "MOON", ["Sam"]), lt("MOON-9", "MOON", ["Sam"])];
    useTasks.setState({ config: migrateSources({ ...DEFAULT_CONFIG, connections: [linear] }), assignee: {} });
    await refreshTasks("local", "personal", 1_000);
    expect(shown()).toEqual({ "MOON-2": true, "MOON-9": true });
    useTasks.setState({ assignee: { [MOON]: anyone, [DES]: anyone } });
    await refreshTasks("local", "personal", 2_000);
    // Everyone's, marking the account's own; an own issue everyone's left out (it stops at 500) still shows.
    expect(shown()).toEqual({ "MOON-1": false, "MOON-2": true, "DES-1": false, "DES-3": false, "MOON-9": true });
    // Each board by its own: Design back to the user's issues.
    useTasks.setState({ assignee: { [MOON]: anyone, [DES]: me } });
    await refreshTasks("local", "personal", 3_000);
    expect(shown()).toEqual({ "MOON-1": false, "MOON-2": true, "MOON-9": true });
    useTasks.setState({ config: null });
  });

  it("takes a repository's open issues from GitHub too on a board at anyone", async () => {
    const theirs: GhTask = { ...issue, number: 13, title: "Tidy the footer", url: "https://github.com/acme/web/issues/13", assignees: ["kim"] };
    answers["git.origin_url"] = ({ path }) => (path === "/r/web" ? "https://github.com/acme/web.git" : null);
    answers["project.worktrees"] = () => [];
    answers["gh.tasks"] = (p) => ((p as { mine?: boolean }).mine ? [issue] : [issue, theirs]);
    useTasks.setState({ assignee: {} });
    await refreshTasks("local", "personal", 1_000);
    expect(shown()).toEqual({ "acme/web#12": true });
    useTasks.setState({ assignee: { [WEB]: anyone } });
    await refreshTasks("local", "personal", 2_000);
    expect(shown()).toEqual({ "acme/web#12": true, "acme/web#13": false });
  });

  it("takes only the open ones of other people's GitHub issues", async () => {
    const theirsDone: GhTask = { ...issue, number: 14, title: "Old banner", url: "https://github.com/acme/web/issues/14", assignees: ["kim"], closed: true, state_reason: "completed" };
    const theirsOpen: GhTask = { ...issue, number: 13, title: "Tidy the footer", url: "https://github.com/acme/web/issues/13", assignees: ["kim"] };
    answers["git.origin_url"] = ({ path }) => (path === "/r/web" ? "https://github.com/acme/web.git" : null);
    answers["project.worktrees"] = () => [];
    answers["gh.tasks"] = (p) => ((p as { mine?: boolean }).mine ? [issue] : [issue, theirsOpen, theirsDone]);
    useTasks.setState({ assignee: { [WEB]: anyone } });
    await refreshTasks("local", "personal", 1_000);
    expect(shown()).toEqual({ "acme/web#12": true, "acme/web#13": false });
  });

  it("fetches everyone's issues as soon as a board's Assignee is set to anyone, and keeps that per board", async () => {
    const theirs: GhTask = { ...issue, number: 13, title: "Tidy the footer", url: "https://github.com/acme/web/issues/13", assignees: ["kim"] };
    answers["git.origin_url"] = ({ path }) => (path === "/r/web" ? "https://github.com/acme/web.git" : null);
    answers["project.worktrees"] = () => [];
    answers["gh.tasks"] = (p) => ((p as { mine?: boolean }).mine ? [issue] : [issue, theirs]);
    useTasks.setState({ assignee: {} });
    await refreshTasks("local", "personal", 1_000);
    setAssignee({ id: WEB, workspace: "local/personal" }, "anyone");
    await vi.waitFor(() => expect(shown()).toEqual({ "acme/web#12": true, "acme/web#13": false }));
    // Kept in the app across restarts.
    vi.resetModules();
    const restarted = await import("./tasksStore");
    expect(restarted.useTasks.getState().assignee).toEqual({ [WEB]: anyone });
  });

  it("starts each board at its own setting for a new install, and keeps X45's switch left off as anyone", async () => {
    const theirs: GhTask = { ...issue, number: 13, title: "Tidy the footer", url: "https://github.com/acme/web/issues/13", assignees: ["kim"] };
    answers["git.origin_url"] = ({ path }) => (path === "/r/web" ? "https://github.com/acme/web.git" : null);
    answers["project.worktrees"] = () => [];
    answers["gh.tasks"] = (p) => ((p as { mine?: boolean }).mine ? [issue] : [issue, theirs]);
    const restart = async (stored: Record<string, string>) => {
      localStorage.clear();
      for (const [k, v] of Object.entries(stored)) localStorage.setItem(`moonlet.${k}`, v);
      vi.resetModules();
      const fresh = await import("./tasksStore");
      await fresh.refreshTasks("local", "personal", 1_000);
      return Object.fromEntries(fresh.useTasks.getState().data["local/personal"].tasks.map((t) => [t.key, t.mine]));
    };
    // A new install: the repository's board at its own setting, me.
    expect(await restart({})).toEqual({ "acme/web#12": true });
    // Upgraded with Assignee: me turned off: every board at me shows anyone's.
    expect(await restart({ "tasks.filters": JSON.stringify({ mine: false, hideEmptyDone: false }) })).toEqual({ "acme/web#12": true, "acme/web#13": false });
    localStorage.clear();
  });
});

describe("the state mapping (X44 Workflow states, on a board X50)", () => {
  it("places tasks by the board's columns as saved now, without waiting for a sync", () => {
    const qa = { connection: "linear:acme", key: "ENG-1", title: "x", url: "", column: "in_progress" as const, priority: 0, assignees: [], labels: [], description: "", updatedMs: 0, tracker: { id: "i1", state: "QA", source: "ENG" } };
    const data = { tasks: [qa], worktrees: [], sources: ["linear:acme"], repos: {}, sourceProjects: {}, syncedAt: 1, error: null, boards: { eng: { keys: ["linear:acme ENG-1"], sprint: null } } };
    const board = (category: "in_progress" | "in_review") => ({ id: "eng", name: "Engineering", connection: "linear:acme", workspace: "local/personal", origin: { kind: "linear_team" as const, team: "ENG" }, columns: [{ name: "QA", statuses: ["QA"], category }] });
    expect(boardInput(useStore.getState(), "local", "personal", data, { ...DEFAULT_CONFIG, boards: [board("in_review")] }).tasks.map((t) => t.column)).toEqual(["in_review"]);
    expect(boardInput(useStore.getState(), "local", "personal", data, { ...DEFAULT_CONFIG, boards: [board("in_progress")] }).tasks.map((t) => t.column)).toEqual(["in_progress"]);
  });
});

describe("the List layout's open rows (X45)", () => {
  it("are remembered across restarts", async () => {
    setExpanded({});
    toggleExpanded("linear:acme MOON-1");
    toggleExpanded("linear:acme MOON-2");
    toggleExpanded("linear:acme MOON-2");
    vi.resetModules();
    const restarted = await import("./tasksStore");
    expect(restarted.useTasks.getState().expanded).toEqual({ "linear:acme MOON-1": true });
    setExpanded({});
  });
});

describe("a pasted key or URL outside the loaded tasks (X46 link dialog)", () => {
  const conn = (id: string, kind: "linear" | "jira", site: string) => ({ id, kind, site, account: "Sam", auth: "token", sources: [] });

  it("asks GitHub for an issue of the session's repository, or of the repository the URL names", async () => {
    answers["gh.task"] = (p) => ({ ...issue, repo: (p as { repo: string }).repo, number: (p as { number: number }).number, title: "Gift cards", url: "" });
    const seven = await lookUpPasted("local", "/r/web", { kind: "github", key: "#7", site: null }, "acme/web");
    expect([seven?.key, seven?.title]).toEqual(["acme/web#7", "Gift cards"]);
    const other = await lookUpPasted("local", "/r/web", { kind: "github", key: "cli/cli#9", site: null }, "acme/web");
    expect(other?.key).toBe("cli/cli#9");
  });

  it("asks the connection the URL names, or each one of that tracker for a bare key", async () => {
    useTasks.setState({ config: { ...DEFAULT_CONFIG, connections: [conn("linear:acme", "linear", "acme"), conn("jira:ops.atlassian.net", "jira", "ops.atlassian.net")] } });
    const found = { connection: "jira:ops.atlassian.net", key: "OPS-12", title: "Rotate keys", url: "", column: "todo", priority: 0, assignees: [], labels: [], description: "", updatedMs: 0 };
    answers["tracker_task jira:ops.atlassian.net OPS-12"] = () => found;
    expect((await lookUpPasted("local", "/r/web", { kind: null, key: "OPS-12", site: null }, null))?.title).toBe("Rotate keys");
    expect(await lookUpPasted("local", "/r/web", { kind: "jira", key: "OPS-12", site: "other.atlassian.net" }, null)).toBe(null);
    useTasks.setState({ config: null });
  });
});

describe("automatic fixes and failures, second review round (X46)", () => {
  const lt = (key: string, column: "todo" | "in_progress") => ({ connection: "linear:acme", key, title: key, url: "", column, priority: 0, assignees: [], labels: [], description: "", updatedMs: 0, tracker: { id: `i-${key}`, state: "x", source: "MOON" } });
  const openPr = { number: 131, url: "https://github.com/acme/app/pull/131", state: "open", title: "Hosts", checks: [], review_decision: null };
  const row = (id: string) => ({ session: { id, name: id, branch: id, path: `/w/${id}`, archived: false, task: null, task_unlinked: false, state: "idle" as const, pr: openPr, additions: 0, subagents: 0, originRepo: null }, meta: { text: "#131", tone: "open" as const } });

  it("keeps a failed move's error when the PR-link comment after it works", async () => {
    sent.length = 0;
    const t = lt("MOON-201", "in_progress");
    const board = { todo: [], in_progress: [{ task: t, column: "in_progress" as const, rows: [row("s201")], needsYou: false, orphans: [], empty: null, drift: { kind: "pr_open" as const, text: "#131 open", fix: "Move to In Review" } }], in_review: [], done: [] };
    failNext.push({ message: "Linear is not answering" });
    await runAutoFixes("local", "personal", board, () => DEFAULT_RULES, 1_000);
    expect(failureOf(t)).toBe("Linear is not answering");
  });

  it("when the fix and its PR-link comment both fail, Retry sends both", async () => {
    sent.length = 0;
    const t = lt("MOON-204", "in_progress");
    const board = { todo: [], in_progress: [{ task: t, column: "in_progress" as const, rows: [row("s204")], needsYou: false, orphans: [], empty: null, drift: { kind: "pr_open" as const, text: "#131 open", fix: "Move to In Review" } }], in_review: [], done: [] };
    failNext.push({ message: "Linear is not answering" }, { message: "Linear is not answering" });
    await runAutoFixes("local", "personal", board, () => DEFAULT_RULES, 1_000);
    expect(sent).toEqual([]);
    useTasks.setState({ data: { "local/personal": { tasks: [t], worktrees: [], sources: ["linear:acme"], repos: {}, sourceProjects: {}, syncedAt: 1, error: null } } });
    await retryTask(t);
    expect(sent.map((x) => ("comment" in x ? "comment" : "move"))).toContain("comment");
  });

  it("does not try a failed automatic fix again by itself after a restart", async () => {
    sent.length = 0;
    const t = lt("MOON-202", "in_progress");
    const board = { todo: [], in_progress: [{ task: t, column: "in_progress" as const, rows: [], needsYou: false, orphans: [], empty: null, drift: { kind: "pr_open" as const, text: "#131 open", fix: "Move to In Review" } }], in_review: [], done: [] };
    failNext.push({ message: "Linear is not answering" });
    await runAutoFixes("local", "personal", board, () => DEFAULT_RULES, 1_000);
    vi.resetModules();
    const restarted = await import("./tasksStore");
    await restarted.runAutoFixes("local", "personal", board, () => DEFAULT_RULES, 2_000);
    expect(sent).toEqual([]);
  });

  it("Retry follows the rules as they are now: with Keep in step off it moves nothing", async () => {
    sent.length = 0;
    answers["git.origin_url"] = () => null;
    answers["project.worktrees"] = () => [];
    const t = lt("MOON-203", "todo");
    useStore.setState({ sessions: { local: [{ id: "s203", project_id: "web", name: "x", branch: "x", base: "main", path: "/w/x", agent: null, archived: false, created_at: 1, workspace_id: "personal", terminals: [], layout: null, task: { connection: "linear:acme", key: "MOON-203", url: "" } }] } });
    useTasks.setState({ data: { "local/personal": { tasks: [t], worktrees: [], sources: ["linear:acme"], repos: {}, sourceProjects: {}, syncedAt: 1, error: null } } });
    failNext.push({ message: "Linear is not answering" });
    await fixDrift("local", "personal", { task: t, column: "todo", rows: [], needsYou: false, orphans: [], empty: null, drift: { kind: "started", text: "Session open", fix: "In Progress" } });
    setKeepInStep(t, false);
    await retryTask(t);
    expect(sent).toEqual([]);
    expect(failureOf(t)).toBe(undefined);
    setKeepInStep(t, true);
  });

  it("a rejected connection does not stop the workspace's sync", async () => {
    answers["git.origin_url"] = () => null;
    answers["project.worktrees"] = () => [];
    useTasks.setState({ config: { ...DEFAULT_CONFIG, connections: [{ id: "linear:acme", kind: "linear", site: "acme", account: "Sam", auth: "api_key", sources: [{ key: "MOON", name: "M", workspace: "local/personal" }] }] }, attention: { "linear:acme": "Linear no longer accepts this token." } });
    await refreshTasks("local", "personal", 9_000);
    expect([useTasks.getState().data["local/personal"].syncedAt, useTasks.getState().data["local/personal"].error]).toEqual([9_000, null]);
    useTasks.setState({ config: null, attention: {} });
  });

  it("starting a session on a GitHub issue whose repository is in no project says so", async () => {
    useStore.setState({ toasts: [] });
    await startedFromTask("local", "personal", { ref: { connection: "github:github.com", key: "else/where#3", url: "" }, kind: "github", key: "else/where#3", title: "x", description: "", projects: [], github: { repo: "else/where", number: 3 } }, { session: "x", assign: true });
    expect(useStore.getState().toasts.map((x) => x.text)).toEqual(["else/where#3: No project in this workspace has else/where as its origin"]);
  });
});

describe("open spec lines: Activity, comments, drafts and toasts (X45, X46)", () => {
  const lt = (key: string, column: "todo" | "in_progress" | "in_review") => ({ connection: "linear:acme", key, title: key, url: "", column, priority: 0, assignees: [], labels: [], description: "", updatedMs: 0, tracker: { id: `i-${key}`, state: "x", source: "MOON" } });
  const pr = (o: object = {}) => ({ number: 131, url: "https://github.com/acme/app/pull/131", state: "open", title: "Hosts", checks: [], review_decision: null, ...o });
  const rowWith = (id: string, p: object) => ({ session: { id, name: id, branch: id, path: `/w/${id}`, archived: false, task: null, task_unlinked: false, state: "idle" as const, pr: pr(p), additions: 0, subagents: 0, originRepo: null }, meta: { text: "#131", tone: "open" as const } });
  const boardOf = (t: ReturnType<typeof lt>, rows: ReturnType<typeof rowWith>[]) => ({ todo: [], in_progress: [], in_review: [{ task: t, column: "in_review" as const, rows, needsYou: false, orphans: [], empty: null, drift: null }], done: [] });
  const start = (key: string) => ({ ref: { connection: "linear:acme", key, url: "" }, kind: "linear" as const, key, title: key, description: "", projects: [], tracker: { id: `i-${key}`, source: "MOON" } });

  it("records that a session started from the task, and moves and assigns it only when asked", async () => {
    sent.length = 0;
    await startedFromTask("local", "personal", start("MOON-301"), { session: "Drag sessions", assign: false }, 1_000);
    expect(activityOf({ connection: "linear:acme", key: "MOON-301" }).map((e) => e.text)).toEqual(["Session “Drag sessions” started from it"]);
    expect(sent).toEqual([]);
    await startedFromTask("local", "personal", start("MOON-302"), { session: "Hosts", assign: true }, 2_000);
    expect(activityOf({ connection: "linear:acme", key: "MOON-302" }).map((e) => e.text)).toEqual(["moonlet moved it to In Progress and assigned it to you", "Session “Hosts” started from it"]);
  });

  it("says why when the move or assignment of a tracker issue fails", async () => {
    useStore.setState({ toasts: [] });
    failNext.push({ message: "Linear is not answering" });
    await startedFromTask("local", "personal", start("MOON-303"), { session: "x", assign: true }, 3_000);
    expect(useStore.getState().toasts.map((x) => x.text)).toEqual(["MOON-303: Linear is not answering"]);
  });

  it("records the comment moonlet posts, remembers it only once it worked, and shows a failed one with Retry", async () => {
    sent.length = 0;
    const t = lt("MOON-304", "in_review");
    const b = boardOf(t, [rowWith("s304", {})]);
    failNext.push({ message: "Linear is not answering" });
    await runAutoFixes("local", "personal", b, () => DEFAULT_RULES, 4_000);
    expect(Object.keys(autoFixed()).filter((k) => k.startsWith("comment") && k.includes("MOON-304"))).toEqual([]);
    expect(failureOf(t)).toBe("Linear is not answering");
    await retryTask(t);
    expect(sent).toEqual([{ id: "linear:acme", task: "i-MOON-304", source: "MOON", comment: "Opened a pull request: Hosts https://github.com/acme/app/pull/131" }]);
    expect(failureOf(t)).toBe(undefined);
    expect(Object.keys(autoFixed()).filter((k) => k.startsWith("comment") && k.includes("MOON-304"))).toHaveLength(1);
    expect(activityOf(t).map((e) => e.text)).toContain("moonlet commented with the pull request's link");
  });

  it("adds no PR opened for a draft", async () => {
    const t = lt("MOON-305", "in_review");
    await runAutoFixes("local", "personal", boardOf(t, [rowWith("s305", { draft: true })]), () => ({ ...DEFAULT_RULES, pr_comment: "off" }), 5_000);
    expect(activityOf(t)).toEqual([]);
  });

  it("records an assignment on GitHub", async () => {
    answers["git.origin_url"] = ({ path }) => (path === "/r/web" ? "https://github.com/acme/web.git" : null);
    answers["project.worktrees"] = () => [];
    answers["gh.tasks"] = () => [issue];
    answers["gh.task_update"] = () => true;
    await refreshTasks("local", "personal", 1_000);
    await startedFromTask("local", "personal", { ref: { connection: "github:github.com", key: "acme/web#12", url: "" }, kind: "github", key: "acme/web#12", title: "Fix", description: "", projects: [], github: { repo: "acme/web", number: 12 } }, { session: "Fix", assign: true }, 6_000);
    expect(activityOf({ connection: "github:github.com", key: "acme/web#12" }).map((e) => e.text)).toContain("moonlet assigned it to you");
  });
});

describe("the out-of-sync dot's poll and the remembered mode (X45)", () => {
  it("asks for the shown workspace's tasks again every 5 minutes", async () => {
    answers["git.origin_url"] = () => "https://github.com/acme/web.git";
    answers["gh.tasks"] = () => [issue];
    answers["project.worktrees"] = () => [];
    useTasks.setState({ data: {} });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const stop = pollTasks("local", "personal");
      await vi.waitFor(() => expect(useTasks.getState().data["local/personal"]?.syncedAt).toBe(1_000_000));
      await vi.advanceTimersByTimeAsync(299_000);
      expect(useTasks.getState().data["local/personal"].syncedAt).toBe(1_000_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(useTasks.getState().data["local/personal"].syncedAt).toBe(1_300_000));
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("remembers Tasks mode per workspace across restarts", async () => {
    useStore.setState({ mode: {} });
    toggleTasksMode();
    vi.resetModules();
    const store = await import("./store");
    const restarted = await import("./tasksStore");
    expect(restarted.isTasksMode(store.useStore.getState())).toBe(true);
    toggleTasksMode();
  });
});

describe("the header's filters (X45)", () => {
  it("are remembered across restarts", async () => {
    setFilters({ hideEmptyDone: true });
    vi.resetModules();
    const restarted = await import("./tasksStore");
    expect(restarted.useTasks.getState().filters).toEqual({ hideEmptyDone: true });
    setFilters({ hideEmptyDone: false });
  });
});

describe("branchUser (X44 {user} in branch names)", () => {
  it("is the first name of the tracker account, or the gh login, asked once per host", async () => {
    useTasks.setState({ config: { ...DEFAULT_CONFIG, connections: [{ id: "linear:acme", kind: "linear", site: "acme", account: "Ada Lovelace", auth: "api_key", sources: [] }] } });
    expect(await branchUser("local", "linear:acme")).toBe("ada");
    // gh not signed in yet: nothing remembered, so signing in counts at once.
    answers["gh.whoami"] = () => {
      throw new Error("gh is not signed in");
    };
    expect(await branchUser("local", "github:github.com", 1_000)).toBe("");
    answers["gh.whoami"] = () => "sam-rivera";
    expect(await branchUser("local", "github:github.com", 2_000)).toBe("sam-rivera");
    // Asked again only after a minute, so `gh auth switch` shows up then.
    answers["gh.whoami"] = () => "someone-else";
    expect(await branchUser("local", "github:github.com", 30_000)).toBe("sam-rivera");
    expect(await branchUser("local", "github:github.com", 70_000)).toBe("someone-else");
    useTasks.setState({ config: null });
  });
});

describe("a GitHub Project's board (X50 Sync)", () => {
  // The Status options the tests' Projects have, by name.
  const OPTION: Record<string, string> = { Todo: "o1", "In Progress": "o2", Done: "o3" };
  const item = (number: number, status: string | null, assignees: string[]) => ({
    item: `PVTI_${number}`,
    status,
    option: status && OPTION[status],
    task: { repo: "acme/web", number, title: `Issue ${number}`, body: "", url: `https://github.com/acme/web/issues/${number}`, closed: false, state_reason: null, assignees, labels: [], updated_ms: 0, closing_prs: [] },
  });

  it("gives an item's value in the Project's number field as its estimate, and previews the field's name for Cards show", async () => {
    answers["git.origin_url"] = () => null;
    answers["project.worktrees"] = () => [];
    const options = [{ id: "o1", name: "Todo" }];
    answers["gh.project_items"] = () => ({ id: "PVT_1", status_field: "F", options, number_field: "Hours", items: [{ ...item(10, "Todo", ["sam-rivera"]), estimate: 0.5 }, { ...item(11, "Todo", ["sam-rivera"]), estimate: null }] });
    const project = { id: "web-project", name: "Website", connection: "github:github.com", workspace: "local/personal", origin: { kind: "github_project" as const, owner: "acme", number: 2 }, cards: ["points" as const] };
    const p = await previewBoard("local", "personal", project);
    expect(p.tasks.map((t) => [t.key, t.points])).toEqual([
      ["acme/web#10", 0.5],
      ["acme/web#11", undefined],
    ]);
    expect(p.numberField).toBe("Hours");
  });

  it("names a Project's column statuses, its options' ids, by the options' names for step 3, and gives an older host's items their option by name", async () => {
    answers["git.origin_url"] = () => null;
    answers["project.worktrees"] = () => [];
    const options = [{ id: "o1", name: "Todo" }, { id: "o2", name: "In Progress" }];
    // An older daemon sends no option id.
    answers["gh.project_items"] = () => ({ id: "PVT_1", status_field: "F", options, items: [{ ...item(10, "In Progress", ["sam-rivera"]), option: undefined }] });
    const project = { id: "web-project", name: "Website", connection: "github:github.com", workspace: "local/personal", origin: { kind: "github_project" as const, owner: "acme", number: 2 } };
    const p = await previewBoard("local", "personal", project);
    expect(p.statusNames).toEqual({ "": "No Status", o1: "Todo", o2: "In Progress" });
    expect(p.tasks.map((t) => t.github?.project?.option)).toEqual(["o2"]);
  });

  it("reads the Project's issues with their Status, the user's own marked, and its columns from the Status options", async () => {
    answers["git.origin_url"] = () => null;
    answers["project.worktrees"] = () => [];
    const options = [{ id: "o1", name: "Todo" }, { id: "o2", name: "In Progress" }, { id: "o3", name: "Done" }];
    answers["gh.project_items"] = (p) =>
      (p as { mine?: boolean }).mine
        ? { id: "PVT_1", status_field: "F", options, items: [item(10, "Todo", ["sam-rivera"])] }
        : { id: "PVT_1", status_field: "F", options, items: [item(10, "Todo", ["sam-rivera"]), item(11, "In Progress", ["kim"])] };
    const project = { id: "web-project", name: "Website", connection: "github:github.com", workspace: "local/personal", origin: { kind: "github_project" as const, owner: "acme", number: 2 }, assignee: "anyone" as const };
    useTasks.setState({ config: { ...DEFAULT_CONFIG, boards: [project] }, attention: {}, assignee: {} });
    saved.length = 0;
    await refreshTasks("local", "personal", 1_000);
    const tasks = useTasks.getState().data["local/personal"].tasks;
    expect(tasks.map((t) => [t.key, t.column, t.mine, t.github?.project])).toEqual([
      ["acme/web#10", "todo", true, { id: "PVT_1", item: "PVTI_10", status: "Todo", option: "o1" }],
      ["acme/web#11", "in_progress", false, { id: "PVT_1", item: "PVTI_11", status: "In Progress", option: "o2" }],
    ]);
    // Its columns come from the Project's Status options.
    await vi.waitFor(() => expect((saved.at(-1) as { boards?: { columns?: { name: string }[] }[] } | undefined)?.boards?.[0].columns?.map((c) => c.name)).toEqual(expect.arrayContaining(["Todo", "In Progress", "Done"])));
    useTasks.setState({ config: null });
  });

  it("moves an item by setting its Status to the option of the column picked, and knows gh's scopes", async () => {
    answers["git.origin_url"] = () => null;
    answers["project.worktrees"] = () => [];
    const options = [{ id: "o1", name: "Todo" }, { id: "o2", name: "In Progress" }, { id: "o3", name: "Done" }];
    answers["gh.project_items"] = () => ({ id: "PVT_1", status_field: "F", options, items: [item(10, "Todo", ["sam-rivera"])] });
    answers["gh.scopes"] = () => ["repo", "project"];
    const moves: object[] = [];
    answers["gh.project_move"] = (p) => (moves.push(p), true);
    const project = { id: "web-project", name: "Website", connection: "github:github.com", workspace: "local/personal", origin: { kind: "github_project" as const, owner: "acme", number: 2 }, columns: [
      { name: "Todo", statuses: ["o1"], category: "todo" as const },
      { name: "In Progress", statuses: ["o2"], category: "in_progress" as const },
      { name: "Done", statuses: ["o3"], category: "done" as const, show: "fold" as const },
    ] };
    useTasks.setState({ config: { ...DEFAULT_CONFIG, boards: [project] }, attention: {}, assignee: {} });
    await refreshTasks("local", "personal", 1_000);
    await vi.waitFor(() => expect(useTasks.getState().ghScopes.local).toEqual(["repo", "project"]));
    const task = useTasks.getState().data["local/personal"].tasks[0];
    // The State menu's In Progress, by its status (the option's id); a fix's category goes to its column's first status.
    await moveTask("local", "personal", task, "in_progress", 2_000, "o2");
    await moveTask("local", "personal", task, "done", 3_000);
    expect(moves).toEqual([
      { project: "PVT_1", item: "PVTI_10", field: "F", option: "o2" },
      { project: "PVT_1", item: "PVTI_10", field: "F", option: "o3" },
    ]);
    expect(activityOf(task)[0].text).toBe("moonlet moved it to Done");
    // "Open" or "Closed" never reaches a Project's item: no column, no move, and the issue is left alone.
    moves.length = 0;
    await moveTask("local", "personal", task, null, 4_000);
    expect(moves).toEqual([]);
    // A fix that moves to the next column sets that option.
    const drift = { kind: "pr_open" as const, text: "#31 open", fix: "Move to In Progress", to: { column: "In Progress", category: "in_progress" as const, statuses: ["o2"] } };
    await fixDrift("local", "personal", { task, column: "todo", rows: [], needsYou: false, orphans: [], empty: null, drift });
    expect(moves).toEqual([{ project: "PVT_1", item: "PVTI_10", field: "F", option: "o2" }]);
    useTasks.setState({ config: null });
  });

  it("shows a moved item in its new column at once, No Status too (X53)", async () => {
    answers["git.origin_url"] = () => null;
    answers["project.worktrees"] = () => [];
    const options = [{ id: "o1", name: "Todo" }, { id: "o2", name: "In Progress" }];
    answers["gh.project_items"] = () => ({ id: "PVT_1", status_field: "F", options, items: [item(10, "Todo", ["sam-rivera"])] });
    answers["gh.scopes"] = () => ["repo", "project"];
    let answer = () => {};
    answers["gh.project_move"] = () => new Promise<boolean>((r) => (answer = () => r(true)));
    const project = { id: "web-project", name: "Website", connection: "github:github.com", workspace: "local/personal", origin: { kind: "github_project" as const, owner: "acme", number: 2 }, columns: [
      { name: "No Status", statuses: [""], category: "todo" as const },
      { name: "Todo", statuses: ["o1"], category: "todo" as const },
      { name: "In Progress", statuses: ["o2"], category: "in_progress" as const },
    ] };
    const config = { ...DEFAULT_CONFIG, boards: [project] };
    useTasks.setState({ config, attention: {}, assignee: {} });
    await refreshTasks("local", "personal", 1_000);
    const cardsIn = () => boardCards(config);
    const task = useTasks.getState().data["local/personal"].tasks[0];
    const toInProgress = moveTask("local", "personal", task, "in_progress", 2_000, "o2");
    await vi.waitFor(() => expect(cardsIn()).toEqual([["No Status", []], ["Todo", []], ["In Progress", ["acme/web#10"]]]));
    answer();
    await toInProgress;
    const toNoStatus = moveTask("local", "personal", task, "todo", 3_000, "");
    await vi.waitFor(() => expect(cardsIn()).toEqual([["No Status", ["acme/web#10"]], ["Todo", []], ["In Progress", []]]));
    answer();
    await toNoStatus;
    useTasks.setState({ config: null });
  });

  it("moves an issue on two Projects through the Project its item is in", async () => {
    answers["git.origin_url"] = () => null;
    answers["project.worktrees"] = () => [];
    const options = (p: string) => [{ id: `${p}-todo`, name: "Todo" }, { id: `${p}-done`, name: "Done" }];
    answers["gh.project_items"] = (p) =>
      (p as { number: number }).number === 1
        ? { id: "PVT_A", status_field: "FA", options: options("a"), items: [{ ...item(10, "Todo", ["sam-rivera"]), item: "PVTI_A10" }] }
        : { id: "PVT_B", status_field: "FB", options: options("b"), items: [{ ...item(10, "Todo", ["sam-rivera"]), item: "PVTI_B10" }] };
    answers["gh.scopes"] = () => ["project"];
    const moves: object[] = [];
    answers["gh.project_move"] = (p) => (moves.push(p), true);
    const cols = [
      { name: "Todo", statuses: ["Todo"], category: "todo" as const },
      { name: "Done", statuses: ["Done"], category: "done" as const },
    ];
    const board = (id: string, number: number) => ({ id, name: id, connection: "github:github.com", workspace: "local/personal", origin: { kind: "github_project" as const, owner: "acme", number }, columns: cols });
    useTasks.setState({ config: { ...DEFAULT_CONFIG, boards: [board("a", 1), board("b", 2)] }, attention: {}, assignee: {} });
    await refreshTasks("local", "personal", 1_000);
    const shown = useTasks.getState().data["local/personal"].tasks[0];
    // The issue as Project B's item, as its board shows it: the move goes to B, not to A listed first.
    const inB = { ...shown, github: { ...shown.github!, project: { id: "PVT_B", item: "PVTI_B10", status: "Todo" } } };
    await moveTask("local", "personal", inB, "done", 2_000);
    expect(moves).toEqual([{ project: "PVT_B", item: "PVTI_B10", field: "FB", option: "b-done" }]);
    useTasks.setState({ config: null });
  });
});

describe("a new issue from a column (X52)", () => {
  const issue = (key: string, state: string, assignees: string[] = ["Sam Rivera"]) => ({ connection: "linear:acme", key, title: "Retry failed webhook deliveries", url: `https://linear.app/acme/issue/${key}`, column: "in_review", priority: 0, assignees, labels: [], description: "", updatedMs: 0, statusId: "", tracker: { id: `i-${key}`, state, source: "MOON" } });
  const review = { name: "In Review", statuses: ["In Review"], category: "in_review" as const };
  const moon = { id: "moon", name: "Moonlet", connection: "linear:acme", workspace: "local/personal", origin: { kind: "linear_team" as const, team: "MOON" }, columns: [{ name: "Todo", statuses: ["Todo"], category: "todo" as const }, review] };
  const draft = { title: "Retry failed webhook deliveries", description: "", assignee: "me", labels: [] };

  it("creates it in the column's state, shows its card selected with Activity, and keeps it through a sync that started before it", async () => {
    answers["git.origin_url"] = () => null;
    answers["project.worktrees"] = () => [];
    answers["tracker_tasks linear:acme"] = () => [];
    useTasks.setState({ config: { ...DEFAULT_CONFIG, boards: [moon] }, attention: {}, assignee: {}, selected: null });
    await refreshTasks("local", "personal", 500);
    answers["tracker_create linear:acme"] = () => issue("MOON-142", "In Review");
    creates.length = 0;
    // Linear answers at 2 000.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(2_000);
    await createIssue("local", "personal", moon, review, draft);
    vi.useRealTimers();
    expect(creates).toEqual([{ id: "linear:acme", place: "MOON", issue: { ...draft, status: "In Review" }, inCycle: false, statuses: ["In Review"], column: "In Review" }]);
    const data = () => useTasks.getState().data["local/personal"];
    expect([data().tasks.map((t) => t.key), data().boards?.moon.keys, useTasks.getState().selected]).toEqual([["MOON-142"], ["linear:acme MOON-142"], "linear:acme MOON-142"]);
    expect(activityOf({ connection: "linear:acme", key: "MOON-142" })[0].text).toBe("moonlet created it");
    // A sync that started at 1 000, before the create, without it: the card stays.
    await refreshTasks("local", "personal", 1_000);
    expect(data().tasks.map((t) => t.key)).toEqual(["MOON-142"]);
    // One that started after it and still lacks it: the board doesn't show it.
    await refreshTasks("local", "personal", 3_000);
    expect(data().tasks.map((t) => t.key)).toEqual([]);
    expect(useStore.getState().toasts.at(-1)?.text).toBe("Created MOON-142; this board doesn't show it");
    useTasks.setState({ config: null });
  });

  it("keeps the card through a sync that started while the tracker was creating it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1_000);
      answers["git.origin_url"] = () => null;
      answers["project.worktrees"] = () => [];
      answers["tracker_tasks linear:acme"] = () => [];
      useTasks.setState({ config: { ...DEFAULT_CONFIG, boards: [moon] }, attention: {}, assignee: {}, selected: null });
      await refreshTasks("local", "personal", 500);
      // Linear answers at 5 000; a sync that started at 3 000, while it worked, read it without the issue.
      answers["tracker_create linear:acme"] = () => (vi.setSystemTime(5_000), issue("MOON-144", "In Review"));
      await createIssue("local", "personal", moon, review, draft);
      await refreshTasks("local", "personal", 3_000);
      expect(useTasks.getState().data["local/personal"].tasks.map((t) => t.key)).toEqual(["MOON-144"]);
    } finally {
      vi.useRealTimers();
      useTasks.setState({ config: null });
    }
  });

  it("creates a ClickUp task in the board's list, its card showing the Markdown typed", async () => {
    const list = { id: "web", name: "Website", connection: "clickup:9015000001", workspace: "local/personal", origin: { kind: "clickup_list" as const, list: "901500000002" }, columns: [{ name: "in progress", statuses: ["in progress"], category: "in_progress" as const }] };
    useTasks.setState({ config: { ...DEFAULT_CONFIG, boards: [list] }, attention: {}, assignee: {}, selected: null });
    // ClickUp answers with the description as plain text.
    answers["tracker_create clickup:9015000001"] = () => ({ ...issue("CU-869e2e001", "in progress"), description: "Back off exponentially.", connection: "clickup:9015000001", tracker: { id: "869e2e001", state: "in progress", source: "901500000002" } });
    creates.length = 0;
    const typed = { ...draft, description: "Back off **exponentially**." };
    const task = await createIssue("local", "personal", list, list.columns[0], typed);
    expect(creates).toEqual([{ id: "clickup:9015000001", place: "901500000002", issue: { ...typed, status: "in progress" }, inCycle: false, statuses: ["in progress"], column: "in progress" }]);
    // The card shows the Markdown the user typed until the next sync reads ClickUp's.
    expect(task.description).toBe("Back off **exponentially**.");
    useTasks.setState({ config: null });
  });

  it("creates a GitHub issue in the board's repository through gh, its card in Open", async () => {
    const repo = { id: "github:github.com/acme/web@local/personal", name: "acme/web", connection: "github:github.com", workspace: "local/personal", origin: { kind: "github_repo" as const, repo: "acme/web" }, columns: [{ name: "Open", statuses: ["open"], category: "todo" as const }, { name: "Closed", statuses: ["completed", "not_planned"], category: "done" as const, show: "fold" as const }] };
    useTasks.setState({ config: { ...DEFAULT_CONFIG, boards: [repo] }, attention: {}, assignee: {}, selected: null });
    const asked: object[] = [];
    answers["gh.issue_create"] = (p) => (asked.push(p), { task: { repo: "acme/web", number: 1, title: "Retry failed webhook deliveries", body: "", url: "https://github.com/acme/web/issues/1", closed: false, state_reason: null, assignees: ["sam-rivera"], labels: ["bug"], updated_ms: 0, closing_prs: [] }, node: "I_e2e0001" });
    const task = await createIssue("local", "personal", repo, repo.columns[0], { ...draft, labels: ["bug"] });
    expect(asked).toEqual([{ repo: "acme/web", title: "Retry failed webhook deliveries", body: "", assignee: "me", labels: ["bug"] }]);
    expect([task.key, task.column, useTasks.getState().selected]).toEqual(["acme/web#1", "open", "github:github.com acme/web#1"]);
    useTasks.setState({ config: null });
  });

  it("creates a GitHub Project's issue in the chosen repository, adds it, and sets its Status to the column's option", async () => {
    const columns = [{ name: "No Status", statuses: [""], category: "todo" as const }, { name: "In Progress", statuses: ["o2"], category: "in_progress" as const }];
    const board = { id: "web-project", name: "Website", connection: "github:github.com", workspace: "local/personal", origin: { kind: "github_project" as const, owner: "acme", number: 2 }, columns };
    const meta = { id: "PVT_1", field: "F", options: [{ id: "o2", name: "In Progress" }] };
    useTasks.setState({ config: { ...DEFAULT_CONFIG, boards: [board] }, attention: {}, assignee: {}, selected: null, data: { "local/personal": { tasks: [], worktrees: [], sources: [], repos: {}, sourceProjects: {}, syncedAt: 1, error: null, boards: { "web-project": { keys: [], project: meta } } } } });
    const calls: [string, object][] = [];
    const created = { task: { repo: "acme/web", number: 57, title: "Retry failed webhook deliveries", body: "", url: "https://github.com/acme/web/issues/57", closed: false, state_reason: null, assignees: ["sam-rivera"], labels: [], updated_ms: 0, closing_prs: [] }, node: "I_e2e0001" };
    answers["gh.issue_create"] = (p) => (calls.push(["create", p]), created);
    answers["gh.project_add"] = (p) => (calls.push(["add", p]), "PVTI_57");
    answers["gh.project_move"] = (p) => (calls.push(["move", p]), true);
    const task = await createIssue("local", "personal", board, columns[1], { ...draft, place: "acme/web" });
    expect(calls).toEqual([
      ["create", { repo: "acme/web", title: "Retry failed webhook deliveries", body: "", assignee: "me", labels: [] }],
      ["add", { project: "PVT_1", content: "I_e2e0001" }],
      ["move", { project: "PVT_1", item: "PVTI_57", field: "F", option: "o2" }],
    ]);
    expect([task.key, task.github?.project, useTasks.getState().selected]).toEqual(["acme/web#57", { id: "PVT_1", item: "PVTI_57", status: "In Progress", option: "o2" }, "github:github.com acme/web#57"]);
    // No Status: added, no Status set.
    calls.length = 0;
    await createIssue("local", "personal", board, columns[0], { ...draft, place: "acme/web" });
    expect(calls.map(([what]) => what)).toEqual(["create", "add"]);
    // Setting its Status fails once it is added: the card is in No Status, and the notice says so.
    answers["gh.project_move"] = () => {
      throw new Error("Changing a Project's items needs gh's project scope. Run gh auth refresh -s project.");
    };
    const unset = await createIssue("local", "personal", board, columns[1], { ...draft, place: "acme/web" });
    expect([unset.github?.project?.option, unset.column]).toEqual([null, "todo"]);
    expect(useStore.getState().toasts.at(-1)?.text).toBe("Created acme/web#57; setting its Status failed: Changing a Project's items needs gh's project scope. Run gh auth refresh -s project.");
    // Adding it fails once the issue exists: the form closes, the notice says what was done, and no card is selected.
    useTasks.setState({ selected: null });
    answers["gh.project_add"] = () => {
      throw new Error("GitHub did not add the issue to the Project");
    };
    await createIssue("local", "personal", board, columns[1], { ...draft, place: "acme/web" });
    expect(useStore.getState().toasts.at(-1)?.text).toBe("Created acme/web#57; adding it to the Project failed: GitHub did not add the issue to the Project");
    expect(useTasks.getState().selected).toBe(null);
    // Before the board has read its Project, nothing is created and the form says why.
    calls.length = 0;
    useTasks.setState((t) => ({ data: { ...t.data, "local/personal": { ...t.data["local/personal"], boards: {} } } }));
    await expect(createIssue("local", "personal", board, columns[1], { ...draft, place: "acme/web" })).rejects.toThrow("The board hasn't read its Project yet; refresh it first");
    expect(calls).toEqual([]);
    useTasks.setState({ config: null });
  });

  it("creates a Jira issue in the picked project and the column, in the board's sprint, and says when Jira can't move it there", async () => {
    const columns = [{ name: "To Do", statuses: ["10000"], category: "todo" as const }, { name: "In Progress", statuses: ["3", "5"], category: "in_progress" as const }];
    const board = { id: "ex", name: "Example", connection: "jira:acme.atlassian.net", workspace: "local/personal", origin: { kind: "jql" as const, query: "project = EX" }, finished: "sprint" as const, columns };
    const sprint = { id: 42, name: "Sprint 42", startMs: 0, endMs: 1 };
    useTasks.setState({ config: { ...DEFAULT_CONFIG, boards: [board] }, attention: {}, assignee: {}, selected: null, data: { "local/personal": { tasks: [], worktrees: [], sources: [], repos: {}, sourceProjects: {}, syncedAt: 1, error: null, boards: { ex: { keys: [], sprint } } } } });
    // Jira created it in To Do and has no transition to In Progress from there.
    answers["tracker_create jira:acme.atlassian.net"] = () => ({ issue: { ...issue("EX-24", "To Do"), connection: "jira:acme.atlassian.net", statusId: "10000", tracker: { id: "10024", state: "To Do", source: "EX", statusId: "10000" } }, failed: " in To Do; Jira has no way to move it to In Progress from there" });
    creates.length = 0;
    const jira = { ...draft, place: "EX", issueType: "10001" };
    const task = await createIssue("local", "personal", board, columns[1], jira);
    expect(creates).toEqual([{ id: "jira:acme.atlassian.net", place: "EX", issue: { ...jira, status: "3" }, inCycle: true, statuses: ["3", "5"], column: "In Progress", sprint: 42 }]);
    expect(useStore.getState().toasts.at(-1)?.text).toBe("Created EX-24 in To Do; Jira has no way to move it to In Progress from there");
    // It shows where Jira put it.
    expect(task.column).toBe("todo");
    useTasks.setState({ config: null });
  });

  it("raises no 'moved outside moonlet' notice for the column it created the issue in, but does when someone moves it after", async () => {
    shown.length = 0;
    answers["git.origin_url"] = () => null;
    answers["project.worktrees"] = () => [];
    answers["tracker_tasks linear:acme"] = () => [];
    useTasks.setState({ config: { ...DEFAULT_CONFIG, boards: [moon] }, attention: {}, assignee: {}, selected: null });
    await refreshTasks("local", "personal", 500);
    answers["tracker_create linear:acme"] = () => issue("MOON-142", "In Review");
    await createIssue("local", "personal", moon, review, draft);
    // A session starts on it before the next sync.
    useStore.setState({ sessions: { local: [{ id: "s1", project_id: "web", name: "Retry", branch: "moon-142-retry", base: "main", path: "/w/retry", agent: null, archived: false, created_at: 1, workspace_id: "personal", terminals: [], layout: null, task: { connection: "linear:acme", key: "MOON-142", url: "" } }] } });
    answers["tracker_tasks linear:acme"] = () => [issue("MOON-142", "In Review")];
    await refreshTasks("local", "personal", Date.now() + 1_000);
    // Someone moves it back to Todo in Linear: that is news, and the only notice, so the sync before raised none.
    answers["tracker_tasks linear:acme"] = () => [{ ...issue("MOON-142", "Todo"), column: "todo" }];
    await refreshTasks("local", "personal", Date.now() + 2_000);
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    expect(shown).toEqual([{ title: "MOON-142 moved to Todo", body: "Retry failed webhook deliveries" }]);
    useStore.setState({ sessions: {} });
    useTasks.setState({ config: null });
  });

  it("says at once when the board can't show it, and keeps the form open on a refusal", async () => {
    useTasks.setState({ config: { ...DEFAULT_CONFIG, boards: [moon] }, attention: {}, assignee: {}, selected: null });
    answers["tracker_create linear:acme"] = () => issue("MOON-143", "In Review", ["Kim Park"]);
    // Assigned to someone else, on a board at Assignee: me.
    await createIssue("local", "personal", moon, review, { ...draft, assignee: "kim" });
    expect(useStore.getState().toasts.at(-1)?.text).toBe("Created MOON-143; this board doesn't show it");
    // With a link to it in the tracker.
    const open = useStore.getState().toasts.at(-1)?.action;
    expect(open?.label).toBe("Open");
    open?.run();
    expect(opened).toEqual(["https://linear.app/acme/issue/MOON-143"]);
    expect(useTasks.getState().selected).toBe(null);
    delete answers["tracker_create linear:acme"];
    await expect(createIssue("local", "personal", moon, review, draft)).rejects.toThrow("Linear: no such team");
    useTasks.setState({ config: null });
  });
});

describe("errors as the user reads them", () => {
  it("shows a Tauri command's refusal by its message, not [object Object]", async () => {
    // Tauri commands reject with a plain { message } object, here trackers.toml's save.
    useTasks.setState({ config: { ...DEFAULT_CONFIG, boards: [{ id: "moon", name: "Moonlet", connection: "linear:acme", workspace: "local/personal", origin: { kind: "linear_team", team: "MOON" } }] } });
    // Earlier tests' saves land first.
    await saveTrackersConfig((c) => c).catch(() => {});
    saveFails.push({ message: "Could not write trackers.toml: permission denied" });
    setColumnShow("moon", "Todo", "fold");
    await vi.waitFor(() => expect(useStore.getState().toasts.at(-1)?.text).toBe("Could not write trackers.toml: permission denied"));
    useTasks.setState({ config: null });
  });
});

describe("a board's sessions across the members of an account (X68)", () => {
  const identity = { origin: "github.com/acme/web", root: "r1" };
  const session = (id: string, project_id: string): Session => ({ id, project_id, name: id, branch: `moonlet/${id}`, base: "main", path: `/w/${id}`, agent: null, archived: false, created_at: 0, workspace_id: "W", terminals: [], layout: null });
  const data: TasksData = { tasks: [], worktrees: [], sources: [], repos: { p1: "acme/web" }, syncedAt: null, error: null };

  it("takes every member's sessions of the workspace, each with its host and its project's repository", () => {
    const state = {
      ...useStore.getState(),
      sessions: { local: [session("s1", "p1")], "studio-mini": [session("s2", "q1"), { ...session("s3", "q1"), workspace_id: "other" }] },
      projects: {
        local: [{ id: "p1", name: "web", path: "/web", base_branch: "main", identity }],
        "studio-mini": [{ id: "q1", name: "web", path: "/code/web", base_branch: "main", identity }],
      },
    };
    const input = boardInput(state, "local", "W", data, DEFAULT_CONFIG, ["local", "studio-mini"]);
    expect(input.sessions.map((x) => [x.id, x.host ?? null, x.project, x.originRepo])).toEqual([
      ["s1", null, "web", "acme/web"],
      ["s2", "studio-mini", "web", "acme/web"],
    ]);
    // Without members, the host's own as before.
    expect(boardInput(state, "local", "W", data, DEFAULT_CONFIG).sessions.map((x) => x.id)).toEqual(["s1"]);
  });
});

