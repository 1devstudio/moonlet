import { describe, expect, it } from "vitest";
import { composerOptions, composerTarget, createRequest, newSectionWorkspace, currentWorkspace, deleteBlocked, sessionToRestore, switcherRows, workspaceDirty, workspaceInitial, sectionRows, syncWorkspaceForm, workspaceCanSave, workspacesNeedingYou, workspaceSummary } from "./workspaces";
import type { Section, Session, Workspace } from "./protocol";

const w = (id: string, name: string, section_ids: string[], color: Workspace["color"] = "clay", claude_profile: string | null = null): Workspace => ({ id, name, color, section_ids, claude_profile, created_at: 0 });
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
    expect(workspaceInitial("acme")).toBe("A");
    expect(workspaceInitial("  personal")).toBe("P");
    expect(workspaceInitial("")).toBe("?");
  });
});

describe("switcherRows", () => {
  const personal = w("personal", "Personal", ["a", "b"]);
  const acme = w("acme", "Acme", ["c"], "blue", "pw");
  const profiles = [{ id: "pw", name: "Work profile", path: "/Users/jane/.claude-work", created_at: 0, account: null, hooks_installed: true }];
  const sections = [sec("a"), sec("b"), sec("c")];
  const sessions = [s("1", "personal"), s("2", "personal"), s("3", "personal", true), s("4", "acme")];

  it("summarises each workspace and numbers the first nine for ⌃⌘1–9", () => {
    const rows = switcherRows([{ host: "local", label: "This Mac", workspaces: [personal, acme], sections, sessions, profiles }]);
    expect(rows.map((r) => [r.host, r.ws.name, r.initial, r.summary, r.kbd])).toEqual([
      ["local", "Personal", "P", "2 sections · 2 sessions · Default", "⌃⌘1"],
      ["local", "Acme", "A", "1 section · 1 session · Work profile", "⌃⌘2"],
    ]);
    expect(rows.every((r) => r.hostLabel === null)).toBe(true);
  });

  it("names the host of each group when there are several hosts, local first", () => {
    const remote = w("r", "Lab", []);
    const rows = switcherRows([
      { host: "local", label: "This Mac", workspaces: [personal], sections, sessions, profiles: [] },
      { host: "devbox", label: "devbox", workspaces: [remote], sections: [], sessions: [], profiles: [] },
    ]);
    expect(rows.map((r) => [r.hostLabel, r.ws.name, r.kbd])).toEqual([
      ["This Mac", "Personal", "⌃⌘1"],
      ["devbox", "Lab", "⌃⌘2"],
    ]);
    expect(rows[1].summary).toBe("0 sections · 0 sessions · Default");
  });
});

describe("currentWorkspace", () => {
  const hosts = [{ host: "local", label: "This Mac", workspaces: [w("personal", "Personal", []), w("acme", "Acme", [])], sections: [], sessions: [], profiles: [] }];

  it("keeps the remembered workspace while it exists, else falls back to the first", () => {
    expect(currentWorkspace({ host: "local", id: "acme" }, hosts)).toEqual({ host: "local", id: "acme" });
    expect(currentWorkspace({ host: "local", id: "deleted" }, hosts)).toEqual({ host: "local", id: "personal" });
    expect(currentWorkspace(null, hosts)).toEqual({ host: "local", id: "personal" });
    expect(currentWorkspace(null, [])).toBeNull();
  });
});

describe("workspacesNeedingYou", () => {
  it("marks workspaces with a live session that needs input or is unread", () => {
    const hosts = [{ host: "local", label: "This Mac", workspaces: [], sections: [], sessions: [s("1", "personal"), s("2", "acme"), s("3", "lab", true)], profiles: [] }];
    const needs = (_host: string, x: Session) => x.id !== "1";
    expect([...workspacesNeedingYou(hosts, needs)]).toEqual(["local/acme"]);
  });
});

