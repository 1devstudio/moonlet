import { beforeEach, describe, expect, it, vi } from "vitest";
import { focusTerminal, selectSession, sessionNeedsYou, shownWorkspace, useStore } from "./store";
import { visibleSessionOrder } from "./actions";
import type { Section, Session, TerminalInfo, Workspace } from "./protocol";

vi.mock("./daemon", () => ({ rpc: vi.fn(() => Promise.resolve()), sendInput: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: () => Promise.resolve() }) }));

const host = { id: "local", label: "This Mac", remote: false, status: "connected" as const, message: null, daemon_version: null, hostname: null, home: null };
const ws = (id: string, name: string, section_ids: string[]): Workspace => ({ id, name, color: "clay", section_ids, created_at: 0 });
const sec = (id: string, project_ids: string[]): Section => ({ id, name: id, project_ids, view: { group_by: "project", sort_by: "created", filter: [] }, created_at: 0 });
const session = (id: string, workspace_id: string, created_at: number): Session => ({ id, project_id: "p", name: id, branch: "b", base: "main", path: `/w/${id}`, agent: null, archived: false, created_at, workspace_id, terminals: [], layout: null });
const term = (id: number, session_id: string, extra: Partial<TerminalInfo> = {}): TerminalInfo =>
  ({ id, kind: "agent", title: "claude", cwd: "/w", command: [], session_id, agent: "claude", agent_state: "idle", cols: 80, rows: 24, pid: 1, last_output_at: 0, ...extra }) as TerminalInfo;

beforeEach(() =>
  useStore.setState({
    hosts: { local: host },
    projects: { local: [{ id: "p", name: "jaunt", path: "/r", base_branch: "main" }] },
    workspaces: { local: [ws("personal", "Personal", ["a"]), ws("acme", "Acme", ["c"])] },
    sections: { local: [sec("a", ["p"]), sec("c", ["p"])] },
    sessions: { local: [session("s1", "personal", 1), session("s2", "acme", 2), session("s3", "acme", 3)] },
    terminals: { local: { 7: term(7, "s2"), 8: term(8, "s1", { agent_state: "blocked" }), 9: term(9, "s3", { kind: "shell", agent: undefined }) } },
    workspace: { host: "local", id: "personal" },
    selected: { host: "local", session: "s1" },
    lastSession: {},
    unread: {},
    collapsed: {},
    showHistory: false,
  }),
);

describe("opening a session elsewhere (X32)", () => {
  it("a notification or the palette (focusTerminal) shows the terminal's workspace", () => {
    focusTerminal("local", 7);
    expect(useStore.getState().workspace).toEqual({ host: "local", id: "acme" });
    expect(useStore.getState().selected).toEqual({ host: "local", session: "s2" });
    expect(useStore.getState().lastSession).toEqual({ "local/acme": "s2" });
  });

  it("selecting a session shows its workspace too", () => {
    selectSession("local", "s3");
    expect(useStore.getState().workspace).toEqual({ host: "local", id: "acme" });
  });
});

describe("⌘1–9 order", () => {
  it("covers only the sessions of the shown workspace", () => {
    expect(visibleSessionOrder().map((x) => x.id)).toEqual(["s1"]);
    useStore.setState({ workspace: { host: "local", id: "acme" } });
    expect(visibleSessionOrder().map((x) => x.id)).toEqual(["s3", "s2"]);
  });
});

describe("sessionNeedsYou", () => {
  it("is true for a blocked agent or an unread terminal, and false otherwise", () => {
    const s = useStore.getState();
    expect(sessionNeedsYou(s, "local", "s1")).toBe(true);
    expect(sessionNeedsYou(s, "local", "s2")).toBe(false);
    useStore.setState({ unread: { "local:7": "done" } });
    expect(sessionNeedsYou(useStore.getState(), "local", "s2")).toBe(true);
  });
});

describe("shownWorkspace", () => {
  it("falls back to the first workspace as one stable object, safe as a zustand selector", () => {
    useStore.setState({ workspace: { host: "local", id: "deleted" } });
    const a = shownWorkspace(useStore.getState());
    expect(a).toEqual({ host: "local", id: "personal" });
    expect(shownWorkspace(useStore.getState())).toBe(a);
  });
});
