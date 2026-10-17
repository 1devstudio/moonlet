import { describe, expect, it } from "vitest";
import { alreadyAdded, byGroup, canContinue, cardChoices, clash, columnAt, draftFromBoard, finishedChoices, jiraSprints, moveColumn, newDraft, pickOrigin, previewLine, putBoard, summaryLine, toBoard } from "./addBoard";
import type { BoardColumn, BoardConfig } from "./boards";
import type { Task } from "./tasks";

const JIRA = "jira:acme.atlassian.net";
const WEB: BoardColumn[] = [
  { name: "Backlog", statuses: ["10000"], category: "todo", show: "hide" },
  { name: "Selected for Development", statuses: ["10001"], category: "todo" },
  { name: "In Progress", statuses: ["3"], category: "in_progress", wip: 4 },
  { name: "Design Review", statuses: ["10030"], category: "in_review" },
  { name: "Done", statuses: ["10002"], category: "done", show: "fold" },
];

describe("Add a board, step 1 (X50)", () => {
  it("takes the picked board's name and the tracker's defaults", () => {
    const jira = pickOrigin(newDraft("local/acme"), JIRA, { kind: "jira_board", board: 41 }, "WEB · Website", jiraSprints("kanban"));
    expect([jira.name, jira.finished, jira.cards, jira.step]).toEqual(["WEB · Website", 14, ["issue_type", "points", "assignee"], 1]);
    // A Scrum board follows its sprint; Linear a team's cycle; GitHub shows assignees.
    expect(pickOrigin(newDraft("local/acme"), JIRA, { kind: "jira_board", board: 10 }, "OPS board", jiraSprints("scrum")).finished).toBe("sprint");
    expect(pickOrigin(newDraft("local/acme"), "linear:acme", { kind: "linear_team", team: "MOON" }, "Moonlet").cards).toEqual(["points", "assignee"]);
    expect(pickOrigin(newDraft("local/acme"), "github:github.com", { kind: "github_repo", repo: "acme/web" }, "acme/web").cards).toEqual(["assignee"]);
  });

  it("marks a board that is already one in this workspace", () => {
    const existing: BoardConfig = { id: "b", name: "OPS", connection: JIRA, workspace: "local/acme", origin: { kind: "jira_board", board: 10 } };
    expect(alreadyAdded([existing], "local/acme", JIRA, { kind: "jira_board", board: 10 })).toBe(true);
    expect(alreadyAdded([existing], "local/other", JIRA, { kind: "jira_board", board: 10 })).toBe(false);
    expect(alreadyAdded([existing], "local/acme", JIRA, { kind: "jira_board", board: 41 })).toBe(false);
  });

  it("waits for a board, a non-empty query, columns and a name", () => {
    const d = newDraft("local/acme");
    expect(canContinue(d, null)).toBe(false);
    expect(canContinue(pickOrigin(d, JIRA, { kind: "jql", query: " " }, "Query"), null)).toBe(false);
    const picked = pickOrigin(d, JIRA, { kind: "jira_board", board: 41 }, "WEB · Website", jiraSprints("kanban"));
    expect(canContinue(picked, null)).toBe(true);
    // Step 2 waits for the tracker to check the query, and while it rejects it.
    expect(canContinue({ ...picked, step: 2 }, null)).toBe(false);
    expect(canContinue({ ...picked, step: 2 }, { error: "Jira: Field 'compnent' does not exist" })).toBe(false);
    expect(canContinue({ ...picked, step: 2 }, { error: null })).toBe(true);
    expect(canContinue({ ...picked, step: 3, columns: [] }, null)).toBe(false);
    expect(canContinue({ ...picked, step: 3, columns: WEB }, null)).toBe(true);
    expect(canContinue({ ...picked, step: 4, columns: WEB, name: "" }, null)).toBe(false);
    // Board settings' Save waits while the tracker rejects an edited query.
    expect(canContinue({ ...picked, step: 4, columns: WEB }, { error: "Jira: Field 'compnent' does not exist" })).toBe(false);
  });
});

