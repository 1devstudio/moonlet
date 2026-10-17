import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GhTask, Section, Workspace } from "./protocol";
import { migrateSources } from "./boards";
import { DEFAULT_RULES } from "./keepInStep";
import { useStore } from "./store";
import { activityOf, autoFixed, boardInput, showBoard, branchUser, DEFAULT_CONFIG, ensureTasks, failureOf, fixDrift, isTasksMode, loadTrackersConfig, lookUpPasted, moveTask, reconnected, refreshTasks, retryTask, rulesFor, runAutoFixes, pollTasks, saveTrackersConfig, setExpanded, setFilters, setKeepInStep, startedFromTask, syncTasks, toggleExpanded, toggleTasksMode, trackersConfig, useTasks } from "./tasksStore";

const answers: Record<string, (params: { path?: string; id?: string }) => unknown> = {};
vi.mock("./daemon", () => ({
  rpc: vi.fn((_host: string, method: string, params: { path?: string; id?: string }) => {
    const answer = answers[method];
    return answer ? Promise.resolve().then(() => answer(params)) : Promise.reject(new Error(`no ${method}`));
  }),
  sendInput: vi.fn(),
  hostsApi: {
    trackersConfig: () =>
      new Promise((r) => setTimeout(r, configDelay.ms)).then(() => (configFails.length ? Promise.reject(configFails.shift()) : (file.config ?? { sync: { interval: 300, notify: true } }))),
    trackersSave: (c: object) => new Promise<void>((r, no) => setTimeout(() => (saveFails.length ? no(saveFails.shift()) : (saved.push(c), r())), 5)),
    trackerUpdate: (req: object) => (failNext.length ? Promise.reject(failNext.shift()) : (sent.push(req), Promise.resolve())),
    trackerTask: (id: string, key: string) => Promise.resolve(answers[`tracker_task ${id} ${key}`]?.({}) ?? null),
    // A Linear team's or ClickUp list's board (X50): that source's issues
    // from the tracker_tasks answers, and its columns when a test gives them.
    trackerBoardTasks: (q: { id: string; origin: { team?: string; list?: string; query?: string }; mine: boolean }) => {
      const answer = answers[`tracker_tasks ${q.id}${q.mine ? "" : " all"}`] ?? answers[`tracker_tasks ${q.id}`];
      if (!answer) return Promise.reject(new Error(`no tracker_board_tasks ${q.id}`));
      const source = q.origin.team ?? q.origin.list;
      return Promise.resolve().then(() => ({
        issues: (answer({ id: source }) as { tracker?: { source: string } }[]).filter((t) => !source || t.tracker?.source === source).map((t) => ({ ...t, statusId: "" })),
        sprint: null,
        columns: answers[`board_columns ${q.id}`]?.({}) ?? null,
      }));
    },
  },
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: () => Promise.resolve() }) }));
const shown = vi.hoisted(() => [] as { title: string; body: string }[]);
const sent = vi.hoisted(() => [] as object[]);
const failNext = vi.hoisted(() => [] as object[]);
const configFails = vi.hoisted(() => [] as object[]);
const configDelay = vi.hoisted(() => ({ ms: 0 }));
/** What trackers.toml holds, when a test gives it. */
const file = vi.hoisted(() => ({ config: null as object | null }));
const saved = vi.hoisted(() => [] as object[]);
const saveFails = vi.hoisted(() => [] as object[]);
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(true),
  requestPermission: () => Promise.resolve("granted"),
  sendNotification: (n: { title: string; body: string }) => shown.push(n),
}));

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

