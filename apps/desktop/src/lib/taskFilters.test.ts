import { describe, expect, it } from "vitest";
import type { ColumnView } from "./boardColumns";
import type { Task } from "./tasks";
import type { BoardSession, Card } from "./tasksBoard";
import { applyFilters, matchingValues, searchFilterMenu, arrange, countLine, DEFAULT_DISPLAY, panelKey, boardFilters, saveFilters, chipOf, filterFields, flipOp, removeFilter, toggleValue, ME, NONE, type TaskFilter } from "./taskFilters";

const task = (key: string, o: Partial<Task> = {}): Task => ({ connection: "linear:acme", key, title: key, url: "", column: "todo", priority: 0, assignees: [], labels: [], description: "", updatedMs: 0, ...o });
const session = (name: string, o: Partial<BoardSession> = {}): BoardSession => ({ id: name, name, branch: name, path: `/w/${name}`, archived: false, task: null, task_unlinked: false, state: "idle", pr: null, additions: 0, subagents: 0, originRepo: null, ...o });
const card = (t: Task, o: Partial<Card> = {}): Card => ({ task: t, column: "todo", rows: [], archived: [], needsYou: false, orphans: [], empty: "No sessions", drift: null, ...o });
const withSession = (t: Task, s: BoardSession, o: Partial<Card> = {}) => card(t, { rows: [{ session: s, meta: { text: "", tone: "muted" } }], empty: null, ...o });
const view = (name: string, category: ColumnView["category"], cards: Card[], folded = false): ColumnView => ({ name, category, folded, cards });
const keys = (views: ColumnView[]) => views.map((v) => `${v.name}: ${v.cards.map((c) => c.task.key).join(" ")}`);

// The design's Storefront board, cut down: Backlog folded, Todo, In Progress, Done folded.
const BOARD: ColumnView[] = [
  view("Backlog", "todo", [card(task("MOON-170", { priority: 1 }))], true),
  view("Todo", "todo", [card(task("MOON-158", { priority: 2, issueType: "Feature", mine: true })), card(task("MOON-163", { priority: 1, assignees: ["Ana Costa"], mine: false, labels: ["ux"] })), withSession(task("MOON-166", { priority: 3, issueType: "Bug", mine: false, assignees: ["Jonas Weber"] }), session("Retries"))]),
  view("In Progress", "in_progress", [withSession(task("MOON-142", { priority: 3, issueType: "Bug", assignees: ["Marta Lind"], mine: false, labels: ["mobile", "ux"], cycle: 14 }), session("Checkout", { pr: { number: 41, url: "", state: "open", title: "", checks: [], review_decision: null } }), { needsYou: true })]),
  view("Done", "done", [card(task("MOON-120", { priority: 2, assignees: ["Ana Costa"], mine: false, cycle: 13 }))], true),
];

describe("applyFilters (X100 applied filters)", () => {
  it("keeps the tasks in a picked state, or leaves them out with is not", () => {
    expect(keys(applyFilters(BOARD, [{ field: "state", values: ["Todo"], not: false }]))).toEqual(["Backlog: ", "Todo: MOON-158 MOON-163 MOON-166", "In Progress: ", "Done: "]);
    expect(keys(applyFilters(BOARD, [{ field: "state", values: ["Todo", "Done"], not: true }]))).toEqual(["Backlog: MOON-170", "Todo: ", "In Progress: MOON-142", "Done: "]);
  });
});

describe("applyFilters by each field (X100)", () => {
  const kept = (field: TaskFilter["field"], values: string[], not = false) =>
    applyFilters(BOARD, [{ field, values, not }]).flatMap((v) => v.cards.map((c) => c.task.key));
  it("keeps by assignee: Me is the user's own tasks and those with a session of theirs; No assignee those with none", () => {
    expect(kept("assignee", [ME])).toEqual(["MOON-170", "MOON-158", "MOON-166", "MOON-142"]);
    expect(kept("assignee", ["Ana Costa"])).toEqual(["MOON-163", "MOON-120"]);
    expect(kept("assignee", [NONE])).toEqual(["MOON-170", "MOON-158"]);
  });
  it("keeps by priority, type, label and cycle; a task with several labels passes is when one is picked, is not when none is", () => {
    expect(kept("priority", ["3"])).toEqual(["MOON-166", "MOON-142"]);
    expect(kept("type", ["Bug"], true)).toEqual(["MOON-170", "MOON-158", "MOON-163", "MOON-120"]);
    expect(kept("labels", ["mobile", "web"])).toEqual(["MOON-142"]);
    expect(kept("labels", ["ux"], true)).toEqual(["MOON-170", "MOON-158", "MOON-166", "MOON-120"]);
    expect(kept("cycle", ["14", NONE])).toEqual(["MOON-170", "MOON-158", "MOON-163", "MOON-166", "MOON-142"]);
  });
  it("keeps by sessions and by the state of the sessions' pull requests", () => {
    expect(kept("sessions", ["needs_you"])).toEqual(["MOON-142"]);
    expect(kept("sessions", ["with"])).toEqual(["MOON-166", "MOON-142"]);
    expect(kept("sessions", [NONE])).toEqual(["MOON-170", "MOON-158", "MOON-163", "MOON-120"]);
    expect(kept("pr", ["open"])).toEqual(["MOON-142"]);
    expect(kept("pr", [NONE], true)).toEqual(["MOON-142"]);
  });
});

