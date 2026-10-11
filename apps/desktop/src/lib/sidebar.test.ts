import { describe, expect, it } from "vitest";
import { arrange, compact, holdsProject, hostSections, projectRemoval, workspaceSections } from "./sidebar";
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
    const theirs = s("s2", "a", { workspace_id: "cipher" });
    expect(arrange("personal", sec(), projects, [mine, theirs], () => null, () => 0)[0].sessions.map((x) => x.id)).toEqual(["s1"]);
    expect(arrange("cipher", sec(), projects, [mine, theirs], () => null, () => 0)[0].sessions.map((x) => x.id)).toEqual(["s2"]);
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
  const other = sec({}, { id: "w2", name: "CipherHealth", project_ids: ["b"] });

  it("only detaches a project another section still holds", () => {
    expect(projectRemoval([home, other], "w1", p("b", "cipher-paas"))).toEqual({ label: "Remove from 1devstudio", confirm: null });
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
    expect(holdsProject(w("cipher", ["a"]), all, "p2")).toBe(false);
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
    expect(hostSections([w("p", "Personal", ["a"]), w("c", "CipherHealth", ["c"])], all).map((x) => x.label)).toEqual(["Personal › 1devstudio", "CipherHealth › AI Operations"]);
  });
});
