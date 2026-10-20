// Tasks on the phone (X57): what a phone's request asks the app to do,
// checked against the boards the app has. Pure; the Tasks store runs it.

import { type BoardColumn, type BoardConfig, type Category, syncedColumns } from "./boards";
import type { NewIssue } from "./newIssue";
import { type Task, taskId } from "./tasks";

/** A request a phone sends through the daemon (`tasks.request`'s `action`). */
export type TaskAction =
  | { kind: "move"; board: string; task: string; column: string; status?: string }
  | { kind: "create_options"; board: string; place?: string; issue_type?: string }
  | { kind: "create"; board: string; column: string; issue: NewIssue }
  | { kind: "started"; task: string; session: string; assign: boolean };

/** The daemon's `tasks.request` event. */
export interface TaskRequestEvent {
  request_id: number;
  workspace: string;
  action: { kind: string } & Record<string, unknown>;
}

/** What the app does for a request, or why it will not. */
export type Resolved =
  | { kind: "move"; task: Task; category: Category; status: string }
  | { kind: "create_options"; board: BoardConfig; place?: string; issueType?: string }
  | { kind: "create"; board: BoardConfig; column: BoardColumn; issue: NewIssue }
  | { kind: "started"; task: Task; session: string; assign: boolean }
  | { error: string };

/** `action` against the workspace's boards and tasks. */
export function resolveTaskRequest(action: { kind: string } & Record<string, unknown>, ctx: { boards: BoardConfig[]; tasks: Task[] }): Resolved {
  const a = action as TaskAction;
  const board = "board" in a ? ctx.boards.find((b) => b.id === a.board) : undefined;
  const task = "task" in a ? ctx.tasks.find((t) => taskId(t) === a.task) : undefined;
  const keyOf = (id: string) => id.slice(id.indexOf(" ") + 1);
  switch (a.kind) {
    case "move": {
      if (!board) return { error: "That board is no longer in moonlet on the Mac." };
      if (!task) return { error: `${keyOf(a.task)} is no longer on ${board.name}.` };
      const column = syncedColumns(board, null).find((c) => c.name === a.column);
      if (!column) return { error: `${board.name} has no ${a.column} column.` };
      if (a.status !== undefined && !column.statuses.includes(a.status)) return { error: `${column.name} has no status ${a.status}.` };
      return { kind: "move", task, category: column.category, status: a.status ?? column.statuses[0] };
    }
    case "create_options":
      if (!board) return { error: "That board is no longer in moonlet on the Mac." };
      return { kind: "create_options", board, ...(a.place !== undefined && { place: a.place }), ...(a.issue_type !== undefined && { issueType: a.issue_type }) };
    case "create": {
      if (!board) return { error: "That board is no longer in moonlet on the Mac." };
      const column = syncedColumns(board, null).find((c) => c.name === a.column);
      if (!column) return { error: `${board.name} has no ${a.column} column.` };
      if (!a.issue?.title?.trim()) return { error: "A title is needed." };
      return { kind: "create", board, column, issue: a.issue };
    }
    case "started":
      if (!task) return { error: `${keyOf(a.task)} is no longer on a board in moonlet on the Mac.` };
      return { kind: "started", task, session: a.session, assign: !!a.assign };
    default:
      return { error: `moonlet on the Mac does not know ${String(action.kind)} requests. Update moonlet on the Mac.` };
  }
}
