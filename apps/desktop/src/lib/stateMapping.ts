// Which tracker state lands in which column, per connection (X44 Workflow states).

import type { Task } from "./tasks";
import type { Connection } from "./tasksStore";

/** Tasks with each connection's state mapping applied; unmapped states keep their default column. */
export function applyStateMapping(tasks: Task[], connections: Connection[] | undefined): Task[] {
  const byId = new Map((connections ?? []).map((c) => [c.id, c.states ?? {}]));
  return tasks.map((t) => {
    const column = t.tracker && byId.get(t.connection)?.[t.tracker.state];
    return column ? { ...t, column } : t;
  });
}

