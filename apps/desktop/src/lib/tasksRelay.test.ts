import { describe, expect, it } from "vitest";
import type { BoardColumn, BoardConfig } from "./boards";
import type { Task } from "./tasks";
import { resolveTaskRequest } from "./tasksRelay";

const JIRA = "jira:acme.atlassian.net";
const OPS: BoardColumn[] = [
  { name: "To Do", statuses: ["10001"], category: "todo" },
  { name: "In Progress", statuses: ["3"], category: "in_progress" },
  { name: "QA", statuses: ["10020", "10021"], category: "in_review" },
  { name: "Done", statuses: ["10002"], category: "done", show: "fold" },
];
const ops: BoardConfig = { id: "ops", name: "OPS · Sprint 42", connection: JIRA, workspace: "local/w", origin: { kind: "jira_board", board: 1 }, columns: OPS };
const repo: BoardConfig = { id: "web", name: "acme/web", connection: "github:github.com", workspace: "local/w", origin: { kind: "github_repo", repo: "acme/web" } };
const ops1: Task = { connection: JIRA, key: "OPS-1", title: "Retry webhooks", url: "", column: "todo", priority: 2, assignees: [], labels: [], description: "", updatedMs: 0, tracker: { id: "10501", state: "To Do", source: "OPS", statusId: "10001" } };
const ctx = { boards: [ops, repo], tasks: [ops1] };

describe("resolveTaskRequest (X76)", () => {
  it("moves a task to a column's first status, or to the status the phone names", () => {
    expect(resolveTaskRequest({ kind: "move", board: "ops", task: `${JIRA} OPS-1`, column: "QA" }, ctx)).toEqual({ kind: "move", task: ops1, category: "in_review", status: "10020" });
    expect(resolveTaskRequest({ kind: "move", board: "ops", task: `${JIRA} OPS-1`, column: "QA", status: "10021" }, ctx)).toEqual({ kind: "move", task: ops1, category: "in_review", status: "10021" });
  });

  it("refuses what the Mac no longer has, saying what", () => {
    expect(resolveTaskRequest({ kind: "move", board: "gone", task: `${JIRA} OPS-1`, column: "QA" }, ctx)).toEqual({ error: "That board is no longer in moonlet on the Mac." });
    expect(resolveTaskRequest({ kind: "move", board: "ops", task: `${JIRA} OPS-9`, column: "QA" }, ctx)).toEqual({ error: "OPS-9 is no longer on OPS · Sprint 42." });
    expect(resolveTaskRequest({ kind: "move", board: "ops", task: `${JIRA} OPS-1`, column: "Blocked" }, ctx)).toEqual({ error: "OPS · Sprint 42 has no Blocked column." });
    expect(resolveTaskRequest({ kind: "move", board: "ops", task: `${JIRA} OPS-1`, column: "QA", status: "99" }, ctx)).toEqual({ error: "QA has no status 99." });
    expect(resolveTaskRequest({ kind: "dance" }, ctx)).toEqual({ error: "moonlet on the Mac does not know dance requests. Update moonlet on the Mac." });
  });

  it("creates in a column, a GitHub repository's Open too, with a title", () => {
    const issue = { title: "Retry webhooks with backoff", description: "", assignee: "me", labels: [] };
    const jira = { ...issue, place: "OPS", issueType: "10004" };
    expect(resolveTaskRequest({ kind: "create", board: "ops", column: "To Do", issue: jira }, { ...ctx, boardKeys: { ops: [`${JIRA} OPS-1`] } })).toEqual({ kind: "create", board: ops, column: OPS[0], issue: jira });
    expect(resolveTaskRequest({ kind: "create", board: "web", column: "Open", issue }, ctx)).toEqual({ kind: "create", board: repo, column: { name: "Open", statuses: ["open"], category: "todo" }, issue });
    expect(resolveTaskRequest({ kind: "create", board: "ops", column: "To Do", issue: { ...issue, title: "  " } }, ctx)).toEqual({ error: "A title is needed." });
  });

  it("asks for the form's people and labels, and tells of a session started from a task", () => {
    expect(resolveTaskRequest({ kind: "create_options", board: "ops", place: "OPS", issue_type: "10004" }, { ...ctx, boardKeys: { ops: [`${JIRA} OPS-1`] } })).toEqual({ kind: "create_options", board: ops, place: "OPS", issueType: "10004" });
    expect(resolveTaskRequest({ kind: "started", task: `${JIRA} OPS-1`, session: "Retry webhooks", assign: true }, ctx)).toEqual({ kind: "started", task: ops1, session: "Retry webhooks", assign: true });
  });
});