describe("sessionToRestore", () => {
  const sessions = [s("1", "personal"), s("2", "acme"), s("3", "acme", true)];

  it("reopens the session last selected in that workspace while it is still there", () => {
    expect(sessionToRestore("2", sessions, "acme")).toBe("2");
    expect(sessionToRestore("3", sessions, "acme")).toBeNull();
    expect(sessionToRestore("1", sessions, "acme")).toBeNull();
    expect(sessionToRestore(undefined, sessions, "acme")).toBeNull();
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

describe("composerOptions", () => {
  const p = (id: string) => ({ id, name: id, path: `/${id}`, base_branch: "main" });
  const personal = w("personal", "Personal", ["a", "b"]);
  const lab = w("lab", "Lab", []);
  const sections = [sec("a", ["jaunt"]), sec("b", ["dotfiles", "jaunt"]), sec("c", ["acme-api"])];
  const hosts = {
    local: { connected: true, workspaces: [personal, lab, w("acme", "Acme", ["c"])], sections, projects: [p("jaunt"), p("dotfiles"), p("acme-api")] },
    devbox: { connected: true, workspaces: [w("r", "Remote", ["x"])], sections: [{ ...sec("x", ["api"]), name: "Servers" }], projects: [p("api")] },
  };
  const rows = (target: { host: string; id: string } | null) => composerOptions(hosts, target).map((o) => [o.host, o.project.id, o.section]);

  it("offers only the target workspace's projects once each, in section order, labelled with its sections", () => {
    expect(rows({ host: "local", id: "personal" })).toEqual([
      ["local", "jaunt", "a"],
      ["local", "dotfiles", "b"],
    ]);
  });

  it("offers nothing for a workspace without projects, so the composer asks to add one", () => {
    expect(rows({ host: "local", id: "lab" })).toEqual([]);
  });

  it("offers every connected host's projects without a target", () => {
    expect(rows(null)).toEqual([
      ["local", "jaunt", "a"],
      ["local", "dotfiles", "b"],
      ["local", "acme-api", "c"],
      ["devbox", "api", "Servers"],
    ]);
    expect(composerOptions({ ...hosts, devbox: { ...hosts.devbox, connected: false } }, null).map((o) => o.host)).not.toContain("devbox");
  });
});

describe("composerTarget", () => {
  it("is the workspace the composer was opened for, else the shown one", () => {
    expect(composerTarget("devbox", "r", { host: "local", id: "personal" })).toEqual({ host: "devbox", id: "r" });
    expect(composerTarget(undefined, "acme", { host: "local", id: "personal" })).toEqual({ host: "local", id: "acme" });
    expect(composerTarget(undefined, undefined, { host: "local", id: "personal" })).toEqual({ host: "local", id: "personal" });
    expect(composerTarget(undefined, undefined, null)).toBeNull();
  });
});

describe("newSectionWorkspace", () => {
  const workspaces = [w("personal", "Personal", []), w("acme", "Acme", [])];

  it("is the shown workspace on its host, else the host's first", () => {
    expect(newSectionWorkspace({ host: "local", id: "acme" }, "local", workspaces)).toBe("acme");
    expect(newSectionWorkspace({ host: "devbox", id: "r" }, "local", workspaces)).toBe("personal");
    expect(newSectionWorkspace(null, "local", [])).toBeNull();
  });
});

describe("the workspace settings page (X43)", () => {
  const acme = w("acme", "Acme", ["client", "infra"], "blue", "work");

  it("sums up where the workspace is and what it holds", () => {
    const sessions = [s("s1", "acme"), s("s2", "acme"), s("s3", "acme", true), s("s4", "personal")];
    expect(workspaceSummary(acme, null, sessions)).toBe("Workspace on this Mac · 2 sections · 2 sessions");
    expect(workspaceSummary(w("x", "X", ["one"]), "devbox", [s("s1", "x")])).toBe("Workspace on devbox · 1 section · 1 session");
  });

  it("lists its sections in order with their project counts", () => {
    expect(sectionRows(acme, [sec("infra", ["p3"]), sec("client", ["p1", "p2", "p4"])])).toEqual([
      { id: "client", name: "client", projects: "3 projects" },
      { id: "infra", name: "infra", projects: "1 project" },
    ]);
  });

  it("follows a change made elsewhere while the form is untouched", () => {
    const renamed = { ...acme, name: "Acme Inc", color: "violet" as const };
    expect(syncWorkspaceForm(acme, renamed, { name: "Acme", color: "blue", profile: "work" })).toEqual({ name: "Acme Inc", color: "violet", profile: "work" });
  });

  it("keeps the user's edits when the workspace changes elsewhere", () => {
    const renamed = { ...acme, name: "Acme Inc" };
    expect(syncWorkspaceForm(acme, renamed, { name: "Acme Corp", color: "blue", profile: "work" })).toEqual({ name: "Acme Corp", color: "blue", profile: "work" });
  });

  it("can save changes, but not a blank name, nothing changed, or during a save", () => {
    expect(workspaceCanSave(acme, { name: "Acme Inc", color: "blue", profile: "work" }, false)).toBe(true);
    expect(workspaceCanSave(acme, { name: "  ", color: "blue", profile: "work" }, false)).toBe(false);
    expect(workspaceCanSave(acme, { name: "Acme", color: "blue", profile: "work" }, false)).toBe(false);
    expect(workspaceCanSave(acme, { name: "Acme Inc", color: "blue", profile: "work" }, true)).toBe(false);
  });

  it("has unsaved changes once the name, colour or profile differs", () => {
    expect(workspaceDirty(acme, { name: "Acme", color: "blue", profile: "work" })).toBe(false);
    expect(workspaceDirty(acme, { name: " Acme ", color: "blue", profile: "work" })).toBe(false);
    expect(workspaceDirty(acme, { name: "Acme Inc", color: "blue", profile: "work" })).toBe(true);
    expect(workspaceDirty(acme, { name: "Acme", color: "violet", profile: "work" })).toBe(true);
    expect(workspaceDirty(acme, { name: "Acme", color: "blue", profile: "" })).toBe(true);
    expect(workspaceDirty(w("p", "Personal", []), { name: "Personal", color: "clay", profile: "" })).toBe(false);
  });
});