beforeEach(() => {
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
    tasksMode: {},
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

    useTasks.setState({ config: { ...DEFAULT_CONFIG, sync: { interval: 60, notify: false } } });
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
    useTasks.setState({ config: config([{ key: "MOON", workspace: "local/personal" }]), attention: {} });
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

  it("turns the file's sources into boards when it loads, and gives the workspace's repository its board on the first sync", async () => {
    answers["git.origin_url"] = ({ path }) => (path === "/r/web" ? "https://github.com/acme/web.git" : null);
    answers["project.worktrees"] = () => [];
    answers["gh.tasks"] = () => [issue];
    answers["tracker_tasks linear:acme"] = () => [lt("MOON-1", "Todo")];
    saved.length = 0;
    file.config = { sync: { interval: 300, notify: true }, connections: [{ id: "linear:acme", kind: "linear", site: "acme", account: "Sam", auth: "api_key", sources: [{ key: "MOON", name: "Moonlet", workspace: "local/acme" }] }] };
    useTasks.setState({ config: null, attention: {} });
    try {
      await refreshTasks("local", "personal", 1_000);
      // Written to trackers.toml: the source as a board in its workspace, then the repository's board here.
      await vi.waitFor(() =>
        expect((saved.at(-1) as { boards?: { name: string; workspace: string }[] })?.boards?.map((b) => [b.name, b.workspace])).toEqual([
          ["Moonlet", "local/acme"],
          ["acme/web", "local/personal"],
        ]),
      );
      expect((saved.at(-1) as { connections: { sources: unknown[] }[] }).connections[0].sources).toEqual([]);
      expect(useTasks.getState().data["local/personal"].tasks.map((t) => t.key)).toEqual(["acme/web#12"]);
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
    // The user folded In Progress; In Review is new in Linear.
    useTasks.setState({
      config: { ...DEFAULT_CONFIG, migrated: ["local/personal"], boards: [board({ columns: [{ name: "In Progress", statuses: ["In Progress"], category: "in_progress", show: "fold" }] })] },
      attention: {},
    });
    await refreshTasks("local", "personal", 1_000);
    expect(useTasks.getState().config?.boards?.[0].columns).toEqual([
      { name: "In Progress", statuses: ["In Progress"], category: "in_progress", show: "fold" },
      { name: "Triage", statuses: ["Triage"], category: "todo", show: "hide" },
      { name: "In Review", statuses: ["In Review"], category: "in_review" },
    ]);
    expect(useTasks.getState().data["local/personal"].tasks.map((t) => [t.key, t.column])).toEqual([
      ["MOON-1", "in_review"],
      ["MOON-2", "hidden"],
    ]);
    useTasks.setState({ config: null });
  });

  it("keeps a failed board's own last tasks, and takes its connection's other boards fresh", async () => {
    answers["git.origin_url"] = () => null;
    answers["project.worktrees"] = () => [];
    const des = (key: string) => ({ ...lt(key, "Todo"), tracker: { id: key, state: "Todo", source: "DES" } });
    answers["tracker_tasks linear:acme"] = () => [lt("MOON-1", "Todo"), des("DES-1")];
    const boards = [board(), board({ id: "des", name: "Design", origin: { kind: "linear_team" as const, team: "DES" } })];
    useTasks.setState({ config: { ...DEFAULT_CONFIG, migrated: [], boards }, attention: {} });
    await refreshTasks("local", "personal", 1_000);
    answers["tracker_tasks linear:acme"] = ({ id }) => {
      if (id === "MOON") throw { auth: false, message: "cannot reach Linear" };
      return [des("DES-2")];
    };
    await refreshTasks("local", "personal", 2_000);
    expect(useTasks.getState().data["local/personal"].tasks.map((t) => t.key).sort()).toEqual(["DES-2", "MOON-1"]);
    expect(useTasks.getState().data["local/personal"].error).toBe("cannot reach Linear");
    useTasks.setState({ config: null });
  });

  it("moves a task to the first status of its board's column of that category", async () => {
    answers["git.origin_url"] = () => null;
    answers["project.worktrees"] = () => [];
    answers["tracker_tasks linear:acme"] = () => [lt("MOON-1", "Todo")];
    // The team's In Progress column holds "Doing" first.
    const columns = [
      { name: "Todo", statuses: ["Todo"], category: "todo" as const },
      { name: "In Progress", statuses: ["Doing", "In Progress"], category: "in_progress" as const },
    ];
    useTasks.setState({ config: { ...DEFAULT_CONFIG, boards: [board({ columns })] }, attention: {} });
    await refreshTasks("local", "personal", 1_000);
    sent.length = 0;
    await moveTask("local", "personal", useTasks.getState().data["local/personal"].tasks[0], "in_progress", 1_500);
    expect(sent).toEqual([{ id: "linear:acme", task: "MOON-1", source: "MOON", column: "in_progress", status: "Doing" }]);
    // The State menu names the column: its status, not the category's first.
    sent.length = 0;
    await moveTask("local", "personal", useTasks.getState().data["local/personal"].tasks[0], "in_progress", 1_600, "In Progress");
    expect(sent).toEqual([{ id: "linear:acme", task: "MOON-1", source: "MOON", column: "in_progress", status: "In Progress" }]);
    useTasks.setState({ config: null });
  });

  it("syncs the board shown even when it is not pinned, keeping each board's tasks apart", async () => {
    answers["git.origin_url"] = () => null;
    answers["project.worktrees"] = () => [];
    answers["tracker_tasks linear:acme"] = () => [lt("MOON-1", "Todo")];
    useTasks.setState({ config: { ...DEFAULT_CONFIG, migrated: ["local/personal"], boards: [board({ pinned: false })] }, attention: {} });
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
    await startedFromTask("local", "personal", { ref: { connection: "linear:acme", key: "MOON-151", url: "" }, kind: "linear", key: "MOON-151", title: "Drag", firstMessage: "", projects: [], tracker: { id: "issue-2", source: "MOON" } }, { session: "Drag", assign: true });
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

describe("Assignee: me decides whose issues are fetched (X45)", () => {
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

  it("takes only the account's issues while the filter is on, and everyone's open issues once it is off", async () => {
    answers["git.origin_url"] = () => null;
    answers["project.worktrees"] = () => [];
    answers["tracker_tasks linear:acme all"] = () => [lt("MOON-1", "MOON", ["Kim"]), lt("MOON-2", "MOON", ["Sam"]), lt("DES-1", "DES", ["Kim"]), lt("DES-3", "DES", ["Sam"])];
    // The tracker's own "assigned to me": DES-3 belongs to another Sam.
    answers["tracker_tasks linear:acme"] = () => [lt("MOON-2", "MOON", ["Sam"]), lt("MOON-9", "MOON", ["Sam"])];
    useTasks.setState({ config: migrateSources({ ...DEFAULT_CONFIG, connections: [linear] }), filters: { mine: true, hideEmptyDone: false } });
    await refreshTasks("local", "personal", 1_000);
    expect(shown()).toEqual({ "MOON-2": true, "MOON-9": true });
    useTasks.setState({ filters: { mine: false, hideEmptyDone: false } });
    await refreshTasks("local", "personal", 2_000);
    // Everyone's, marking the account's own; an own issue everyone's left out (it stops at 500) still shows.
    expect(shown()).toEqual({ "MOON-1": false, "MOON-2": true, "DES-1": false, "DES-3": false, "MOON-9": true });
    useTasks.setState({ config: null });
  });

  it("takes a repository's open issues from GitHub too once the filter is off", async () => {
    const theirs: GhTask = { ...issue, number: 13, title: "Tidy the footer", url: "https://github.com/acme/web/issues/13", assignees: ["kim"] };
    answers["git.origin_url"] = ({ path }) => (path === "/r/web" ? "https://github.com/acme/web.git" : null);
    answers["project.worktrees"] = () => [];
    answers["gh.tasks"] = (p) => ((p as { mine?: boolean }).mine ? [issue] : [issue, theirs]);
    useTasks.setState({ filters: { mine: true, hideEmptyDone: false } });
    await refreshTasks("local", "personal", 1_000);
    expect(shown()).toEqual({ "acme/web#12": true });
    useTasks.setState({ filters: { mine: false, hideEmptyDone: false } });
    await refreshTasks("local", "personal", 2_000);
    expect(shown()).toEqual({ "acme/web#12": true, "acme/web#13": false });
  });

  it("takes only the open ones of other people's GitHub issues", async () => {
    const theirsDone: GhTask = { ...issue, number: 14, title: "Old banner", url: "https://github.com/acme/web/issues/14", assignees: ["kim"], closed: true, state_reason: "completed" };
    const theirsOpen: GhTask = { ...issue, number: 13, title: "Tidy the footer", url: "https://github.com/acme/web/issues/13", assignees: ["kim"] };
    answers["git.origin_url"] = ({ path }) => (path === "/r/web" ? "https://github.com/acme/web.git" : null);
    answers["project.worktrees"] = () => [];
    answers["gh.tasks"] = (p) => ((p as { mine?: boolean }).mine ? [issue] : [issue, theirsOpen, theirsDone]);
    useTasks.setState({ filters: { mine: false, hideEmptyDone: false } });
    await refreshTasks("local", "personal", 1_000);
    expect(shown()).toEqual({ "acme/web#12": true, "acme/web#13": false });
  });

  it("fetches everyone's issues as soon as the filter is turned off", async () => {
    const theirs: GhTask = { ...issue, number: 13, title: "Tidy the footer", url: "https://github.com/acme/web/issues/13", assignees: ["kim"] };
    answers["git.origin_url"] = ({ path }) => (path === "/r/web" ? "https://github.com/acme/web.git" : null);
    answers["project.worktrees"] = () => [];
    answers["gh.tasks"] = (p) => ((p as { mine?: boolean }).mine ? [issue] : [issue, theirs]);
    useTasks.setState({ filters: { mine: true, hideEmptyDone: false } });
    await refreshTasks("local", "personal", 1_000);
    setFilters({ mine: false, hideEmptyDone: false });
    await vi.waitFor(() => expect(shown()).toEqual({ "acme/web#12": true, "acme/web#13": false }));
  });

  it("starts on for a new install", async () => {
    localStorage.clear();
    vi.resetModules();
    const fresh = await import("./tasksStore");
    expect(fresh.useTasks.getState().filters).toEqual({ mine: true, hideEmptyDone: false });
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
    await startedFromTask("local", "personal", { ref: { connection: "github:github.com", key: "else/where#3", url: "" }, kind: "github", key: "else/where#3", title: "x", firstMessage: "", projects: [], github: { repo: "else/where", number: 3 } }, { session: "x", assign: true });
    expect(useStore.getState().toasts.map((x) => x.text)).toEqual(["else/where#3: No project in this workspace has else/where as its origin"]);
  });
});

describe("open spec lines: Activity, comments, drafts and toasts (X45, X46)", () => {
  const lt = (key: string, column: "todo" | "in_progress" | "in_review") => ({ connection: "linear:acme", key, title: key, url: "", column, priority: 0, assignees: [], labels: [], description: "", updatedMs: 0, tracker: { id: `i-${key}`, state: "x", source: "MOON" } });
  const pr = (o: object = {}) => ({ number: 131, url: "https://github.com/acme/app/pull/131", state: "open", title: "Hosts", checks: [], review_decision: null, ...o });
  const rowWith = (id: string, p: object) => ({ session: { id, name: id, branch: id, path: `/w/${id}`, archived: false, task: null, task_unlinked: false, state: "idle" as const, pr: pr(p), additions: 0, subagents: 0, originRepo: null }, meta: { text: "#131", tone: "open" as const } });
  const boardOf = (t: ReturnType<typeof lt>, rows: ReturnType<typeof rowWith>[]) => ({ todo: [], in_progress: [], in_review: [{ task: t, column: "in_review" as const, rows, needsYou: false, orphans: [], empty: null, drift: null }], done: [] });
  const start = (key: string) => ({ ref: { connection: "linear:acme", key, url: "" }, kind: "linear" as const, key, title: key, firstMessage: "", projects: [], tracker: { id: `i-${key}`, source: "MOON" } });

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
    await startedFromTask("local", "personal", { ref: { connection: "github:github.com", key: "acme/web#12", url: "" }, kind: "github", key: "acme/web#12", title: "Fix", firstMessage: "", projects: [], github: { repo: "acme/web", number: 12 } }, { session: "Fix", assign: true }, 6_000);
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
    useStore.setState({ tasksMode: {} });
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
    setFilters({ mine: false, hideEmptyDone: true });
    vi.resetModules();
    const restarted = await import("./tasksStore");
    expect(restarted.useTasks.getState().filters).toEqual({ mine: false, hideEmptyDone: true });
    setFilters({ mine: false, hideEmptyDone: false });
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
