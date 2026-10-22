import { describe, expect, it } from "vitest";
import { arrange, compact, groupHeading, holdsProject, hostSections, projectRemoval, sessionBadge, sessionMenu, workspaceSections } from "./sidebar";
import type { Project, Section, Session, Workspace } from "./protocol";

const p = (id: string, name: string): Project => ({ id, name, path: `/${name}`, base_branch: "main" });
const s = (id: string, project: string, extra: Partial<Session> = {}): Session => ({
  id,
  project_id: project,
  name: id,
  branch: `moonlet/${id}`,
  base: "main",
  path: `/w/${id}`,
  agent: "claude",
  archived: false,
  created_at: Number(id.replace(/\D/g, "")) || 0,
  workspace_id: "personal",
  terminals: [],
  layout: null,
  ...extra,
});
const sec = (view: Partial<Section["view"]> = {}, extra: Partial<Section> = {}): Section => ({
  id: "w",
  name: "Work",
  project_ids: ["a", "b"],
  view: { group_by: "project", sort_by: "created", filter: [], ...view },
  created_at: 0,
  ...extra,
});

const projects = [p("a", "api"), p("b", "web"), p("c", "other")];
const sessions = [s("s1", "a"), s("s2", "a"), s("s3", "b", { archived: true }), s("s4", "c"), s("s5", "b")];

describe("sidebar arrange", () => {
  it("groups by task, one group per task in order of the newest session, then sessions with no task (X46)", () => {
    const task = (x: Session) => (x.id === "s1" || x.id === "s5" ? { key: "MOON-142", title: "Remote hosts" } : x.id === "s2" ? { key: "MOON-144", title: "File tabs" } : null);
    const g = arrange("personal", sec({ group_by: "task" }), projects, [...sessions, s("s6", "a")], () => null, () => 0, () => false, task);
    expect(g.map((x) => [x.kind, x.label, x.sessions.map((y) => y.id)])).toEqual([
      ["task", "MOON-142 Remote hosts", ["s5", "s1"]],
      ["task", "MOON-144 File tabs", ["s2"]],
      ["task", "No task", ["s6"]],
    ]);
  });

  it("groups by project in section order, newest first, without archived or foreign projects", () => {
    const g = arrange("personal", sec(), projects, sessions, () => null, () => 0);
    expect(g.map((x) => x.label)).toEqual(["api", "web"]);
    expect(g[0].sessions.map((x) => x.id)).toEqual(["s2", "s1"]);
    expect(g[1].sessions.map((x) => x.id)).toEqual(["s5"]);
  });

  it("keeps an archived session in its group while its row still plays the archive loader", () => {
    const g = arrange("personal", sec(), projects, sessions, () => null, () => 0, (x) => x.id === "s3");
    expect(g[1].sessions.map((x) => x.id)).toEqual(["s5", "s3"]);
  });

  it("filters, sorts by name and groups by status", () => {
    const g = arrange("personal", sec({ filter: ["a"], sort_by: "name", group_by: "status" }), projects, sessions, (x) => (x.id === "s1" ? "blocked" : "working"), () => 0);
    expect(g.map((x) => x.label)).toEqual(["Needs input", "Working"]);
    expect(g[1].sessions.map((x) => x.id)).toEqual(["s2"]);
  });

  it("shows only the sessions of its own workspace, for a project two workspaces share (X32)", () => {
    const mine = s("s1", "a");
    const theirs = s("s2", "a", { workspace_id: "acme" });
    expect(arrange("personal", sec(), projects, [mine, theirs], () => null, () => 0)[0].sessions.map((x) => x.id)).toEqual(["s1"]);
    expect(arrange("acme", sec(), projects, [mine, theirs], () => null, () => 0)[0].sessions.map((x) => x.id)).toEqual(["s2"]);
  });

  it("sorts by recent activity", () => {
    const g = arrange("personal", sec({ sort_by: "recent", group_by: "none" }), projects, sessions, () => null, (x) => (x.id === "s1" ? 99 : 1));
    expect(g[0].sessions[0].id).toBe("s1");
  });

  it("formats compact counts", () => {
    expect(compact(41)).toBe("41");
    expect(compact(5512)).toBe("5.5k");
    expect(compact(12400)).toBe("12k");
  });
});

describe("projectRemoval", () => {
  const home = sec({}, { id: "w1", name: "1devstudio", project_ids: ["a", "b"] });
  const other = sec({}, { id: "w2", name: "Acme", project_ids: ["b"] });

  it("only detaches a project another section still holds", () => {
    expect(projectRemoval([home, other], "w1", p("b", "acme-api"))).toEqual({ label: "Remove from 1devstudio", confirm: null });
  });

  it("asks before dropping a project no other section holds", () => {
    expect(projectRemoval([home, other], "w1", p("a", "moonlet"))).toEqual({
      label: "Remove from 1devstudio",
      confirm: "moonlet is in no other section, so it will be removed from moonlet. The folder on disk is not touched.",
    });
  });
});