describe("resolveTaskRequest checks a create as the form does (X76, X52)", () => {
  const jql: BoardConfig = { id: "q", name: "OPS + PLAT", connection: JIRA, workspace: "local/w", origin: { kind: "jql", query: "project in (OPS, PLAT)" }, columns: OPS };
  const project: BoardConfig = { id: "p", name: "Roadmap", connection: "github:github.com", workspace: "local/w", origin: { kind: "github_project", owner: "acme", number: 4 }, columns: OPS };
  const c = { boards: [jql, project], tasks: [ops1], repos: { web: "acme/web" }, boardKeys: { q: [`${JIRA} OPS-1`], p: [] } };
  const issue = { title: "Retry webhooks", description: "", assignee: "me", labels: [] };

  it("needs a Jira project of the board's and an issue type", () => {
    expect(resolveTaskRequest({ kind: "create", board: "q", column: "To Do", issue }, c)).toEqual({ error: "Pick where the issue goes." });
    expect(resolveTaskRequest({ kind: "create", board: "q", column: "To Do", issue: { ...issue, place: "SECRET", issueType: "1" } }, c)).toEqual({ error: "OPS + PLAT does not take issues in SECRET." });
    expect(resolveTaskRequest({ kind: "create", board: "q", column: "To Do", issue: { ...issue, place: "OPS" } }, c)).toEqual({ error: "Pick an issue type." });
    expect(resolveTaskRequest({ kind: "create", board: "q", column: "To Do", issue: { ...issue, place: "OPS", issueType: "10004" } }, c)).toMatchObject({ kind: "create" });
  });

  it("puts a GitHub Project's issue only in one of the workspace's repositories", () => {
    expect(resolveTaskRequest({ kind: "create", board: "p", column: "To Do", issue: { ...issue, place: "evil/repo" } }, c)).toEqual({ error: "Roadmap does not take issues in evil/repo." });
    expect(resolveTaskRequest({ kind: "create", board: "p", column: "To Do", issue: { ...issue, place: "acme/web" } }, c)).toMatchObject({ kind: "create" });
  });
});

describe("resolveTaskRequest: fixes, syncs and comments from the phone (X76)", () => {
  it("runs a card's fix, syncs a board, and reads or posts a task's comments", () => {
    expect(resolveTaskRequest({ kind: "fix", board: "ops", task: `${JIRA} OPS-1` }, ctx)).toEqual({ kind: "fix", board: ops, task: ops1, plan: null });
    expect(resolveTaskRequest({ kind: "sync", board: "ops" }, ctx)).toEqual({ kind: "sync", board: ops });
    expect(resolveTaskRequest({ kind: "comments", board: "ops", task: `${JIRA} OPS-1` }, ctx)).toEqual({ kind: "comments", task: ops1 });
    expect(resolveTaskRequest({ kind: "comment", board: "ops", task: `${JIRA} OPS-1`, body: "Picked this up." }, ctx)).toEqual({ kind: "comment", task: ops1, body: "Picked this up." });
  });

  it("posts no blank comment, and nothing about a task the board no longer has", () => {
    expect(resolveTaskRequest({ kind: "comment", board: "ops", task: `${JIRA} OPS-1`, body: "  " }, ctx)).toEqual({ error: "A comment needs some text." });
    expect(resolveTaskRequest({ kind: "fix", board: "ops", task: `${JIRA} OPS-9` }, ctx)).toEqual({ error: "OPS-9 is no longer on OPS · Sprint 42." });
    expect(resolveTaskRequest({ kind: "comments", board: "gone", task: `${JIRA} OPS-1` }, ctx)).toEqual({ error: "That board is no longer in moonlet on the Mac." });
  });
});

describe("resolveTaskRequest keeps to the board the phone names (X76)", () => {
  it("refuses a task of another board of the workspace", () => {
    const keyed = { ...ctx, boardKeys: { ops: [], web: [`${JIRA} OPS-1`] } };
    for (const kind of ["move", "fix", "comments", "comment"]) {
      expect(resolveTaskRequest({ kind, board: "ops", task: `${JIRA} OPS-1`, column: "QA", body: "x" }, keyed)).toEqual({ error: "OPS-1 is no longer on OPS · Sprint 42." });
    }
    expect(resolveTaskRequest({ kind: "move", board: "ops", task: `${JIRA} OPS-1`, column: "QA" }, { ...keyed, boardKeys: { ops: [`${JIRA} OPS-1`] } })).toMatchObject({ kind: "move" });
  });
});

describe("resolveTaskRequest moves only to a column that has a status (X76)", () => {
  it("refuses a column with no statuses", () => {
    const empty: BoardConfig = { ...ops, columns: [...OPS, { name: "Blocked", statuses: [], category: "in_progress" }] };
    expect(resolveTaskRequest({ kind: "move", board: "ops", task: `${JIRA} OPS-1`, column: "Blocked" }, { ...ctx, boards: [empty] })).toEqual({ error: "Blocked has no status to move to." });
  });

  it("carries the fix the phone confirmed", () => {
    expect(resolveTaskRequest({ kind: "fix", board: "ops", task: `${JIRA} OPS-1`, plan: "k1" }, ctx)).toEqual({ kind: "fix", board: ops, task: ops1, plan: "k1" });
  });
});

describe("resolveTaskRequest asks the form's lists only where the board creates (X76, X52)", () => {
  const jql: BoardConfig = { id: "q", name: "OPS + PLAT", connection: JIRA, workspace: "local/w", origin: { kind: "jql", query: "project in (OPS, PLAT)" }, columns: OPS };
  const c = { boards: [jql], tasks: [ops1], boardKeys: { q: [`${JIRA} OPS-1`] } };
  it("refuses another project's people and labels", () => {
    expect(resolveTaskRequest({ kind: "create_options", board: "q", place: "SECRET" }, c)).toEqual({ error: "OPS + PLAT does not take issues in SECRET." });
    expect(resolveTaskRequest({ kind: "create_options", board: "q", place: "OPS" }, c)).toMatchObject({ kind: "create_options", place: "OPS" });
  });
});