describe("Add a board, step 2 (X50)", () => {
  it("offers the sprint or cycle only where there is one", () => {
    expect(finishedChoices("jira", true).map((c) => c.label)).toEqual(["Hide after 14 days", "Follow the active sprint"]);
    expect(finishedChoices("jira", false).map((c) => c.label)).toEqual(["Hide after 14 days"]);
    // A Linear team offers its cycle only when it uses cycles, and follows it by default.
    expect(finishedChoices("linear", true).map((c) => c.label)).toEqual(["Hide after 14 days", "Follow the active cycle"]);
    expect(finishedChoices("linear").map((c) => c.label)).toEqual(["Hide after 14 days"]);
    expect(pickOrigin(newDraft("local/acme"), "linear:acme", { kind: "linear_team", team: "ENG" }, "Engineering", true).finished).toBe("sprint");
    expect(pickOrigin(newDraft("local/acme"), "linear:acme", { kind: "linear_team", team: "DES" }, "Design").finished).toBe(14);
    expect(finishedChoices("github").map((c) => c.label)).toEqual(["Hide after 14 days"]);
    // Scrum and team-managed Jira boards have sprints; Kanban and an unknown type do not.
    expect(["scrum", "simple", "kanban", "something"].map(jiraSprints)).toEqual([true, true, false, false]);
    // A team-managed board has sprints; a Jira board of unknown type gets 14 days, as its choices say.
    expect(pickOrigin(newDraft("local/acme"), JIRA, { kind: "jira_board", board: 12 }, "MOB board", jiraSprints("simple")).finished).toBe("sprint");
    expect(pickOrigin(newDraft("local/acme"), JIRA, { kind: "jira_board", board: 12 }, "MOB board").finished).toBe(14);
    // Board settings of a board following its sprint keeps the choice.
    expect(finishedChoices("jira", false, "sprint").map((c) => c.label)).toEqual(["Hide after 14 days", "Follow the active sprint"]);
  });

  it("says how many issues match, how many are the user's, and how many have a branch with their key", () => {
    const t = (key: string, mine: boolean): Task => ({ connection: JIRA, key, title: key, url: "", column: "todo", priority: 0, assignees: [], labels: [], description: "", updatedMs: 0, mine });
    const issues = [t("WEB-233", true), t("WEB-241", false), t("WEB-245", true)];
    expect(previewLine(issues, ["web-233-pricing", "main", "feat/web-245_focus"], JIRA)).toBe("3 issues match · 2 assigned to you · 2 already have a branch with their key");
    expect(previewLine([t("MOON-1", false)], [], "linear:acme")).toBe("1 issue matches · 0 assigned to you · none has a branch with its key");
  });
});

describe("Add a board, step 4 (X50)", () => {
  const draft = { ...pickOrigin(newDraft("local/acme"), JIRA, { kind: "jira_board", board: 41 }, "WEB · Website", jiraSprints("kanban")), columns: WEB, step: 4 as const };

  it("sums the board up as the summary card does", () => {
    expect(summaryLine(draft, 17, "Acme")).toBe("Jira board 41 · 3 columns shown, 1 folded, 1 hidden · 17 issues · Acme");
  });

  it("makes the board, leaving out what is at its default", () => {
    const board = toBoard({ ...draft, narrow: "component in (frontend, design-system)", assignee: "anyone", rules: [{ when: "default", project: "website" }], pinned: true });
    expect(board).toEqual({
      id: "jira:acme.atlassian.net/41@local/acme",
      name: "WEB · Website",
      connection: JIRA,
      workspace: "local/acme",
      origin: { kind: "jira_board", board: 41 },
      narrow: "component in (frontend, design-system)",
      assignee: "anyone",
      columns: WEB,
      rules: [{ when: "default", project: "website" }],
    });
    // Cards at the tracker's fields are left out; none at all is a choice of its own.
    expect(toBoard({ ...draft, cards: [] }).cards).toEqual([]);
    expect(toBoard({ ...draft, cards: ["due"] }).cards).toEqual(["due"]);
    expect(toBoard({ ...draft, finished: "sprint", pinned: false })).toMatchObject({ finished: "sprint", pinned: false });
  });
});

describe("Add a board, step 3 (X50)", () => {
  it("moves a column up or down, and sets its category and how it shows", () => {
    expect(moveColumn(WEB, 2, -1).map((c) => c.name)).toEqual(["Backlog", "In Progress", "Selected for Development", "Design Review", "Done"]);
    expect(moveColumn(WEB, 4, 1)).toEqual(WEB);
    expect(columnAt(WEB, 3, { category: "in_progress" })[3]).toEqual({ name: "Design Review", statuses: ["10030"], category: "in_progress" });
    expect(columnAt(WEB, 4, { show: "show" })[4]).toEqual({ name: "Done", statuses: ["10002"], category: "done" });
    expect(columnAt(WEB, 1, { show: "fold" })[1]).toEqual({ name: "Selected for Development", statuses: ["10001"], category: "todo", show: "fold" });
  });
});