describe("filterFields (X100 Filter menu)", () => {
  const values = (field: string, views = BOARD) => filterFields(views).find((f) => f.field === field)?.values.map((v) => `${v.label} ${v.count}`);
  it("lists the fields in the menu's order, leaving out those no task has a value for", () => {
    expect(filterFields(BOARD).map((f) => f.label)).toEqual(["State", "Assignee", "Priority", "Type", "Labels", "Sessions", "Pull request", "Cycle"]);
    const plain = [view("Open", "todo", [card(task("#1", { connection: "github:github.com" }))])];
    expect(filterFields(plain).map((f) => f.label)).toEqual(["State", "Assignee", "Sessions", "Pull request"]);
  });
  it("lists each field's values with how many tasks have them", () => {
    expect(values("state")).toEqual(["Backlog 1", "Todo 3", "In Progress 1", "Done 1"]);
    expect(values("assignee")).toEqual(["Me 4", "Ana Costa 2", "Jonas Weber 1", "Marta Lind 1", "No assignee 2"]);
    expect(values("priority")).toEqual(["High 2", "Medium 2", "Low 2"]);
    expect(values("type")).toEqual(["Bug 2", "Feature 1"]);
    expect(values("labels")).toEqual(["mobile 1", "ux 2"]);
    expect(values("sessions")).toEqual(["Needs you 1", "With a session 2", "No session 4"]);
    expect(values("pr")).toEqual(["Open 1", "No pull request 5"]);
    expect(values("cycle")).toEqual(["Cycle 14 1", "Cycle 13 1", "No cycle 4"]);
  });
  it("keeps a column with no task, and Me with none of the user's", () => {
    const empty = [view("Todo", "todo", []), view("Done", "done", [card(task("MOON-1", { mine: false, assignees: ["Kim Park"] }))])];
    expect(values("state", empty)).toEqual(["Todo 0", "Done 1"]);
    expect(values("assignee", empty)).toEqual(["Me 0", "Kim Park 1"]);
  });
});

describe("chipOf (X100 applied filters' chips)", () => {
  it("reads is or is not for one value, is any of or is none of for several, and counts more than two", () => {
    expect(chipOf({ field: "state", values: ["Done"], not: true })).toEqual({ field: "State", op: "is not", value: "Done" });
    expect(chipOf({ field: "priority", values: ["3", "2"], not: false })).toEqual({ field: "Priority", op: "is any of", value: "High, Medium" });
    expect(chipOf({ field: "assignee", values: [ME, "Ana Costa", NONE], not: true })).toEqual({ field: "Assignee", op: "is none of", value: "3 assignees" });
    expect(chipOf({ field: "labels", values: ["ux", "mobile", "web"], not: false }).value).toBe("3 labels");
    expect(chipOf({ field: "state", values: ["Todo", "QA", "Done"], not: false }).value).toBe("3 states");
  });
});

describe("editing filters (X100)", () => {
  const state = (values: string[], not = false): TaskFilter => ({ field: "state", values, not });
  it("adds a value as a new filter at the end, or to its field's filter; taking out the last value removes the filter", () => {
    const one = toggleValue([], "state", "Done");
    expect(one).toEqual([state(["Done"])]);
    const two = toggleValue(toggleValue(one, "priority", "3"), "state", "Todo");
    expect(two).toEqual([state(["Done", "Todo"]), { field: "priority", values: ["3"], not: false }]);
    expect(toggleValue(toggleValue(two, "state", "Done"), "state", "Todo")).toEqual([{ field: "priority", values: ["3"], not: false }]);
  });
  it("flips between is and is not, and removes a filter", () => {
    expect(flipOp([state(["Done"])], "state")).toEqual([state(["Done"], true)]);
    expect(flipOp(flipOp([state(["Done"])], "state"), "state")).toEqual([state(["Done"])]);
    expect(removeFilter([state(["Done"]), { field: "type", values: ["Bug"], not: false }], "state")).toEqual([{ field: "type", values: ["Bug"], not: false }]);
  });
});

