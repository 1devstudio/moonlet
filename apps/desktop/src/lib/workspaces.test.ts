import { describe, expect, it } from "vitest";
import { composerProjects, createRequest, currentWorkspace, deleteBlocked, sessionToRestore, switcherRows, workspaceInitial, workspacesNeedingYou } from "./workspaces";
import type { Section, Session, Workspace } from "./protocol";

const w = (id: string, name: string, section_ids: string[], color: Workspace["color"] = "clay"): Workspace => ({ id, name, color, section_ids, created_at: 0 });
const sec = (id: string, project_ids: string[] = []): Section => ({ id, name: id, project_ids, view: { group_by: "project", sort_by: "recent", filter: [] }, created_at: 0 });
const s = (id: string, workspace_id: string, archived = false): Session => ({
  id,
  project_id: "p",
  name: id,
  branch: "b",
  base: "main",
  path: "/w",
  agent: null,
  archived,
  created_at: 0,
  workspace_id,
  terminals: [],
  layout: null,
});

describe("workspaceInitial", () => {
  it("is the name's first letter, upper case", () => {
    expect(workspaceInitial("acme")).toBe("C");
    expect(workspaceInitial("  personal")).toBe("P");
    expect(workspaceInitial("")).toBe("?");
  });
});

describe("switcherRows", () => {
  const personal = w("personal", "Personal", ["a", "b"]);
  const acmeco = w("acmeco", "Acme", ["c"], "blue");
  const sections = [sec("a"), sec("b"), sec("c")];
  const sessions = [s("1", "personal"), s("2", "personal"), s("3", "personal", true), s("4", "acmeco")];

  it("summarises each workspace and numbers the first nine for ⌃⌘1–9", () => {
    const rows = switcherRows([{ host: "local", label: "This Mac", workspaces: [personal, acmeco], sections, sessions }]);
    expect(rows.map((r) => [r.host, r.ws.name, r.initial, r.summary, r.kbd])).toEqual([
      ["local", "Personal", "P", "2 sections · 2 sessions", "⌃⌘1"],
      ["local", "Acme", "C", "1 section · 1 session", "⌃⌘2"],
    ]);
    expect(rows.every((r) => r.hostLabel === null)).toBe(true);
  });

  it("names the host of each group when there are several hosts, local first", () => {
    const remote = w("r", "Lab", []);
    const rows = switcherRows([
      { host: "local", label: "This Mac", workspaces: [personal], sections, sessions },
      { host: "devbox", label: "devbox", workspaces: [remote], sections: [], sessions: [] },
    ]);
    expect(rows.map((r) => [r.hostLabel, r.ws.name, r.kbd])).toEqual([
      ["This Mac", "Personal", "⌃⌘1"],
      ["devbox", "Lab", "⌃⌘2"],
    ]);
    expect(rows[1].summary).toBe("0 sections · 0 sessions");
  });
});

describe("currentWorkspace", () => {
  const hosts = [{ host: "local", label: "This Mac", workspaces: [w("personal", "Personal", []), w("acmeco", "Acme", [])], sections: [], sessions: [] }];

  it("keeps the remembered workspace while it exists, else falls back to the first", () => {
    expect(currentWorkspace({ host: "local", id: "acmeco" }, hosts)).toEqual({ host: "local", id: "acmeco" });
    expect(currentWorkspace({ host: "local", id: "deleted" }, hosts)).toEqual({ host: "local", id: "personal" });
    expect(currentWorkspace(null, hosts)).toEqual({ host: "local", id: "personal" });
    expect(currentWorkspace(null, [])).toBeNull();
  });
});

describe("workspacesNeedingYou", () => {
  it("marks workspaces with a live session that needs input or is unread", () => {
    const hosts = [{ host: "local", label: "This Mac", workspaces: [], sections: [], sessions: [s("1", "personal"), s("2", "acmeco"), s("3", "lab", true)] }];
    const needs = (_host: string, x: Session) => x.id !== "1";
    expect([...workspacesNeedingYou(hosts, needs)]).toEqual(["local/acmeco"]);
  });
});

describe("sessionToRestore", () => {
  const sessions = [s("1", "personal"), s("2", "acmeco"), s("3", "acmeco", true)];

  it("reopens the session last selected in that workspace while it is still there", () => {
    expect(sessionToRestore("2", sessions, "acmeco")).toBe("2");
    expect(sessionToRestore("3", sessions, "acmeco")).toBeNull();
    expect(sessionToRestore("1", sessions, "acmeco")).toBeNull();
    expect(sessionToRestore(undefined, sessions, "acmeco")).toBeNull();
  });
});

describe("New workspace dialog", () => {
  it("sends the trimmed name and colour, and the ticked sections only when moving", () => {
    expect(createRequest({ name: "  Acme ", color: "blue", start: "move", moving: ["c"] })).toEqual({ name: "Acme", color: "blue", move_sections: ["c"] });
    expect(createRequest({ name: "Lab", color: "grey", start: "empty", moving: ["c"] })).toEqual({ name: "Lab", color: "grey", move_sections: [] });
    expect(createRequest({ name: "   ", color: "grey", start: "empty", moving: [] })).toBeNull();
  });
});

describe("deleteBlocked", () => {
  it("explains why a workspace cannot be deleted, or allows it", () => {
    expect(deleteBlocked(w("p", "Personal", []), 1)).toBe("The last workspace cannot be deleted.");
    expect(deleteBlocked(w("c", "Acme", ["a", "b"]), 2)).toBe("Move or delete its 2 sections first.");
    expect(deleteBlocked(w("c", "Acme", ["a"]), 2)).toBe("Move or delete its section first.");
    expect(deleteBlocked(w("c", "Acme", []), 2)).toBeNull();
  });
});

describe("composerProjects", () => {
  const p = (id: string) => ({ id, name: id, path: `/${id}`, base_branch: "main" });
  const projects = [p("jaunt"), p("revd"), p("acmeco-paas")];
  const sections = [sec("a", ["jaunt"]), sec("b", ["revd", "jaunt"]), sec("c", ["acmeco-paas"])];

  it("offers the workspace's projects once each, in section order", () => {
    expect(composerProjects(w("personal", "Personal", ["a", "b"]), sections, projects).map((x) => x.id)).toEqual(["jaunt", "revd"]);
  });

  it("offers every project when the workspace has none yet", () => {
    expect(composerProjects(w("lab", "Lab", []), sections, projects).map((x) => x.id)).toEqual(["jaunt", "revd", "acmeco-paas"]);
  });
});
