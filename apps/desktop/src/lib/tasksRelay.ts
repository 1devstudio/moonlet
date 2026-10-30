// Tasks on the phone (X76): what a phone's request asks the app to do,
// checked against the boards the app has. Pure; the Tasks store runs it.

import { type BoardColumn, type BoardConfig, type Category, syncedColumns } from "./boards";
import { jiraProjects, type NewIssue, needsPlace, needsType, projectRepos } from "./newIssue";
import { type Task, taskId } from "./tasks";

/** A request a phone sends through the daemon (`tasks.request`'s `action`). */
export type TaskAction =
  | { kind: "move"; board: string; task: string; column: string; status?: string }
  /** `plan`: the chip the phone showed and confirmed (the desktop's `driftKey`). */
  | { kind: "fix"; board: string; task: string; plan?: string }
  | { kind: "sync"; board: string }
  | { kind: "comments"; board: string; task: string }
  | { kind: "comment"; board: string; task: string; body: string }
  | { kind: "create_options"; board: string; place?: string; issue_type?: string }
  | { kind: "create"; board: string; column: string; issue: NewIssue }
  | { kind: "started"; board: string; task: string; session: string; assign: boolean };

/** The daemon's `tasks.request` event. */
export interface TaskRequestEvent {
  request_id: number;
  workspace: string;
  action: { kind: string } & Record<string, unknown>;
}

/** What the app does for a request, or why it will not. */
export type Resolved =
  | { kind: "move"; task: Task; category: Category; status: string }
  | { kind: "fix"; board: BoardConfig; task: Task; plan: string | null }
  | { kind: "sync"; board: BoardConfig }
  | { kind: "comments"; task: Task }
  | { kind: "comment"; task: Task; body: string }
  | { kind: "create_options"; board: BoardConfig; place?: string; issueType?: string }
  | { kind: "create"; board: BoardConfig; column: BoardColumn; issue: NewIssue }
  | { kind: "started"; task: Task; session: string; assign: boolean }
  | { error: string };

/** `action` against the workspace's boards and tasks. */
export function resolveTaskRequest(
  action: { kind: string } & Record<string, unknown>,
  ctx: { boards: BoardConfig[]; tasks: Task[]; repos?: Record<string, string | null>; boardKeys?: Record<string, string[]> },
): Resolved {
  const a = action as TaskAction;
  const board = "board" in a ? ctx.boards.find((b) => b.id === a.board) : undefined;
  const task = "task" in a ? ctx.tasks.find((t) => taskId(t) === a.task) : undefined;
  const keyOf = (id: string) => id.slice(id.indexOf(" ") + 1);
  // Where the Mac's own form lets a board create: its Jira projects or the workspace's repositories (X52).
  const placesOf = (b: BoardConfig) => {
    const keys = ctx.boardKeys?.[b.id] ?? [];
    return b.origin.kind === "github_project" ? projectRepos(ctx.repos, ctx.tasks, keys) : jiraProjects(ctx.tasks, keys);
  };
  // A board's own task only: never another board's of the workspace.
  const onBoard = (t: Task | undefined) => (t && board && ctx.boardKeys ? (ctx.boardKeys[board.id] ?? []).includes(taskId(t)) : !!t);
  switch (a.kind) {
    case "move": {
      if (!board) return { error: "That board is no longer in moonlet on the Mac." };
      if (!onBoard(task)) return { error: `${keyOf(a.task)} is no longer on ${board.name}.` };
      const column = syncedColumns(board, null).find((c) => c.name === a.column);
      if (!column) return { error: `${board.name} has no ${a.column} column.` };
      if (a.status !== undefined && !column.statuses.includes(a.status)) return { error: `${column.name} has no status ${a.status}.` };
      if (!column.statuses.length) return { error: `${column.name} has no status to move to.` };
      return { kind: "move", task: task!, category: column.category, status: a.status ?? column.statuses[0] };
    }
    case "fix":
    case "comments":
    case "comment": {
      if (!board) return { error: "That board is no longer in moonlet on the Mac." };
      if (!onBoard(task)) return { error: `${keyOf(a.task)} is no longer on ${board.name}.` };
      if (a.kind === "fix") return { kind: "fix", board, task: task!, plan: a.plan ?? null };
      if (a.kind === "comments") return { kind: "comments", task: task! };
      if (!a.body?.trim()) return { error: "A comment needs some text." };
      return { kind: "comment", task: task!, body: a.body };
    }
    case "sync":
      if (!board) return { error: "That board is no longer in moonlet on the Mac." };
      return { kind: "sync", board };
    case "create_options": {
      if (!board) return { error: "That board is no longer in moonlet on the Mac." };
      // Only a place the board creates in: never another project's people and labels (X52).
      const place = needsPlace(board) ? a.place : undefined;
      if (place !== undefined && !placesOf(board).some((p) => p.toLowerCase() === place.toLowerCase())) return { error: `${board.name} does not take issues in ${place}.` };
      return { kind: "create_options", board, ...(place !== undefined && { place }), ...(a.issue_type !== undefined && { issueType: a.issue_type }) };
    }
    case "create": {
      if (!board) return { error: "That board is no longer in moonlet on the Mac." };
      const column = syncedColumns(board, null).find((c) => c.name === a.column);
      if (!column) return { error: `${board.name} has no ${a.column} column.` };
      if (!a.issue?.title?.trim()) return { error: "A title is needed." };
      // Only where the Mac's own form would put it (X52).
      if (needsPlace(board)) {
        const places = placesOf(board);
        if (!a.issue.place) return { error: "Pick where the issue goes." };
        if (!places.some((p) => p.toLowerCase() === a.issue.place!.toLowerCase())) return { error: `${board.name} does not take issues in ${a.issue.place}.` };
      }
      if (needsType(board) && !a.issue.issueType) return { error: "Pick an issue type." };
      return { kind: "create", board, column, issue: a.issue };
    }
    case "started":
      if (!board) return { error: "That board is no longer in moonlet on the Mac." };
      if (!onBoard(task)) return { error: `${keyOf(a.task)} is no longer on ${board.name}.` };
      return { kind: "started", task: task!, session: a.session, assign: !!a.assign };
    default:
      return { error: `moonlet on the Mac does not know ${String(action.kind)} requests. Update moonlet on the Mac.` };
  }
}
