import { describe, expect, it, vi } from "vitest";
import { canSplit, groupsStatuses, groupStatus, splitStatus, pausedPreview, alreadyAdded, byGroup, canContinue, cardChoices, projectChoice, projectOwners, scopeNeeded, changedCategories, clash, columnAt, dropColumn, jiraFilterUrl, statusNames, statusText, suggestedOf, draftFromBoard, finishedChoices, jiraSprints, moveColumn, newDraft, pickOrigin, previewLine, putBoard, summaryLine, toBoard } from "./addBoard";
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

  it("offers a GitHub Project's number field as the estimate, under its own name", () => {
    expect(cardChoices("github", "Hours")).toEqual([
      ["points", "Hours"],
      ["assignee", "Assignee"],
    ]);
    expect(cardChoices("github", null)).toEqual([["assignee", "Assignee"]]);
    // A board that shows it keeps the box while the field's name is not known, or once the field is gone, so it can be unticked.
    expect(cardChoices("github", null, ["points", "assignee"])).toEqual([
      ["points", "Estimate"],
      ["assignee", "Assignee"],
    ]);
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

describe("Add a board, step 3 polish (X50)", () => {
  it("drops a dragged column where it lands", () => {
    expect(dropColumn(WEB, 4, 1).map((c) => c.name)).toEqual(["Backlog", "Done", "Selected for Development", "In Progress", "Design Review"]);
    expect(dropColumn(WEB, 0, 3).map((c) => c.name)).toEqual(["Selected for Development", "In Progress", "Design Review", "Backlog", "Done"]);
    expect(dropColumn(WEB, 2, 2)).toEqual(WEB);
  });

  it("names the columns whose category differs from the one suggested", () => {
    const suggested = { "Design Review": "in_review", Done: "done" } as const;
    expect(changedCategories(columnAt(WEB, 3, { category: "in_progress" }), suggested)).toEqual(["Design Review"]);
    expect(changedCategories(WEB, suggested)).toEqual([]);
  });

  it("takes the columns' categories as suggested when they first come, and again for a new source", () => {
    const first = suggestedOf({}, WEB);
    expect(first).toEqual({ Backlog: "todo", "Selected for Development": "todo", "In Progress": "in_progress", "Design Review": "in_review", Done: "done" });
    // A change keeps the first suggestion; Board settings start from the board's columns as saved.
    expect(suggestedOf(first, columnAt(WEB, 3, { category: "in_progress" }))).toBe(first);
    // A new source clears the columns, and its own come as suggested.
    expect(suggestedOf(first, [])).toEqual({});
  });

  it("links a Jira board's filter for editing in Jira", () => {
    expect(jiraFilterUrl("acme.atlassian.net", "10021")).toBe("https://acme.atlassian.net/issues/?filter=10021");
  });
});

describe("Add a board, step 3 statuses (X50)", () => {
  it("lists a column's statuses by name: Jira's board setup, else the previewed issues, else the site's statuses, else the id", () => {
    const issue = (statusId: string, state: string): Task => ({ connection: JIRA, key: "EX-1", title: "", url: "", column: "todo", priority: 0, assignees: [], labels: [], description: "", updatedMs: 0, tracker: { id: "1", state, statusId, source: "EX" } });
    const names = statusNames({ setup: { "10002": "Done" }, issues: [issue("3", "In Progress"), issue("10001", "Selected for Development")] });
    expect(names).toEqual({ "10002": "Done", "3": "In Progress", "10001": "Selected for Development" });
    // The board's setup wins over an issue's; names already seen stay while the next preview loads.
    expect(statusNames({ setup: { "3": "In Progress" }, issues: [issue("3", "Doing")], known: { "6": "Closed" } })).toEqual({ "3": "In Progress", "6": "Closed" });
    expect(statusNames({ known: { "6": "Closed" } })).toEqual({ "6": "Closed" });
    // A JQL board's status that no issue is in today takes the site's name.
    expect(statusNames({ issues: [issue("3", "In Progress")], site: { "3": "Doing", "10030": "Acceptance Testing" } })).toEqual({ "3": "In Progress", "10030": "Acceptance Testing" });
    expect(WEB.map((c) => statusText(c, names))).toEqual(["10000", "Selected for Development", "In Progress", "10030", "Done"]);
    expect(statusText({ name: "Empty", statuses: [], category: "todo" }, names)).toBe("no status");
    // Linear and ClickUp columns list their states by name already.
    expect(statusText({ name: "Todo", statuses: ["Todo", "Backlog"], category: "todo" }, {})).toBe("Todo · Backlog");
  });
});

describe("Add a board, GitHub Projects (X50)", () => {
  it("knows when gh lacks a scope, from the daemon's message, and which", () => {
    expect(scopeNeeded("gh.projects: GitHub Projects need gh's read:project scope. Run gh auth refresh -s read:project, then Check again.")).toBe("read:project");
    expect(scopeNeeded("Moving a Project's items needs gh's project scope. Run gh auth refresh -s project.")).toBe("project");
    expect(scopeNeeded("gh api graphql: could not connect")).toBe(null);
  });

  it("lists a Project under its owner, with its Status options counted as columns", () => {
    const project = { id: "PVT_1", owner: "acme", number: 2, title: "Website", status_field: "F", options: [{ id: "a", name: "Todo" }, { id: "b", name: "In Progress" }, { id: "c", name: "Done" }] };
    expect(projectChoice(project)).toEqual({ key: "#2", name: "Website", kind: "3 columns", group: "acme", origin: { kind: "github_project", owner: "acme", number: 2 } });
  });
});

describe("Add a board, whose GitHub Projects to list (X50)", () => {
  it("asks about the owners of the workspace's repositories, each once", () => {
    expect(projectOwners(["acme/web", "acme/api", "Sam-Rivera/notes", null])).toEqual(["acme", "Sam-Rivera"]);
    expect(projectOwners([])).toEqual([]);
  });
});

describe("the preview's pause (X50 step 2)", () => {
  it("asks the tracker a moment after the last change, and shows only the latest change's answer", async () => {
    vi.useFakeTimers();
    try {
      const asked: string[] = [];
      const shown: string[] = [];
      const preview = pausedPreview<string>((answer) => shown.push(answer));
      const ask = (query: string, ms = 0) => () => (asked.push(query), ms ? new Promise<string>((r) => setTimeout(() => r(`${query} matches`), ms)) : Promise.resolve(`${query} matches`));
      // Typing "project = EX" asks once, half a second after the last key.
      preview.change(ask("project = E"));
      await vi.advanceTimersByTimeAsync(300);
      preview.change(ask("project = EX"));
      await vi.advanceTimersByTimeAsync(499);
      expect([asked, shown]).toEqual([[], []]);
      await vi.advanceTimersByTimeAsync(1);
      expect([asked, shown]).toEqual([["project = EX"], ["project = EX matches"]]);
      // A slow answer to an earlier query is not shown once the user changed it.
      preview.change(ask("project = OPS", 2_000));
      await vi.advanceTimersByTimeAsync(500);
      preview.change(ask("project = WEB"));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(shown).toEqual(["project = EX matches", "project = WEB matches"]);
      // Leaving the step asks nothing more, and drops an answer still to come.
      preview.change(ask("project = MOON"));
      preview.stop();
      preview.change(ask("project = DES", 2_000));
      await vi.advanceTimersByTimeAsync(500);
      preview.stop();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(asked).toEqual(["project = EX", "project = OPS", "project = WEB", "project = DES"]);
      expect(shown).toEqual(["project = EX matches", "project = WEB matches"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("grouping a JQL board's statuses (X50 step 3)", () => {
  const open: BoardColumn = { name: "Open", statuses: ["1"], category: "todo" };
  const progress: BoardColumn = { name: "In Progress", statuses: ["3"], category: "in_progress" };
  const review: BoardColumn = { name: "Needs Reviews", statuses: ["10018"], category: "in_review", show: "fold" };

  it("moves a status dragged onto another column into it, and drops the column it leaves empty", () => {
    expect(groupStatus([open, progress, review], "10018", 1, {})).toEqual([open, { name: "In Progress", statuses: ["3", "10018"], category: "in_progress" }]);
    // Onto its own column, nothing changes.
    expect(groupStatus([open, progress], "1", 0, {})).toEqual([open, progress]);
    // A column that keeps other statuses stays.
    expect(groupStatus([{ ...open, statuses: ["1", "10000"] }, progress], "10000", 1, {})).toEqual([open, { ...progress, statuses: ["3", "10000"] }]);
  });

  it("gives a grouped status its own column again, beside the one it leaves, in the category suggested for it", () => {
    const names = { "1": "Open", "10000": "To Do", "10097": "Done", "6": "Closed", "3": "In Progress" };
    // To Do, grouped into In Progress, comes back as To do.
    expect(splitStatus([open, { ...progress, statuses: ["3", "10000"] }], "10000", names, { "To Do": "todo" })).toEqual([open, progress, { name: "To Do", statuses: ["10000"], category: "todo" }]);
    // Without a suggestion it keeps the category of the column it leaves.
    expect(splitStatus([{ ...open, statuses: ["1", "10000"] }], "10000", names)).toEqual([open, { name: "To Do", statuses: ["10000"], category: "todo" }]);
    // Taking the status the column is named after: it keeps that name, and the rest takes its first status's.
    const done: BoardColumn = { name: "Done", statuses: ["10097", "6"], category: "done", show: "fold" };
    expect(splitStatus([done], "10097", names)).toEqual([
      { name: "Done", statuses: ["10097"], category: "done", show: "fold" },
      { name: "Closed", statuses: ["6"], category: "done", show: "fold" },
    ]);
  });

  it("splits a status only when its column gets the tracker's own name, unique on the board", () => {
    const names = { "1": "Open", "10000": "To Do", "3": "To Do", "10097": "Done", "6": "Done" };
    const grouped = { ...open, statuses: ["1", "10000"] };
    expect(canSplit([grouped, progress], "10000", names)).toBe(true);
    // Another column is named To Do already; two statuses of one name; a name not read yet; a status alone in its column.
    expect(canSplit([grouped, { name: "To Do", statuses: ["3"], category: "todo" }], "10000", names)).toBe(false);
    expect(canSplit([{ name: "Done", statuses: ["10097", "6"], category: "done" }], "10097", names)).toBe(false);
    expect(canSplit([grouped], "10000", { "1": "Open" })).toBe(false);
    expect(canSplit([open], "1", names)).toBe(false);
    expect(splitStatus([grouped, { name: "To Do", statuses: ["3"], category: "todo" }], "10000", names)).toEqual([grouped, { name: "To Do", statuses: ["3"], category: "todo" }]);
  });

  it("names the column a status leaves after its next status, when it was named after the one that left", () => {
    const names = { "10097": "Done", "6": "Closed", "3": "In Progress" };
    const done: BoardColumn = { name: "Done", statuses: ["10097", "6"], category: "done" };
    expect(groupStatus([progress, done], "10097", 0, names)).toEqual([{ ...progress, statuses: ["3", "10097"] }, { name: "Closed", statuses: ["6"], category: "done" }]);
  });

  it("groups only a JQL board's statuses: a tracker's own columns come back on each sync as the tracker has them", () => {
    expect(groupsStatuses({ kind: "jql", query: "project = EX" })).toBe(true);
    expect([groupsStatuses({ kind: "jira_board", board: 10 }), groupsStatuses({ kind: "linear_team", team: "MOON" }), groupsStatuses(null)]).toEqual([false, false, false]);
  });
});