describe("Add a board, step 4 cards (X50)", () => {
  it("offers only the card fields the tracker has", () => {
    expect(cardChoices("jira").map(([, label]) => label)).toEqual(["Issue type", "Story points", "Assignee", "Epic", "Due date"]);
    expect(cardChoices("linear").map(([, label]) => label)).toEqual(["Estimate", "Assignee", "Parent", "Due date"]);
    expect(cardChoices("github").map(([, label]) => label)).toEqual(["Assignee"]);
  });
});

describe("Saving a board (X50)", () => {
  const ops: BoardConfig = { id: "jira:acme.atlassian.net/10@local/acme", name: "OPS", connection: JIRA, workspace: "local/acme", origin: { kind: "jira_board", board: 10 } };
  const web: BoardConfig = { id: "jira:acme.atlassian.net/41@local/acme", name: "WEB", connection: JIRA, workspace: "local/acme", origin: { kind: "jira_board", board: 41 } };

  it("refuses a board its workspace already has, even moved there in Board settings", () => {
    expect(clash([ops, web], { ...web, name: "WEB again" })).toBe("This workspace already has a board from Jira board 41.");
    expect(clash([ops, web], { ...web, id: "jira:acme.atlassian.net/41@local/other", workspace: "local/other" })).toBe(null);
    // Board settings may save the board over itself, not over another.
    expect(clash([ops, web], { ...web, name: "Website" }, web.id)).toBe(null);
    expect(clash([ops, web], { ...ops, origin: web.origin, id: web.id }, ops.id)).toBe("This workspace already has a board from Jira board 41.");
  });

  it("adds a new board last, and puts a board saved from its settings where it was, under its new id", () => {
    const fresh: BoardConfig = { id: "jql:x@local/acme", name: "Query", connection: JIRA, workspace: "local/acme", origin: { kind: "jql", query: "project = X" } };
    expect(putBoard([ops, web], fresh).map((b) => b.id)).toEqual([ops.id, web.id, fresh.id]);
    const moved = { ...ops, id: "jira:acme.atlassian.net/10@local/other", workspace: "local/other" };
    expect(putBoard([ops, web], moved, ops.id).map((b) => b.id)).toEqual(["jira:acme.atlassian.net/10@local/other", web.id]);
  });
});

describe("Board settings (X50)", () => {
  it("opens the board's own values, and saves it back as it was", () => {
    const board: BoardConfig = {
      id: "jira:acme.atlassian.net/41@local/acme",
      name: "WEB · Website",
      connection: JIRA,
      workspace: "local/acme",
      origin: { kind: "jira_board", board: 41 },
      narrow: "component = frontend",
      finished: "sprint",
      columns: WEB,
      cards: ["points"],
      pinned: false,
      // A board made from an X44 source keeps its state mapping.
      states: { QA: "in_review" },
    };
    const d = draftFromBoard(board);
    expect([d.step, d.name, d.narrow, d.assignee, d.finished, d.cards, d.pinned]).toEqual([1, "WEB · Website", "component = frontend", "me", "sprint", ["points"], false]);
    expect(toBoard(d)).toEqual(board);
    // A board that never picked shows its tracker's fields, ticked as such.
    const { cards: _, ...unpicked } = board;
    expect(draftFromBoard(unpicked).cards).toEqual(["issue_type", "points", "assignee"]);
    expect(toBoard(draftFromBoard(unpicked)).cards).toBe(undefined);
  });
});

describe("Add a board, step 1 groups (X50 ClickUp)", () => {
  it("groups a connection's lists by space and folder, in the order they came", () => {
    const rows = [
      { key: "901", name: "Q4", group: "Engineering › Roadmap" },
      { key: "902", name: "Bugs", group: "Engineering" },
      { key: "903", name: "Q1", group: "Engineering › Roadmap" },
      { key: "904", name: "Launch", group: "Marketing" },
    ];
    expect(byGroup(rows).map((g) => [g.group, g.rows.map((r) => r.key)])).toEqual([
      ["Engineering › Roadmap", ["901", "903"]],
      ["Engineering", ["902"]],
      ["Marketing", ["904"]],
    ]);
    // Linear's teams and Jira's boards come as one group with no name.
    expect(byGroup<{ key: string; group?: string }>([{ key: "ENG" }, { key: "DES" }]).map((g) => [g.group, g.rows.length])).toEqual([[null, 2]]);
  });
});
