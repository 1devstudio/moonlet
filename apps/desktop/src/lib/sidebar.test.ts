import { describe, expect, it } from "vitest";
import { arrange, compact } from "./sidebar";
import type { Project, Session, Workspace } from "./protocol";

const p = (id: string, name: string): Project => ({ id, name, path: `/${name}`, base_branch: "main" });
const s = (id: string, project: string, extra: Partial<Session> = {}): Session => ({
  id,
  project_id: project,
  name: id,
  branch: `jaunt/${id}`,
  base: "main",
  path: `/w/${id}`,
  agent: "claude",
  archived: false,
  created_at: Number(id.replace(/\D/g, "")) || 0,
  terminals: [],
  layout: null,
  ...extra,
});
const ws = (view: Partial<Workspace["view"]> = {}, extra: Partial<Workspace> = {}): Workspace => ({
  id: "w",
  name: "Work",
  project_ids: ["a", "b"],
  sections: [],
  view: { group_by: "project", sort_by: "created", filter: [], ...view },
  created_at: 0,
  ...extra,
});

const projects = [p("a", "api"), p("b", "web"), p("c", "other")];
const sessions = [s("s1", "a"), s("s2", "a"), s("s3", "b", { archived: true }), s("s4", "c"), s("s5", "b")];

describe("sidebar arrange", () => {
  it("groups by project in workspace order, newest first, without archived or foreign projects", () => {
    const g = arrange(ws(), projects, sessions, () => null, () => 0);
    expect(g.map((x) => x.label)).toEqual(["api", "web"]);
    expect(g[0].sessions.map((x) => x.id)).toEqual(["s2", "s1"]);
    expect(g[1].sessions.map((x) => x.id)).toEqual(["s5"]);
  });

  it("filters, sorts by name and groups by status", () => {
    const g = arrange(ws({ filter: ["a"], sort_by: "name", group_by: "status" }), projects, sessions, (x) => (x.id === "s1" ? "blocked" : "working"), () => 0);
    expect(g.map((x) => x.label)).toEqual(["Needs input", "Working"]);
    expect(g[1].sessions.map((x) => x.id)).toEqual(["s2"]);
  });

  it("puts sectioned sessions under their section only", () => {
    const g = arrange(ws({}, { sections: [{ id: "w:x", name: "Today" }] }), projects, [s("s1", "a", { section: "w:x" }), s("s2", "a")], () => null, () => 0);
    expect(g[0]).toMatchObject({ kind: "section", label: "Today" });
    expect(g[0].sessions.map((x) => x.id)).toEqual(["s1"]);
    expect(g[1].sessions.map((x) => x.id)).toEqual(["s2"]);
  });

  it("sorts by recent activity", () => {
    const g = arrange(ws({ sort_by: "recent", group_by: "none" }), projects, sessions, () => null, (x) => (x.id === "s1" ? 99 : 1));
    expect(g[0].sessions[0].id).toBe("s1");
  });

  it("formats compact counts", () => {
    expect(compact(41)).toBe("41");
    expect(compact(5512)).toBe("5.5k");
    expect(compact(12400)).toBe("12k");
  });
});
