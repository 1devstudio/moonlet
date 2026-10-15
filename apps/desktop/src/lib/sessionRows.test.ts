import { describe, expect, it } from "vitest";
import { numberColumn, rowStyle, splitKey, taskGroups } from "./sessionRows";

describe("splitKey (X48 A · issue number column)", () => {
  it("splits a key into its prefix and its number", () => {
    expect(splitKey("MOON-142")).toEqual({ prefix: "MOON-", number: "142" });
    expect(splitKey("acme/web#12")).toEqual({ prefix: "#", number: "12" });
    expect(splitKey("CU-86abc")).toEqual({ prefix: "CU-", number: "86abc" });
    expect(splitKey("901")).toEqual({ prefix: "", number: "901" });
  });
});

describe("numberColumn (X48 A · issue number column)", () => {
  const line = (key: string, outOfSync = false) => ({ key, outOfSync });

  it("moves a shared prefix to the heading and keeps the numbers, blank for a session without a task", () => {
    expect(numberColumn(["a", "b", "c"], { a: line("MOON-142"), b: line("MOON-9", true) })).toEqual({
      prefix: "MOON-",
      cells: { a: { text: "142", outOfSync: false }, b: { text: "9", outOfSync: true }, c: { text: "", outOfSync: false } },
      width: 3,
    });
  });

  it("shows whole keys when the sessions' prefixes differ", () => {
    expect(numberColumn(["a", "b"], { a: line("MOON-142"), b: line("OPS-7") })).toEqual({
      prefix: null,
      cells: { a: { text: "MOON-142", outOfSync: false }, b: { text: "OPS-7", outOfSync: false } },
      width: 8,
    });
  });

  it("has no column when no session has a task", () => {
    expect(numberColumn(["a"], {})).toEqual({ prefix: null, cells: { a: { text: "", outOfSync: false } }, width: 0 });
  });
});

describe("taskGroups (X48 B · task as a sub-header)", () => {
  const line = (key: string, title: string, outOfSync = false) => ({ key, title, column: "in_progress" as const, outOfSync });
  const lines = { a: line("MOON-142", "Remote hosts sidebar"), b: line("MOON-142", "Remote hosts sidebar"), c: line("MOON-144", "File tabs", true) };

  it("puts sessions under their task in the order of each task's first session, sessions without a task last", () => {
    expect(taskGroups(["c", "x", "a", "b"], lines, { sources: true, groupedByTask: false })).toEqual([
      { key: "MOON-144", title: "File tabs", column: "in_progress", outOfSync: true, ids: ["c"] },
      { key: "MOON-142", title: "Remote hosts sidebar", column: "in_progress", outOfSync: false, ids: ["a", "b"] },
      { key: "", title: "No task", column: null, outOfSync: false, ids: ["x"] },
    ]);
  });

  it("adds no task lines to a section grouped by task, or in a workspace without a task source", () => {
    expect(taskGroups(["a", "x"], lines, { sources: true, groupedByTask: true })).toBe(null);
    expect(taskGroups(["x"], {}, { sources: false, groupedByTask: false })).toBe(null);
  });
});

describe("rowStyle (X48 Settings › Appearance › Session rows)", () => {
  it("is A unless B was picked", () => {
    expect(rowStyle("task")).toBe("task");
    expect(rowStyle("number")).toBe("number");
    expect(rowStyle(undefined)).toBe("number");
    expect(rowStyle("two-lines")).toBe("number");
  });
});
