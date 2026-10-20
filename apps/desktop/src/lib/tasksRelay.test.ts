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

describe("resolveTaskRequest (X57)", () => {
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
    expect(resolveTaskRequest({ kind: "create", board: "ops", column: "To Do", issue }, ctx)).toEqual({ kind: "create", board: ops, column: OPS[0], issue });
    expect(resolveTaskRequest({ kind: "create", board: "web", column: "Open", issue }, ctx)).toEqual({ kind: "create", board: repo, column: { name: "Open", statuses: ["open"], category: "todo" }, issue });
    expect(resolveTaskRequest({ kind: "create", board: "ops", column: "To Do", issue: { ...issue, title: "  " } }, ctx)).toEqual({ error: "A title is needed." });
  });

  it("asks for the form's people and labels, and tells of a session started from a task", () => {
    expect(resolveTaskRequest({ kind: "create_options", board: "ops", place: "OPS", issue_type: "10004" }, ctx)).toEqual({ kind: "create_options", board: ops, place: "OPS", issueType: "10004" });
    expect(resolveTaskRequest({ kind: "started", task: `${JIRA} OPS-1`, session: "Retry webhooks", assign: true }, ctx)).toEqual({ kind: "started", task: ops1, session: "Retry webhooks", assign: true });
  });
});
