import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardConfig } from "./boards";
import type { Session } from "./protocol";
import { useStore } from "./store";
import { DEFAULT_CONFIG, type TasksData } from "./tasksStore";
import type { Task } from "./tasks";
import { cardOfSession } from "./tasksBoard";
import { type BoardKnobs, workspaceBoard } from "./workspaceBoard";

vi.mock("./daemon", () => ({ rpc: vi.fn(), sendInput: vi.fn() }));

const session = (id: string, name: string): Session => ({
  id,
  project_id: "p",
  name,
  branch: `moonlet/${id}`,
  base: "main",
  path: `/w/${id}`,
  agent: "claude",
  archived: false,
  created_at: 0,
  terminals: [],
  layout: null,
  workspace_id: "personal",
});

const task = (key: string, title: string): Task => ({
  connection: "linear:acme",
  key,
  title,
  url: "",
  column: "todo",
  priority: 0,
  assignees: [],
  labels: [],
  description: "",
  updatedMs: 0,
});

const data: TasksData = { tasks: [task("MOON-7", "Fix login")], worktrees: [], sources: [], repos: {}, syncedAt: 1, error: null };
const knobs: BoardKnobs = { notNow: {}, config: DEFAULT_CONFIG, paused: {}, moving: {}, shownId: null };
const ws = { host: "local", id: "personal" };
const unlinked = (b: ReturnType<typeof workspaceBoard>) => b.unlinked.map((u) => [u.session.name, u.hint]);

describe("a workspace's board (X78)", () => {
  // A new sessions list for each test, so a board built by the one before is never reused.
  beforeEach(() => {
    useStore.setState({ sessions: { local: [session("s1", "Fix login")] }, git: {} });
  });

  it("is built once however many components ask for it", () => {
    const first = workspaceBoard(useStore.getState(), ws, data, knobs);
    expect(unlinked(first)).toEqual([["Fix login", "Looks like MOON-7 Fix login"]]);
    // The sidebar, the mode switch and a session's task ask with a new ref each render.
    expect(workspaceBoard(useStore.getState(), { ...ws }, data, knobs)).toBe(first);
  });

  it("is a workspace's own, even for another account's workspace of the same id", () => {
    const first = workspaceBoard(useStore.getState(), ws, data, knobs);
    const theirs = workspaceBoard(useStore.getState(), { ...ws, account: "acme" }, data, knobs);
    expect(theirs).not.toBe(first);
    expect(theirs.ws?.account).toBe("acme");
  });

  it("is built again once a Tasks setting changes", () => {
    const first = workspaceBoard(useStore.getState(), ws, data, knobs);
    // Linking by title turned off: the unlinked session no longer gets a hint.
    const titlesOff = { ...knobs, config: { ...DEFAULT_CONFIG, link: { branch: true, pr: true, title: false } } };
    const next = workspaceBoard(useStore.getState(), ws, data, titlesOff);
    expect(next).not.toBe(first);
    expect(unlinked(next)).toEqual([["Fix login", ""]]);
  });

  it("is built again once the workspace's projects change", () => {
    const first = workspaceBoard(useStore.getState(), ws, data, knobs);
    useStore.setState({ projects: { local: [] } });
    expect(workspaceBoard(useStore.getState(), ws, data, knobs)).not.toBe(first);
  });

  it("is built again once the workspace's hosts change", () => {
    const first = workspaceBoard(useStore.getState(), ws, data, knobs);
    // A host joined, left or was renamed: the hosts list is a new one.
    useStore.setState({ hosts: { ...useStore.getState().hosts } });
    expect(workspaceBoard(useStore.getState(), ws, data, knobs)).not.toBe(first);
  });

  it("keeps the boards of the last 8 workspaces shown", () => {
    const shownFirst = workspaceBoard(useStore.getState(), { host: "local", id: "w1" }, data, knobs);
    for (let i = 2; i <= 9; i++) workspaceBoard(useStore.getState(), { host: "local", id: `w${i}` }, data, knobs);
    const shownLast = workspaceBoard(useStore.getState(), { host: "local", id: "w9" }, data, knobs);
    // w9 is among the last 8 and is not built again; w1 was let go of and is.
    expect(workspaceBoard(useStore.getState(), { host: "local", id: "w9" }, data, knobs)).toBe(shownLast);
    expect(workspaceBoard(useStore.getState(), { host: "local", id: "w1" }, data, knobs)).not.toBe(shownFirst);
  });

  it("is built again once a session it shows changes", () => {
    const first = workspaceBoard(useStore.getState(), ws, data, knobs);
    useStore.setState({ sessions: { local: [session("s1", "Fix login"), session("s2", "Add dark mode")] } });
    const next = workspaceBoard(useStore.getState(), ws, data, knobs);
    expect(next).not.toBe(first);
    expect(unlinked(next)).toEqual([
      ["Fix login", "Looks like MOON-7 Fix login"],
      ["Add dark mode", "No matching issue"],
    ]);
  });
});

