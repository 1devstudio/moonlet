import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "./protocol";
import { useStore } from "./store";
import { DEFAULT_CONFIG, type TasksData } from "./tasksStore";
import type { Task } from "./tasks";
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
