import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GhTask, Section, Workspace } from "./protocol";
import { useStore } from "./store";
import { DEFAULT_CONFIG, ensureTasks, isTasksMode, refreshTasks, toggleTasksMode, useTasks } from "./tasksStore";

const answers: Record<string, (params: { path?: string; id?: string }) => unknown> = {};
vi.mock("./daemon", () => ({
  rpc: vi.fn((_host: string, method: string, params: { path?: string; id?: string }) => {
    const answer = answers[method];
    return answer ? Promise.resolve().then(() => answer(params)) : Promise.reject(new Error(`no ${method}`));
  }),
  sendInput: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: () => Promise.resolve() }) }));
const shown = vi.hoisted(() => [] as { title: string; body: string }[]);
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
});
