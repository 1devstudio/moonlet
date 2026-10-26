import { describe, expect, it } from "vitest";
import { arrange, arrangeShared, compact, missingProjectNote, sectionParts, sharedSessionOrder, shownSections, groupHeading, holdsProject, hostSections, projectRemoval, sessionBadge, sessionMenu, workspaceSections } from "./sidebar";
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

describe("arrangeShared (a section on every member of an account, X68)", () => {
  const id = (name: string) => ({ origin: `github.com/acme/${name}`, root: `${name}-root` });
  const shop = (pid: string): Project => ({ ...p(pid, "shop"), identity: id("shop") });
  // This Mac has shop; studio-mini has shop under another id, and blog.
  const here = { host: "local", sec: sec({}, { project_ids: ["a"], missing: [id("blog"), id("docs")] }), projects: [shop("a")], sessions: [s("s1", "a"), s("s4", "a")] };
  const mini = {
    host: "studio-mini",
    sec: sec({}, { project_ids: ["x", "y"], missing: [id("docs")] }),
    projects: [shop("x"), { ...p("y", "blog"), identity: id("blog") }],
    sessions: [s("s3", "x"), s("s2", "y")],
  };
  const none = { stateOf: () => null, activeAt: () => 0, archiving: () => false, taskOf: () => null };

  it("shows each project once with every member's sessions, newest first, and says where the rest are", () => {
    const g = arrangeShared("personal", [here, mini], none);
    expect(g.map((x) => [x.label, x.host, x.projectId ?? null, x.on, x.sessions.map((e) => `${e.host}:${e.session.id}`)])).toEqual([
      ["shop", "local", "a", null, ["local:s4", "studio-mini:s3", "local:s1"]],
      // Only on studio-mini: its sessions, and its project row, are there.
      ["blog", "studio-mini", "y", { host: "studio-mini" }, ["studio-mini:s2"]],
      // On no connected member: named from its origin.
      ["docs", "local", null, { missing: true }, []],
    ]);
  });

  it("merges status groups across members in their usual order", () => {
    const state = (host: string, x: Session) => (host === "studio-mini" && x.id === "s3" ? "blocked" : "idle");
    const g = arrangeShared("personal", [{ ...here, sec: { ...here.sec, view: { ...here.sec.view, group_by: "status" } } }, mini], { ...none, stateOf: state });
    expect(g.map((x) => [x.label, x.sessions.map((e) => e.session.id)])).toEqual([
      ["Needs input", ["s3"]],
      ["Idle", ["s4", "s2", "s1"]],
    ]);
  });

  it("filters every member by the projects picked on the shown one", () => {
    // Shown with only shop picked: studio-mini's blog sessions stay out.
    const filtered = { ...here, sec: { ...here.sec, view: { ...here.sec.view, filter: ["a"] } } };
    const g = arrangeShared("personal", [filtered, mini], none);
    // Nor does a project no member has, which was not picked either.
    expect(g.map((x) => [x.label, x.sessions.map((e) => e.session.id)])).toEqual([["shop", ["s4", "s3", "s1"]]]);
  });
});

describe("missingProjectNote (X68)", () => {
  it("says how to work on a project this Mac does not have", () => {
    expect(missingProjectNote("blog", "This Mac")).toBe(
      "blog is not on This Mac. Add a clone of it to this section to work on it here; moonlet will clone it for you in a later version.",
    );
  });
});

describe("shownSections (X68)", () => {
  const ws = (section_ids: string[]): Workspace => ({ id: "W", name: "Personal", color: "clay", section_ids, claude_profile: null, created_at: 0 });
  const named = (id: string, name: string) => sec({}, { id, name });
  const hosts = [
    { host: "local", account: "acct", workspaces: [ws(["a", "c"])], sections: [named("a", "1devstudio"), named("c", "Clients")] },
    // studio-mini has not heard of "Clients" yet.
    { host: "studio-mini", account: "acct", workspaces: [ws(["a"])], sections: [named("a", "1devstudio")] },
    // A host outside the account, whose workspace has the same id.
    { host: "devbox", account: "devbox", workspaces: [ws(["z"])], sections: [named("z", "Lab")] },
  ];

  it("lists the shown workspace's sections once, from the shown member first, with every member of its account holding each", () => {
    expect(shownSections({ host: "local", id: "W", account: "acct" }, hosts).map((x) => [x.ws.id, x.sec.name, x.hosts])).toEqual([
      ["W", "1devstudio", ["local", "studio-mini"]],
      ["W", "Clients", ["local"]],
    ]);
    // Shown from studio-mini, its sections lead.
    expect(shownSections({ host: "studio-mini", id: "W", account: "acct" }, hosts).map((x) => [x.sec.name, x.hosts])).toEqual([
      ["1devstudio", ["studio-mini", "local"]],
      ["Clients", ["local"]],
    ]);
    expect(shownSections({ host: "devbox", id: "W", account: "devbox" }, hosts).map((x) => [x.sec.name, x.hosts])).toEqual([["Lab", ["devbox"]]]);
  });

  it("builds each member's side of a section from what that member lists", () => {
    const parts = sectionParts(["local", "studio-mini"], named("a", "1devstudio"), {
      sections: { local: [named("a", "1devstudio")], "studio-mini": [{ ...named("a", "1devstudio"), project_ids: ["x"] }] },
      projects: { local: [], "studio-mini": [p("x", "shop")] },
      sessions: { local: [], "studio-mini": [s("s9", "x")] },
    });
    expect(parts.map((x) => [x.host, x.sec.project_ids, x.projects.map((q) => q.id), x.sessions.map((q) => q.id)])).toEqual([
      ["local", ["a", "b"], [], []],
      ["studio-mini", ["x"], ["x"], ["s9"]],
    ]);
  });

  it("orders sessions for ⌘1–9 as the sidebar shows them, skipping collapsed sections and groups", () => {
    const shopA = { ...p("a", "shop"), identity: { origin: "github.com/acme/shop", root: "r" } };
    const shopX = { ...p("x", "shop"), identity: { origin: "github.com/acme/shop", root: "r" } };
    const base = {
      shown: { host: "local", id: "W", account: "acct" },
      hosts: [
        { host: "local", account: "acct", workspaces: [ws(["a"])], sections: [{ ...named("a", "1devstudio"), project_ids: ["a"] }] },
        { host: "studio-mini", account: "acct", workspaces: [ws(["a"])], sections: [{ ...named("a", "1devstudio"), project_ids: ["x"] }] },
      ],
      projects: { local: [shopA], "studio-mini": [shopX] },
      sessions: { local: [s("s1", "a", { workspace_id: "W" })], "studio-mini": [s("s2", "x", { workspace_id: "W" })] },
      activeAt: () => 0,
      collapsed: {} as Record<string, boolean>,
    };
    expect(sharedSessionOrder(base)).toEqual([
      { host: "studio-mini", id: "s2" },
      { host: "local", id: "s1" },
    ]);
    expect(sharedSessionOrder({ ...base, collapsed: { "ws:local/a": true } })).toEqual([]);
    expect(sharedSessionOrder({ ...base, collapsed: { "local/a/proj:a": true } })).toEqual([]);
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
