import { describe, expect, it } from "vitest";
import { composerWorkspace, isShown, workspaceMembers, lastSessionKey, mergeHost, mergeProfileChange, mergePrompt, sharedNotice, mergeTargets, parseWsKey, restoreTarget, rowNeedsYou, wsKey, composerOptions, composerPick, composerProjects, composerTarget, createRequest, newSectionWorkspace, currentWorkspace, deleteBlocked, switcherRows, workspaceDirty, workspaceInitial, sectionRows, syncWorkspaceForm, workspaceCanSave, workspacesNeedingYou, workspaceSummary } from "./workspaces";
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

describe("workspaces of an account (X68)", () => {
  // Both Macs list both "Personal" workspaces: the MacBook's and studio-mini's.
  const book = { ...w("b1", "Personal", ["a"]), made_by: "Alex's MacBook Pro" };
  const mini = { ...w("m1", "Personal", ["c"], "blue"), made_by: "studio-mini" };
  const shared = [sec("a"), sec("c")];
  const members = [
    { host: "local", label: "This Mac", account: "acct-mini", workspaces: [book, mini], sections: shared, sessions: [s("1", "b1")], profiles: [] },
    { host: "studio-mini", label: "studio-mini", account: "acct-mini", workspaces: [book, mini], sections: shared, sessions: [s("2", "b1"), s("3", "m1")], profiles: [] },
  ];
  // A host outside the account, with a workspace whose id happens to match.
  const devbox = { host: "devbox", label: "devbox", account: "devbox", workspaces: [w("b1", "Lab", [])], sections: [], sessions: [], profiles: [] };

  it("lists the account's workspaces once with every member's sessions, and a host outside it apart", () => {
    const rows = switcherRows([...members, devbox]);
    expect(rows.map((r) => [r.hostLabel, r.ws.name, r.summary, r.kbd])).toEqual([
      ["This Mac", "Personal", "1 section · 2 sessions · Default", "⌃⌘1"],
      [null, "Personal", "1 section · 1 session · Default", "⌃⌘2"],
      ["devbox", "Lab", "0 sections · 0 sessions · Default", "⌃⌘3"],
    ]);
    expect(rows.map((r) => r.hosts)).toEqual([["local", "studio-mini"], ["local", "studio-mini"], ["devbox"]]);
    // Two of one name say which Mac made each, until they are merged.
    expect(rows.map((r) => r.from)).toEqual(["Alex's MacBook Pro", "studio-mini", null]);
  });

  it("shows a shared workspace on every member of its account, never on a host outside it", () => {
    const shown = { host: "local", id: "b1", account: "acct-mini" };
    expect(isShown(shown, "studio-mini", "b1", "acct-mini")).toBe(true);
    expect(isShown(shown, "studio-mini", "m1", "acct-mini")).toBe(false);
    expect(isShown(shown, "devbox", "b1", "devbox")).toBe(false);
    expect(newSectionWorkspace(shown, "studio-mini", [mini, book], "acct-mini")).toBe("b1");
    expect(newSectionWorkspace(shown, "devbox", [w("lab2", "Lab", [])], "devbox")).toBe("lab2");
  });

  it("keeps showing a shared workspace from a member that still lists it", () => {
    // This Mac's daemon restarts, and lists nothing for a moment.
    const hosts = [{ ...members[0], workspaces: [] }, members[1]];
    expect(currentWorkspace({ host: "local", id: "m1", account: "acct-mini" }, hosts)).toEqual({ host: "studio-mini", id: "m1", account: "acct-mini" });
  });

  it("merges a workspace only into another of its account, on a member that lists both", () => {
    const rows = switcherRows([...members, devbox]);
    const cur = rows.find((r) => r.ws.id === "m1")!;
    expect(mergeTargets(rows, cur).map((r) => [r.host, r.ws.id])).toEqual([["local", "b1"]]);
    expect(mergeHost(cur, mergeTargets(rows, cur)[0])).toBe("local");
    expect(mergeTargets(rows, rows[2])).toEqual([]);
  });

  it("asks before merging, saying what moves and what goes, and what a new profile does to running agents", () => {
    expect(mergePrompt(mini, book)).toEqual({
      title: "Merge workspaces",
      message: "Move the 1 section of this Personal, with its sessions, into the other Personal, and delete this one? Every Mac sharing them gets the change.",
      action: "Merge",
    });
    expect(mergePrompt(w("acme", "Acme", ["x", "y"]), book).message).toBe(
      "Move the 2 sections of Acme, with their sessions, into Personal, and delete Acme? Every Mac sharing them gets the change.",
    );
    expect(mergePrompt(w("acme", "Acme", ["x"]), book, { agents: 2, profile: "Work profile" }).message).toBe(
      "Move the 1 section of Acme, with its sessions, into Personal, and delete Acme? Every Mac sharing them gets the change. 2 sessions in this workspace have agents. A running agent keeps its account until it restarts, then signs in with Work profile and starts a new conversation.",
    );
  });

  it("starts a session in the shown workspace on whichever member has the project", () => {
    const target = { host: "local", id: "b1", account: "acct-mini" };
    expect(composerWorkspace(target, "studio-mini", [...members, devbox])).toBe("b1");
    expect(composerWorkspace(target, "devbox", [...members, devbox])).toBeNull();
    expect(composerWorkspace(null, "local", members)).toBeNull();
  });

  it("reopens the session last open in a shared workspace on the member it is on", () => {
    const ref = { host: "local", id: "b1", account: "acct-mini" };
    expect(lastSessionKey(ref)).toBe("acct-mini/b1");
    expect(restoreTarget("studio-mini/2", [...members, devbox], ref)).toEqual({ host: "studio-mini", session: "2" });
    // Saved before X68: the session id alone, on the shown host.
    expect(restoreTarget("1", members, ref)).toEqual({ host: "local", session: "1" });
    expect(restoreTarget("studio-mini/3", members, ref)).toBeNull();
  });

  it("says once that this Mac's workspaces are now shared with its central host", () => {
    expect(sharedNotice({ account: "acct-mini", central: "studio-mini" }, [])).toBe("Workspaces are now shared with studio-mini");
    expect(sharedNotice({ account: "acct-mini", central: "studio-mini" }, ["acct-mini"])).toBeNull();
    expect(sharedNotice({ account: "7d3f", central: null }, [])).toBeNull();
  });

  it("warns of a new Claude profile only when merging moves running agents to another one", () => {
    const work = { id: "pw", name: "Work profile", path: "/w", created_at: 0, account: null, hooks_installed: true };
    const acme = { ...w("acme", "Acme", ["x"]), claude_profile: "pw" };
    expect(mergeProfileChange(acme, book, [work], 2)).toEqual({ agents: 2, profile: "Default" });
    expect(mergeProfileChange(book, acme, [work], 1)).toEqual({ agents: 1, profile: "Work profile" });
    expect(mergeProfileChange(book, mini, [work], 3)).toBeUndefined();
    expect(mergeProfileChange(acme, book, [work], 0)).toBeUndefined();
  });

  it("lists the hosts of a workspace's account that list it, its own host first", () => {
    const ref = { host: "studio-mini", id: "b1", account: "acct-mini" };
    expect(workspaceMembers(ref, [...members, devbox])).toEqual(["studio-mini", "local"]);
    expect(workspaceMembers({ host: "devbox", id: "b1", account: "devbox" }, [...members, devbox])).toEqual(["devbox"]);
  });

  it("marks a shared workspace when a session on any member needs you", () => {
    const rows = switcherRows(members);
    expect(rowNeedsYou(rows[0], new Set(["studio-mini/b1"]))).toBe(true);
    expect(rowNeedsYou(rows[1], new Set(["studio-mini/b1"]))).toBe(false);
  });
});

