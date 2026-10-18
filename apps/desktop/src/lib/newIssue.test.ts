import { describe, expect, it } from "vitest";
import type { BoardColumn, BoardConfig } from "./boards";
import { boardShows, createsIn, fitDraft, githubRepoOf, jiraProjectUrl, jiraProjects, needsPlace, projectRepos, withAccess, withCreated, canSubmit, createLock, createTarget, newIssueDraft } from "./newIssue";
import type { Task } from "./tasks";

const linear: BoardConfig = { id: "moon", name: "Moonlet", connection: "linear:acme", workspace: "local/personal", origin: { kind: "linear_team", team: "MOON" } };
const qa: BoardColumn = { name: "QA", statuses: ["QA", "Testing"], category: "in_review" };

describe("the column + (X52)", () => {
  it("shows on a shown column, creating in its first status; not on a folded or hidden one, or a repository's Closed", () => {
    expect(createTarget(linear, qa)).toEqual({ status: "QA" });
    expect(createTarget(linear, { ...qa, show: "fold" })).toBe(null);
    expect(createTarget(linear, { ...qa, show: "hide" })).toBe(null);
    expect(createTarget(linear, { ...qa, statuses: [] })).toBe(null);
    const repo: BoardConfig = { ...linear, connection: "github:github.com", origin: { kind: "github_repo", repo: "acme/web" } };
    expect(createTarget(repo, { name: "Open", statuses: ["open"], category: "todo" })).toEqual({ status: "open" });
    expect(createTarget(repo, { name: "Closed", statuses: ["completed", "not_planned"], category: "done", show: "fold" })).toBe(null);
    expect(createTarget(repo, { name: "Closed", statuses: ["completed", "not_planned"], category: "done" })).toBe(null);
    // A GitHub Project's No Status creates with no Status.
    const project: BoardConfig = { ...linear, connection: "github:github.com", origin: { kind: "github_project", owner: "acme", number: 2 } };
    expect(createTarget(project, { name: "No Status", statuses: [""], category: "todo" })).toEqual({ status: "" });
  });

  it("is disabled, saying why, while the tracker needs attention, its GitHub host is offline, or a Project lacks gh's project scope", () => {
    expect(createLock(linear, { hostOnline: true })).toBe(null);
    expect(createLock(linear, { attention: "Linear no longer accepts this token", hostOnline: true })).toBe("Reconnect Linear to create issues: Linear no longer accepts this token");
    const repo: BoardConfig = { ...linear, connection: "github:github.com", origin: { kind: "github_repo", repo: "acme/web" } };
    expect(createLock(repo, { hostOnline: false })).toBe("The host that runs gh is offline");
    const project: BoardConfig = { ...repo, origin: { kind: "github_project", owner: "acme", number: 2 } };
    expect(createLock(project, { hostOnline: true, scopes: ["repo", "read:project"] })).toBe("Adding issues to a Project needs gh's project scope: run gh auth refresh -s project");
    expect(createLock(project, { hostOnline: true, scopes: ["repo", "project"] })).toBe(null);
    // Scopes not read yet: not locked.
    expect(createLock(project, { hostOnline: true })).toBe(null);
  });

  it("starts the form assigned to the user, with the board's labels, so the issue matches the board", () => {
    expect(newIssueDraft({ ...linear, labels: ["frontend"] })).toEqual({ title: "", description: "", assignee: "me", labels: ["frontend"] });
    expect(newIssueDraft(linear).labels).toEqual([]);
  });

  it("creates once there is a title, the place and the Jira issue type it needs, and not while asking", () => {
    const draft = { ...newIssueDraft(linear), title: "Retry failed webhook deliveries" };
    expect(canSubmit(draft, { busy: false })).toBe(true);
    expect(canSubmit({ ...draft, title: "   " }, { busy: false })).toBe(false);
    expect(canSubmit(draft, { busy: true })).toBe(false);
    // A Jira board over several projects needs a project and an issue type.
    expect(canSubmit(draft, { busy: false, needsPlace: true, needsType: true })).toBe(false);
    expect(canSubmit({ ...draft, place: "OPS", issueType: "10001" }, { busy: false, needsPlace: true, needsType: true })).toBe(true);
    // A field Jira requires that the form lacks: create it in Jira.
    expect(canSubmit({ ...draft, place: "OPS", issueType: "10001" }, { busy: false, needsPlace: true, needsType: true, missing: ["Team"] })).toBe(false);
  });

  it("knows when the board can't show the new issue: someone else's on an Assignee: me board, outside its labels, or in a hidden column", () => {
    const columns: BoardColumn[] = [qa, { name: "Backlog", statuses: ["Backlog"], category: "todo", show: "hide" }];
    const issue: Task = { connection: "linear:acme", key: "MOON-142", title: "Retry failed webhook deliveries", url: "", column: "in_review", priority: 0, assignees: ["Sam Rivera"], labels: ["frontend"], description: "", updatedMs: 0, mine: true, tracker: { id: "i1", state: "QA", source: "MOON" } };
    expect(boardShows({ ...linear, labels: ["Frontend"] }, "me", columns, issue)).toBe(true);
    expect(boardShows(linear, "me", columns, { ...issue, mine: false })).toBe(false);
    expect(boardShows(linear, "anyone", columns, { ...issue, mine: false })).toBe(true);
    expect(boardShows({ ...linear, labels: ["backend"] }, "me", columns, issue)).toBe(false);
    expect(boardShows(linear, "me", columns, { ...issue, tracker: { id: "i1", state: "Backlog", source: "MOON" } })).toBe(false);
  });

  it("keeps a new issue on its board through a sync that started before it, and lets a later sync that lacks it say the board doesn't show it", () => {
    const issue = (key: string): Task => ({ connection: "linear:acme", key, title: key, url: "", column: "todo", priority: 0, assignees: [], labels: [], description: "", updatedMs: 0, tracker: { id: key, state: "Todo", source: "MOON" } });
    const synced = { tasks: [issue("MOON-1")], boards: { moon: { keys: ["linear:acme MOON-1"], sprint: null } } };
    const created = [{ boardId: "moon", task: issue("MOON-142"), at: 2_000 }];
    // A sync that started at 1 000, before the create at 2 000, ends without it: kept.
    expect(withCreated(synced, created, 1_000)).toEqual({
      tasks: [issue("MOON-1"), issue("MOON-142")],
      boards: { moon: { keys: ["linear:acme MOON-1", "linear:acme MOON-142"], sprint: null } },
      pending: created,
      gone: [],
    });
    // One that started at 3 000 and has it: the tracker's copy wins, nothing pending.
    const withIt = { ...synced, tasks: [issue("MOON-1"), { ...issue("MOON-142"), title: "Retry failed webhook deliveries" }], boards: { moon: { keys: ["linear:acme MOON-1", "linear:acme MOON-142"], sprint: null } } };
    expect(withCreated(withIt, created, 3_000)).toEqual({ ...withIt, pending: [], gone: [] });
    // One that started at 3 000 without it: the board doesn't show it.
    expect(withCreated(synced, created, 3_000)).toEqual({ ...synced, pending: [], gone: created });
    // A sync that didn't read its board (unpinned and no longer shown) leaves it pending, untouched.
    const other = [{ boardId: "design", task: issue("DES-7"), at: 2_000 }];
    expect(withCreated(synced, other, 3_000)).toEqual({ ...synced, pending: other, gone: [] });
  });

  it("shows on the boards of every tracker", () => {
    expect(createsIn(linear)).toBe(true);
    expect(createsIn({ ...linear, connection: "clickup:9015000001", origin: { kind: "clickup_list", list: "901500000002" } })).toBe(true);
    expect(createsIn({ ...linear, connection: "github:github.com", origin: { kind: "github_repo", repo: "acme/web" } })).toBe(true);
    expect(createsIn({ ...linear, connection: "github:github.com", origin: { kind: "github_project", owner: "acme", number: 2 } })).toBe(true);
    expect(createsIn({ ...linear, connection: "jira:acme.atlassian.net", origin: { kind: "jira_board", board: 10 } })).toBe(true);
    expect(createsIn({ ...linear, connection: "jira:acme.atlassian.net", origin: { kind: "jql", query: "project = EX" } })).toBe(true);
  });

  it("offers and sends no assignee or labels where they can't be set, as GitHub would drop them", () => {
    const draft = { ...newIssueDraft({ ...linear, labels: ["frontend"] }), title: "Hosts" };
    expect(withAccess(draft, true)).toEqual({ draft, assignment: true });
    expect(withAccess(draft, false)).toEqual({ draft: { ...draft, assignee: "none", labels: [] }, assignment: false });
  });

  it("asks a GitHub Project's new issue for its repository: the workspace's first, then those of the Project's items", () => {
    const project: BoardConfig = { ...linear, connection: "github:github.com", origin: { kind: "github_project", owner: "acme", number: 2 } };
    expect([needsPlace(project), needsPlace(linear)]).toEqual([true, false]);
    const item = (repo: string): Task => ({ connection: "github:github.com", key: `${repo}#1`, title: "", url: "", column: "open", priority: 0, assignees: [], labels: [], description: "", updatedMs: 0, github: { repo, number: 1, closingPrs: [], project: { id: "PVT_1", item: "PVTI_1", status: null } } });
    // The workspace's projects' origins, then the repositories of the board's items (by their keys).
    const items = [item("acme/web"), item("Acme/Storefront"), { ...item("acme/api"), key: "acme/api#1" }, item("acme/web")];
    expect(projectRepos({ web: "acme/storefront", docs: null }, items, ["github:github.com acme/web#1", "github:github.com Acme/Storefront#1"])).toEqual(["acme/storefront", "acme/web"]);
    expect(githubRepoOf(project, "acme/web")).toBe("acme/web");
    expect(githubRepoOf({ ...project, origin: { kind: "github_repo", repo: "acme/storefront" } }, "acme/web")).toBe("acme/storefront");
    expect(githubRepoOf(linear, "acme/web")).toBe(undefined);
  });

  it("keeps the user's choices when the repository changes, but an assignee the new one doesn't have goes back to Me", () => {
    const draft = { ...newIssueDraft({ ...linear, labels: ["frontend"] }), assignee: "kim" };
    expect(fitDraft(draft, ["kim", "sam-rivera"])).toEqual(draft);
    expect(fitDraft(draft, ["sam-rivera"])).toEqual({ ...draft, assignee: "me" });
    expect(fitDraft({ ...draft, assignee: "none" }, [])).toEqual({ ...draft, assignee: "none" });
  });

  it("asks a Jira board's new issue for its project: the projects of the board's issues, the most common first", () => {
    const jira = (key: string): Task => ({ connection: "jira:acme.atlassian.net", key, title: "", url: "", column: "todo", priority: 0, assignees: [], labels: [], description: "", updatedMs: 0, tracker: { id: key, state: "To Do", source: key.split("-")[0] } });
    const tasks = [jira("OPS-1"), jira("WEB-2"), jira("WEB-3"), jira("OPS-4"), jira("WEB-5"), jira("DES-6")];
    expect(jiraProjects(tasks, tasks.slice(0, 5).map((t) => `${t.connection} ${t.key}`))).toEqual(["WEB", "OPS"]);
    expect(jiraProjects(tasks, [])).toEqual([]);
    // Where to create it when Jira requires a field the form lacks.
    expect(jiraProjectUrl("jira:acme.atlassian.net", "EX")).toBe("https://acme.atlassian.net/browse/EX");
  });
});
