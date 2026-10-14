import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GhTask, Section, Workspace } from "./protocol";
import { DEFAULT_RULES } from "./keepInStep";
import { useStore } from "./store";
import { activityOf, autoFixed, boardInput, DEFAULT_CONFIG, ensureTasks, failureOf, fixDrift, isTasksMode, loadTrackersConfig, moveTask, reconnected, refreshTasks, retryTask, rulesFor, runAutoFixes, saveTrackersConfig, setKeepInStep, startedFromTask, syncTasks, toggleTasksMode, trackersConfig, useTasks } from "./tasksStore";

const answers: Record<string, (params: { path?: string; id?: string }) => unknown> = {};
vi.mock("./daemon", () => ({
  rpc: vi.fn((_host: string, method: string, params: { path?: string; id?: string }) => {
    const answer = answers[method];
    return answer ? Promise.resolve().then(() => answer(params)) : Promise.reject(new Error(`no ${method}`));
  }),
  sendInput: vi.fn(),
  hostsApi: {
    trackersConfig: () => (configFails.length ? Promise.reject(configFails.shift()) : Promise.resolve({ sync: { interval: 300, notify: true } })),
    trackersSave: (c: object) => new Promise<void>((r) => setTimeout(() => (saved.push(c), r()), 5)),
    trackerUpdate: (req: object) => (failNext.length ? Promise.reject(failNext.shift()) : (sent.push(req), Promise.resolve())),
    trackerTasks: (id: string, mine: boolean) => {
      const answer = answers[`tracker_tasks ${id}${mine ? "" : " all"}`] ?? answers[`tracker_tasks ${id}`];
      return answer ? Promise.resolve().then(() => answer({})) : Promise.reject(new Error(`no tracker_tasks ${id}`));
    },
  },
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: () => Promise.resolve() }) }));
const shown = vi.hoisted(() => [] as { title: string; body: string }[]);
const sent = vi.hoisted(() => [] as object[]);
const failNext = vi.hoisted(() => [] as object[]);
const configFails = vi.hoisted(() => [] as object[]);
const saved = vi.hoisted(() => [] as object[]);
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
  const config = (sources: { key: string; workspace: string; project: string }[]) => ({
    ...DEFAULT_CONFIG,
    connections: [{ id: "linear:acme", kind: "linear" as const, site: "acme", account: "Sam", auth: "api_key", sources: sources.map((x) => ({ ...x, name: x.key })) }],
  });

  it("adds the tasks of the workspace's sources, and where their sessions start", async () => {
    answers["git.origin_url"] = () => null;
    answers["project.worktrees"] = () => [];
    answers["tracker_tasks linear:acme"] = () => [linearTask("MOON-1", "MOON"), linearTask("DES-2", "DES")];
    useTasks.setState({ config: config([{ key: "MOON", workspace: "local/personal", project: "web" }, { key: "DES", workspace: "local/acme", project: "" }]) });
    await refreshTasks("local", "personal", 1_000);
    const d = useTasks.getState().data["local/personal"];
    expect(d.tasks.map((t) => t.key)).toEqual(["MOON-1"]);
    expect(d.sources).toEqual(["linear:acme"]);
    expect(d.sourceProjects).toEqual({ "linear:acme MOON": "web" });
    useTasks.setState({ config: null });
  });

  it("keeps the last tasks only of a source that failed, and takes the others fresh", async () => {
    answers["git.origin_url"] = ({ path }) => (path === "/r/web" ? "https://github.com/acme/web.git" : null);
    answers["project.worktrees"] = () => [];
    answers["gh.tasks"] = () => [];
    answers["tracker_tasks linear:acme"] = () => [linearTask("MOON-1", "MOON")];
    useTasks.setState({ config: config([{ key: "MOON", workspace: "local/personal", project: "" }]), attention: {} });
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
    useTasks.setState({ config: config([{ key: "MOON", workspace: "local/personal", project: "" }]), attention: {} });
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

  it("moves a tracker issue to In Progress and assigns it when a session starts from it", async () => {
    sent.length = 0;
    await startedFromTask("local", "personal", { ref: { connection: "linear:acme", key: "MOON-151", url: "" }, kind: "linear", key: "MOON-151", title: "Drag", firstMessage: "", project: null, tracker: { id: "issue-2", source: "MOON" } });
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

describe("Shows per source (X44)", () => {
  it("shows all open issues of a source set to all, and only the account's issues of the others", async () => {
    answers["git.origin_url"] = () => null;
    answers["project.worktrees"] = () => [];
    const lt = (key: string, source: string, who: string[]) => ({ connection: "linear:acme", key, title: key, url: "", column: "todo", priority: 0, assignees: who, labels: [], description: "", updatedMs: 0, tracker: { id: key, state: "Todo", source } });
    answers["tracker_tasks linear:acme all"] = () => [lt("MOON-1", "MOON", ["Kim"]), lt("MOON-2", "MOON", ["Sam"]), lt("DES-1", "DES", ["Kim"]), lt("DES-2", "DES", ["Sam"])];
    useTasks.setState({
      config: {
        ...DEFAULT_CONFIG,
        connections: [
          {
            id: "linear:acme",
            kind: "linear",
            site: "acme",
            account: "Sam",
            auth: "api_key",
            sources: [
              { key: "MOON", name: "Moonlet", project: "", workspace: "local/personal", all: true },
              { key: "DES", name: "Design", project: "", workspace: "local/personal" },
            ],
          },
        ],
      },
    });
    await refreshTasks("local", "personal", 1_000);
    expect(useTasks.getState().data["local/personal"].tasks.map((t) => t.key).sort()).toEqual(["DES-2", "MOON-1", "MOON-2"]);
    useTasks.setState({ config: null });
  });
});

describe("the state mapping (X44 Workflow states)", () => {
  it("places tasks by the mapping saved now, without waiting for a sync", () => {
    const qa = { connection: "linear:acme", key: "ENG-1", title: "x", url: "", column: "in_progress" as const, priority: 0, assignees: [], labels: [], description: "", updatedMs: 0, tracker: { id: "i1", state: "QA", source: "ENG" } };
    const data = { tasks: [qa], worktrees: [], sources: ["linear:acme"], repos: {}, sourceProjects: {}, syncedAt: 1, error: null };
    const config = { ...DEFAULT_CONFIG, connections: [{ id: "linear:acme", kind: "linear" as const, site: "acme", account: "Ada", auth: "api_key", sources: [], states: { QA: "in_review" as const } }] };
    expect(boardInput(useStore.getState(), "local", "personal", data, config).tasks.map((t) => t.column)).toEqual(["in_review"]);
    expect(boardInput(useStore.getState(), "local", "personal", data, DEFAULT_CONFIG).tasks.map((t) => t.column)).toEqual(["in_progress"]);
  });
});
