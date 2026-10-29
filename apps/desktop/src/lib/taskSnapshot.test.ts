import { describe, expect, it } from "vitest";
import type { BoardColumn, BoardConfig } from "./boards";
import { DEFAULT_RULES } from "./keepInStep";
import type { Task } from "./tasks";
import type { TrackersConfig } from "./tasksStore";
import { taskSnapshot, snapshotsToShare } from "./taskSnapshot";

const JIRA = "jira:acme.atlassian.net";
const OPS: BoardColumn[] = [
  { name: "To Do", statuses: ["10001"], category: "todo" },
  { name: "In Progress", statuses: ["3"], category: "in_progress" },
  { name: "Done", statuses: ["10002"], category: "done", show: "fold" },
];
const board = (id: string, workspace: string, o: Partial<BoardConfig> = {}): BoardConfig => ({ id, name: id, connection: JIRA, workspace, origin: { kind: "jira_board", board: 1 }, columns: OPS, ...o });
const task = (key: string, statusId: string, state: string): Task => ({
  connection: JIRA,
  key,
  title: `${key} title`,
  url: `https://acme.atlassian.net/browse/${key}`,
  column: "todo",
  priority: 2,
  assignees: ["Sam Rivera"],
  labels: [],
  description: "",
  updatedMs: 0,
  tracker: { id: `id-${key}`, state, source: "OPS", statusId },
});

const config: TrackersConfig = {
  sync: { interval: 60, notify: true },
  github: { branch_template: "{number}-{title}", max_length: 48, rules: DEFAULT_RULES },
  jira: { branch_template: "{key}-{title}", max_length: 40, rules: { ...DEFAULT_RULES, session_starts: "off" } },
  connections: [{ id: JIRA, kind: "jira", site: "acme.atlassian.net", account: "sam@acme.example", email: "sam@acme.example", auth: "token", sources: [] }],
  boards: [board("ops", "local/w", { name: "OPS · Sprint 42" }), board("plat", "local/w", { pinned: false }), board("x", "local/other")],
};

const data = {
  tasks: [task("OPS-1", "10001", "To Do"), task("OPS-2", "3", "In Progress"), task("PLAT-7", "3", "In Progress"), task("OPS-99", "3", "In Progress")],
  worktrees: [{ path: "/wt/ops-9", branch: "ops-9-fix", originRepo: null }],
  sources: [],
  repos: { storefront: "acme/storefront" },
  sourceProjects: { [`${JIRA} OPS`]: ["storefront"] },
  syncedAt: 1_791_970_430_000,
  error: null,
  // PLAT-7 is on the unpinned board, OPS-99 on none: neither is shared.
  boards: { ops: { keys: [`${JIRA} OPS-1`, `${JIRA} OPS-2`], sprint: { id: 42, name: "Sprint 42", startMs: 1, endMs: 2 } }, plat: { keys: [`${JIRA} PLAT-7`] } },
};

describe("taskSnapshot (X76)", () => {
  const snap = () =>
    taskSnapshot({
      wsKey: "local/w",
      config,
      data,
      moving: { [`${JIRA} OPS-1`]: { status: "3", name: "In Progress", done: false } },
      activity: { [`${JIRA} OPS-1`]: [{ at: 5, text: "moonlet moved it to In Progress" }], [`${JIRA} OTHER-1`]: [{ at: 6, text: "elsewhere" }] },
      attention: { [JIRA]: "Reconnect Jira: the token was rejected.", "linear:other": "Reconnect Linear." },
      shownBoard: "ops",
      from: "studio",
    });

  it("shares the workspace's shown boards with their tasks where the board puts them, moves under way included", () => {
    const s = snap();
    expect(s.version).toBe(1);
    expect(s.from).toBe("studio");
    expect(s.syncedAt).toBe(1_791_970_430_000);
    expect(s.boards.map((b) => b.id)).toEqual(["ops"]);
    expect(s.shownBoard).toBe("ops");
    expect(s.tasks.map((t) => [t.key, t.column, t.tracker?.statusId])).toEqual([
      ["OPS-1", "in_progress", "3"],
      ["OPS-2", "in_progress", "3"],
    ]);
    expect(s.boardData.ops.sprint?.name).toBe("Sprint 42");
    expect(s.worktrees).toEqual([{ path: "/wt/ops-9", branch: "ops-9-fix", originRepo: null }]);
    expect(s.sourceProjects).toEqual({ [`${JIRA} OPS`]: ["storefront"] });
  });

  it("carries the activity and attention of its own tasks and connections, the branch templates, and no account", () => {
    const s = snap();
    expect(s.activity).toEqual({ [`${JIRA} OPS-1`]: [{ at: 5, text: "moonlet moved it to In Progress" }] });
    expect(s.attention).toEqual({ [JIRA]: "Reconnect Jira: the token was rejected." });
    expect(s.trackers.jira?.branch_template).toBe("{key}-{title}");
    expect(s.trackers.github.branch_template).toBe("{number}-{title}");
    expect(JSON.stringify(s)).not.toContain("sam@acme.example");
  });

  it("is empty for a workspace without boards", () => {
    const s = taskSnapshot({ wsKey: "local/none", config, data: undefined, moving: {}, activity: {}, attention: {}, shownBoard: null, from: "studio" });
    expect(s.boards).toEqual([]);
    expect(s.tasks).toEqual([]);
    expect(s.syncedAt).toBeNull();
  });
});

describe("snapshotsToShare (X76)", () => {
  const base = { config, data: { "local/w": data }, moving: {}, activity: {}, attention: {}, shownBoard: { "local/w": "ops" }, from: "studio" };

  it("shares each workspace with boards, by host and workspace id, once until it changes", () => {
    const loaded = { ...base, data: { ...base.data, "local/other": data } };
    const first = snapshotsToShare(loaded, {});
    expect(first.map((s) => [s.host, s.workspace, s.snapshot.boards.length])).toEqual([
      ["local", "w", 1],
      ["local", "other", 1],
    ]);
    const shared = Object.fromEntries(first.map((s) => [`${s.host}/${s.workspace}`, s.json]));
    expect(snapshotsToShare(loaded, shared)).toEqual([]);
    const changed = snapshotsToShare({ ...loaded, activity: { [`${JIRA} OPS-2`]: [{ at: 9, text: "PR #12 opened" }] } }, shared);
    expect(changed.map((s) => s.workspace)).toEqual(["w"]);
  });

  it("empties a workspace it shared before once its boards are gone", () => {
    const loaded = { ...base, data: { ...base.data, "local/other": data } };
    const shared = Object.fromEntries(snapshotsToShare(loaded, {}).map((s) => [`${s.host}/${s.workspace}`, s.json]));
    const gone = snapshotsToShare({ ...loaded, config: { ...config, boards: [config.boards![0]] } }, shared);
    expect(gone.map((s) => [s.workspace, s.snapshot.boards])).toEqual([["other", []]]);
  });

  it("shares no workspace whose tasks have not loaded yet: the phone keeps the last boards meanwhile", () => {
    expect(snapshotsToShare(base, {}).map((s) => s.workspace)).toEqual(["w"]);
  });

  it("empties a workspace the daemon still has boards for, after a restart or a reconnect", () => {
    const gone = snapshotsToShare({ ...base, config: { ...config, boards: [config.boards![0]] } }, {}, ["local/old"]);
    expect(gone.map((s) => [s.workspace, s.snapshot.boards])).toEqual([["w", gone[0].snapshot.boards], ["old", []]]);
  });
});