describe("workspaceSections", () => {
  const w = (id: string, section_ids: string[]): Workspace => ({ id, name: id, color: "clay", section_ids, created_at: 0 });

  it("lists a workspace's sections in its order, skipping unknown ids", () => {
    const all = [sec({}, { id: "b", name: "Side projects" }), sec({}, { id: "a", name: "1devstudio" })];
    expect(workspaceSections(w("personal", ["a", "gone", "b"]), all).map((x) => x.name)).toEqual(["1devstudio", "Side projects"]);
  });

  it("tells whether a workspace holds a project in any of its sections", () => {
    const all = [sec({}, { id: "a", project_ids: ["p1"] }), sec({}, { id: "b", project_ids: ["p2"] })];
    expect(holdsProject(w("personal", ["a", "b"]), all, "p2")).toBe(true);
    expect(holdsProject(w("acme", ["a"]), all, "p2")).toBe(false);
  });
});

describe("hostSections", () => {
  const w = (id: string, name: string, section_ids: string[]): Workspace => ({ id, name, color: "clay", section_ids, created_at: 0 });
  const all = [sec({}, { id: "a", name: "1devstudio" }), sec({}, { id: "b", name: "Side projects" }), sec({}, { id: "c", name: "AI Operations" })];

  it("lists every section of a host in workspace order, labelled by section alone with one workspace", () => {
    expect(hostSections([w("p", "Personal", ["b", "a"])], all).map((x) => [x.ws.id, x.sec.id, x.label])).toEqual([
      ["p", "b", "Side projects"],
      ["p", "a", "1devstudio"],
    ]);
  });

  it("names the workspace too when there are several", () => {
    expect(hostSections([w("p", "Personal", ["a"]), w("c", "Acme", ["c"])], all).map((x) => x.label)).toEqual(["Personal › 1devstudio", "Acme › AI Operations"]);
  });
});

describe("sessionBadge", () => {
  const git = { additions: 212, deletions: 30 };
  const base = { creating: false, state: "working" as const, merged: false, git, agents: 0 };

  it("shows the diff of a session at rest", () => {
    expect(sessionBadge(base)).toEqual({ text: "+212 -30", tone: "diff" });
  });

  it("shows running subagents (X42) over the diff and a merged PR", () => {
    expect(sessionBadge({ ...base, agents: 5, merged: true })).toEqual({ text: "5 agents", tone: "agents" });
    expect(sessionBadge({ ...base, agents: 1 })).toEqual({ text: "1 agent", tone: "agents" });
  });

  it("lets needs input and creating win over agents", () => {
    expect(sessionBadge({ ...base, agents: 5, state: "blocked" })).toEqual({ text: "needs input", tone: "blocked" });
    expect(sessionBadge({ ...base, agents: 5, creating: true })).toEqual({ text: "creating", tone: "muted" });
  });

  it("shows merged, and nothing without changes", () => {
    expect(sessionBadge({ ...base, merged: true })).toEqual({ text: "merged", tone: "merged" });
    expect(sessionBadge({ ...base, git: { additions: 0, deletions: 0 } })).toBeNull();
  });
});

describe("groupHeading", () => {
  it("gives project, status and task groups a heading, and the ungrouped list none", () => {
    const g = (kind: "project" | "status" | "task" | "all") => ({ key: kind, kind, label: "MOON-142 Remote hosts", sessions: [] });
    expect(["project", "status", "task", "all"].map((k) => groupHeading(g(k as "project")))).toEqual(["project", "label", "label", null]);
  });
});

describe("sessionMenu (X46 linking from the right-click menu)", () => {
  it("offers Link to task… only for a session without a task, in a workspace with a task source", () => {
    expect(sessionMenu({ linked: false, sources: true })).toEqual(["open", "link-task", "archive"]);
    expect(sessionMenu({ linked: true, sources: true })).toEqual(["open", "archive"]);
    expect(sessionMenu({ linked: false, sources: false })).toEqual(["open", "archive"]);
  });

  it("offers Keep in sync with this Mac where the session can be kept in sync (X60)", () => {
    expect(sessionMenu({ linked: false, sources: true, sync: true })).toEqual(["open", "link-task", "keep-sync", "archive"]);
    expect(sessionMenu({ linked: true, sources: false, sync: true })).toEqual(["open", "keep-sync", "archive"]);
    expect(sessionMenu({ linked: true, sources: false, sync: false })).toEqual(["open", "archive"]);
  });
});