describe("Assignee's Me is the board's X50 pick (X100)", () => {
  const me: TaskFilter = { field: "assignee", values: [ME], not: false };
  const done: TaskFilter = { field: "state", values: ["Done"], not: true };
  it("shows a board at me as the chip Assignee is Me, first; at anyone, the saved filters as they are", () => {
    expect(boardFilters([done], "me")).toEqual([me, done]);
    expect(boardFilters([done, { field: "assignee", values: ["Ana Costa"], not: false }], "me")).toEqual([me, done]);
    expect(boardFilters([done], "anyone")).toEqual([done]);
  });
  it("saves Me alone as the pick at me, and anything else as anyone with the filter kept", () => {
    expect(saveFilters([me, done])).toEqual({ saved: [done], pick: "me" });
    expect(saveFilters([done])).toEqual({ saved: [done], pick: "anyone" });
    const others = { field: "assignee" as const, values: [ME, "Ana Costa"], not: false };
    expect(saveFilters([done, others])).toEqual({ saved: [done, others], pick: "anyone" });
    expect(saveFilters([{ ...me, not: true }])).toEqual({ saved: [{ ...me, not: true }], pick: "anyone" });
  });
});

describe("Display options (X100)", () => {
  it("orders each column by the board, by priority highest first, or by update newest first, ties in the board's order", () => {
    const col = [view("Todo", "todo", [card(task("A", { priority: 1, updatedMs: 30 })), card(task("B", { priority: 3, updatedMs: 10 })), card(task("C", { priority: 1, updatedMs: 20 })), card(task("D", { priority: 3, updatedMs: 40 }))])];
    expect(keys(arrange(col, { ...DEFAULT_DISPLAY, ordering: "board" }))).toEqual(["Todo: A B C D"]);
    expect(keys(arrange(col, { ...DEFAULT_DISPLAY, ordering: "priority" }))).toEqual(["Todo: B D A C"]);
    expect(keys(arrange(col, { ...DEFAULT_DISPLAY, ordering: "updated" }))).toEqual(["Todo: D A C B"]);
  });
  it("leaves out columns with no card when Show empty columns is off, folded ones too", () => {
    const left = applyFilters(BOARD, [{ field: "state", values: ["Todo", "Done"], not: false }]);
    expect(arrange(left, DEFAULT_DISPLAY).map((v) => v.name)).toEqual(["Backlog", "Todo", "In Progress", "Done"]);
    expect(arrange(left, { ...DEFAULT_DISPLAY, showEmpty: false }).map((v) => v.name)).toEqual(["Todo", "Done"]);
  });
  it("starts with the board's order, empty columns shown and sessions on cards", () => {
    expect(DEFAULT_DISPLAY).toEqual({ ordering: "board", showEmpty: true, sessions: true });
  });
  it("counts the tasks the filters leave of the board's", () => {
    expect(countLine(BOARD, applyFilters(BOARD, [{ field: "priority", values: ["3"], not: false }]))).toBe("2 of 6 tasks");
    expect(countLine(BOARD.slice(0, 1), BOARD.slice(0, 1))).toBe("1 of 1 task");
  });
});

describe("panelKey (X100 F and V)", () => {
  const key = (k: string, o: { meta?: boolean; typing?: boolean; dialog?: boolean } = {}) => panelKey({ key: k, metaKey: !!o.meta, ctrlKey: false, altKey: false }, !!o.typing, !!o.dialog);
  it("opens Filter on F and Display options on V, but not while typing, in a dialog, or with a modifier", () => {
    expect(key("f")).toBe("filter");
    expect(key("v")).toBe("display");
    expect(key("f", { typing: true })).toBeNull();
    expect(key("v", { dialog: true })).toBeNull();
    expect(key("f", { meta: true })).toBeNull();
    expect(key("g")).toBeNull();
  });
});

describe("searching the Filter menu (X100)", () => {
  it("lists the fields whose name has the text, then the values that have it, ignoring case", () => {
    const found = searchFilterMenu(filterFields(BOARD), " pr ");
    expect(found.fields.map((f) => f.label)).toEqual(["Priority"]);
    expect(found.values.map((v) => `${v.field} › ${v.value.label}`)).toEqual(["State › In Progress"]);
    expect(searchFilterMenu(filterFields(BOARD), "ana").values.map((v) => `${v.field} › ${v.value.label}`)).toEqual(["Assignee › Ana Costa"]);
    expect(searchFilterMenu(filterFields(BOARD), "").values).toEqual([]);
  });
  it("lists a field's values that have the text", () => {
    const state = filterFields(BOARD)[0];
    expect(matchingValues(state, "o").map((v) => v.label)).toEqual(["Backlog", "Todo", "In Progress", "Done"]);
    expect(matchingValues(state, "do").map((v) => v.label)).toEqual(["Todo", "Done"]);
  });
});

describe("applyFilters keeps a column's WIP to what it shows (X50, X100)", () => {
  it("counts the cards left against the limit", () => {
    const col = [{ ...view("In Progress", "in_progress", BOARD[1].cards), wip: { count: 3, max: 3, full: true } }];
    expect(applyFilters(col, [{ field: "priority", values: ["3"], not: false }])[0].wip).toEqual({ count: 1, max: 3, full: false });
  });
});
