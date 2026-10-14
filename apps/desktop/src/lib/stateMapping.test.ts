import { describe, expect, it } from "vitest";
import { applyStateMapping, targetState } from "./stateMapping";
import type { Task } from "./tasks";
import type { Connection } from "./tasksStore";

const conn: Connection = {
  id: "linear:acme",
  kind: "linear",
  site: "acme",
  account: "Ada",
  auth: "api_key",
  sources: [],
  states: { QA: "in_review", Backlog: "todo", "In Review": "in_review" },
};
const task = (key: string, state: string, column: Task["column"]): Task => ({
  connection: "linear:acme",
  key,
  title: key,
  url: "",
  column,
  priority: 0,
  assignees: [],
  labels: [],
  description: "",
  updatedMs: 0,
  tracker: { id: key, state, source: "ENG" },
});

describe("state mapping (X44 Workflow states)", () => {
  it("puts a task in the column its state is mapped to, else keeps the default", () => {
    const out = applyStateMapping([task("ENG-1", "QA", "in_progress"), task("ENG-2", "Backlog", "hidden"), task("ENG-3", "Done", "done")], [conn]);
    expect(out.map((t) => [t.key, t.column])).toEqual([
      ["ENG-1", "in_review"],
      ["ENG-2", "todo"],
      ["ENG-3", "done"],
    ]);
  });

  it("moves to the first state mapped to a column, or lets the tracker pick", () => {
    expect(targetState(conn, "in_review")).toBe("QA");
    expect(targetState(conn, "done")).toBe(null);
    expect(targetState({ ...conn, states: undefined }, "todo")).toBe(null);
  });
});