describe("currentWorkspace", () => {
  const hosts = [{ host: "local", label: "This Mac", workspaces: [w("personal", "Personal", []), w("acme", "Acme", [])], sections: [], sessions: [], profiles: [] }];

  it("keeps the remembered workspace while it exists, else falls back to the first", () => {
    // A host that says no account is its own (X68).
    expect(currentWorkspace({ host: "local", id: "acme" }, hosts)).toEqual({ host: "local", id: "acme", account: "local" });
    expect(currentWorkspace({ host: "local", id: "deleted" }, hosts)).toEqual({ host: "local", id: "personal", account: "local" });
    expect(currentWorkspace(null, hosts)).toEqual({ host: "local", id: "personal", account: "local" });
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

describe("composerPick (X44, X46 starting a session from an issue)", () => {
  const o = (id: string) => ({ host: "local", project: { id, name: id }, section: null });
  const options = [o("web"), o("api"), o("docs")];
  const pick = (preset: string | undefined, linked: string[] | undefined, current?: string) => composerPick(options, { host: "local", preset, linked, current: current ? { host: "local", id: current } : null })?.project.id ?? null;

  it("starts in the one linked project, and in none when several are linked", () => {
    expect(pick(undefined, ["api"], "docs")).toBe("api");
    expect(pick(undefined, ["web", "api"], "docs")).toBe(null);
  });

  it("falls back to the preset, then the current session's project, then the first, with none linked", () => {
    expect(pick("api", [], "docs")).toBe("api");
    expect(pick(undefined, [], "docs")).toBe("docs");
    expect(pick(undefined, undefined)).toBe("web");
  });

  it("stays in an adopted worktree's project, whatever links the issue", () => {
    const adopt = (linked: string[]) => composerPick(options, { host: "local", preset: "web", linked, current: null, worktree: true })?.project.id;
    expect(adopt(["web", "api"])).toBe("web");
    expect(adopt(["api"])).toBe("web");
  });

  it("ignores a linked project outside the workspace", () => {
    expect(pick(undefined, ["elsewhere"], "docs")).toBe("docs");
  });
});

describe("composerProjects (X44 the composer's project search)", () => {
  const o = (id: string, name: string) => ({ host: "local", project: { id, name }, section: null });
  const options = [o("1", "storefront"), o("2", "store-api"), o("3", "docs")];
  const ids = (query: string, linked: string[] = []) => {
    const r = composerProjects(options, linked, query, "local");
    return [r.linked.map((x) => x.project.id), r.others.map((x) => x.project.id)];
  };

  it("lists the linked projects first, then the others", () => {
    expect(ids("", ["3"])).toEqual([["3"], ["1", "2"]]);
  });

  it("counts as linked only a project on the issue's host", () => {
    const both = [{ host: "local", project: { id: "1", name: "web" }, section: null }, { host: "devbox", project: { id: "1", name: "web" }, section: null }];
    const r = composerProjects(both, ["1"], "", "local");
    expect([r.linked.map((x) => x.host), r.others.map((x) => x.host)]).toEqual([["local"], ["devbox"]]);
  });

  it("keeps the projects whose name has the query, ignoring case", () => {
    expect(ids("STORE")).toEqual([[], ["1", "2"]]);
    expect(ids("api", ["3"])).toEqual([[], ["2"]]);
  });
});

describe("wsKey and parseWsKey (one build, one parse)", () => {
  it("writes and reads a workspace's host/id key, an id with a slash included", () => {
    expect(wsKey("mac-mini", "personal")).toBe("mac-mini/personal");
    expect(parseWsKey("mac-mini/personal")).toEqual({ host: "mac-mini", id: "personal" });
    expect(parseWsKey("local/a/b")).toEqual({ host: "local", id: "a/b" });
  });
});