describe("a session linked by hand to a task on no board (X46)", () => {
  const sprintBoard: BoardConfig = { id: "jira:acme/224@local/personal", name: "AIO Tasks", connection: "jira:acme", workspace: "local/personal", origin: { kind: "jira_board", board: 224 },
    columns: [
      { name: "To Do", statuses: ["10000"], category: "todo" },
      { name: "In Progress", statuses: ["3"], category: "in_progress" },
    ],
  };
  const onBoard: Task = { ...task("AIO-12", "Rotate keys"), connection: "jira:acme", tracker: { id: "12", state: "To Do", source: "AIO", statusId: "10000" } };
  // An Epic, which the board's sprint never reads, In Progress (a status the board has a column for).
  const epic: Task = { ...task("AIO-259", "Coding Agent"), connection: "jira:acme", column: "in_progress", issueType: "Epic", tracker: { id: "259", state: "In Progress", source: "AIO", statusId: "3" } };
  const synced: TasksData = { ...data, tasks: [onBoard], boards: { [sprintBoard.id]: { keys: ["jira:acme AIO-12"] } }, linked: [epic] };
  const withBoard: BoardKnobs = { ...knobs, config: { ...DEFAULT_CONFIG, boards: [sprintBoard] } };

  beforeEach(() => {
    useStore.setState({ sessions: { local: [{ ...session("s9", "Coding Agent"), task: { connection: "jira:acme", key: "AIO-259", url: "https://acme.atlassian.net/browse/AIO-259" } }] }, git: {} });
  });

  it("works on that task, in its tracker's column, though no board shows it", () => {
    const b = workspaceBoard(useStore.getState(), ws, synced, withBoard);
    const card = b.board && cardOfSession(b.board, "local", { host: "local", id: "s9" });
    expect(card && [card.task.key, card.task.title, card.column, card.rows.map((r) => r.session.name)]).toEqual(["AIO-259", "Coding Agent", "in_progress", ["Coding Agent"]]);
    // The board shows what its sprint reads, and nothing more.
    expect(b.shown?.views.flatMap((v) => v.cards.map((c) => c.task.key))).toEqual(["AIO-12"]);
  });

  it("works on a task the board reads into a hidden column, such as Backlog", () => {
    const backlog: BoardConfig = { ...sprintBoard, columns: [{ name: "Backlog", statuses: ["10001"], category: "todo", show: "hide" }, ...(sprintBoard.columns ?? [])] };
    const parked: Task = { ...task("AIO-259", "Coding Agent"), connection: "jira:acme", column: "hidden", tracker: { id: "259", state: "Backlog", source: "AIO", statusId: "10001" } };
    // The sync looked it up by key as well: its tracker puts it in To Do.
    const read: TasksData = { ...synced, tasks: [onBoard, parked], boards: { [sprintBoard.id]: { keys: ["jira:acme AIO-12", "jira:acme AIO-259"] } }, linked: [{ ...parked, column: "todo" }] };
    const b = workspaceBoard(useStore.getState(), ws, read, { ...knobs, config: { ...DEFAULT_CONFIG, boards: [backlog] } });
    const card = b.board && cardOfSession(b.board, "local", { host: "local", id: "s9" });
    expect(card && [card.task.key, card.column]).toEqual(["AIO-259", "todo"]);
    expect(b.shown?.views.flatMap((v) => v.cards.map((c) => c.task.key))).toEqual(["AIO-12"]);
  });
});
