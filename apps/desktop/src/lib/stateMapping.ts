// Which tracker state lands in which column, per connection (X44 Workflow states).

import type { Column, Task } from "./tasks";
import type { Connection } from "./tasksStore";

/** Tasks with each connection's state mapping applied; unmapped states keep their default column. */
export function applyStateMapping(tasks: Task[], connections: Connection[] | undefined): Task[] {
  const byId = new Map((connections ?? []).map((c) => [c.id, c.states ?? {}]));
  return tasks.map((t) => {
    const column = t.tracker && byId.get(t.connection)?.[t.tracker.state];
    return column ? { ...t, column } : t;
  });
}

/** The state a move to `column` uses: the first one mapped to it, or null for the tracker's default. */
export function targetState(connection: Connection | undefined, column: Exclude<Column, "hidden">): string | null {
  return Object.entries(connection?.states ?? {}).find(([, c]) => c === column)?.[0] ?? null;
}
