import { describe, expect, it } from "vitest";
import { assigneeOf, type BoardColumn, type BoardConfig, boardRows, byDefaultHint, projectMove, projectMoveLock, footerTracker, linkedProjects, localDay, pickAssignee, withPinned, syncedColumns, withColumnShow, firstColumns, withStates, rowsToBoards, GITHUB_REPO_COLUMNS, matchColumns, addRepoBoards, migrateSources, startProjects, taskFromBoardIssue, workspaceBoards } from "./boards";
import type { Task } from "./tasks";
import { DEFAULT_CONFIG, type TrackersConfig } from "./tasksStore";

describe("migrateSources (X50 Boards replace sources)", () => {
  const config: TrackersConfig = {
    ...DEFAULT_CONFIG,
    connections: [
      {
        id: "jira:acme.atlassian.net",
        kind: "jira",
        site: "acme.atlassian.net",
        account: "Sam",
        auth: "token",
        sources: [
          { key: "OPS", name: "Operations", workspace: "local/acme" },
          { key: "PLAT", name: "Platform", workspace: "local/other" },
        ],
        states: { QA: "in_review", Backlog: "hidden" },
      },
      {
        id: "linear:1devstudio",
        kind: "linear",
        site: "1devstudio",
        account: "Sam",
        auth: "api_key",
        sources: [{ key: "MOON", name: "Moonlet", workspace: "local/acme" }],
      },
    ],
  };

  it("turns every workspace's sources into pinned boards as soon as the file loads, keeping each connection's state mapping", () => {
    const after = migrateSources(config);
    expect(after.boards).toEqual([
      {
        id: "jira:acme.atlassian.net/OPS@local/acme",
        name: "Operations",
        connection: "jira:acme.atlassian.net",
        workspace: "local/acme",
        origin: { kind: "jql", query: "project = OPS" },
        states: { QA: "in_review", Backlog: "hidden" },
      },
      {
        id: "jira:acme.atlassian.net/PLAT@local/other",
        name: "Platform",
        connection: "jira:acme.atlassian.net",
        workspace: "local/other",
        origin: { kind: "jql", query: "project = PLAT" },
        states: { QA: "in_review", Backlog: "hidden" },
      },
      {
        id: "linear:1devstudio/MOON@local/acme",
        name: "Moonlet",
        connection: "linear:1devstudio",
        workspace: "local/acme",
        origin: { kind: "linear_team", team: "MOON" },
      },
    ]);
    expect(after.connections?.map((c) => [c.id, c.sources, c.states])).toEqual([
      ["jira:acme.atlassian.net", [], undefined],
      ["linear:1devstudio", [], undefined],
    ]);
  });

  it("drops a source no workspace was chosen for, skips one that already has its board, and leaves a file without sources as it is", () => {
    const odd: TrackersConfig = {
      ...DEFAULT_CONFIG,
      boards: [{ id: "linear:1devstudio/MOON@local/acme", name: "Moonlet", connection: "linear:1devstudio", workspace: "local/acme", origin: { kind: "linear_team", team: "MOON" }, pinned: false }],
      connections: [
        {
          id: "linear:1devstudio",
          kind: "linear",
          site: "1devstudio",
          account: "Sam",
          auth: "api_key",
          sources: [
            { key: "MOON", name: "Moonlet", workspace: "local/acme" },
            { key: "DES", name: "Design", workspace: "" },
          ],
        },
      ],
    };
    const after = migrateSources(odd);
    expect(after.boards).toEqual(odd.boards);
    expect(after.connections?.[0].sources).toEqual([]);
    expect(migrateSources(after)).toBe(after);
  });

  it("makes a ClickUp list a list board", () => {
    const clickup: TrackersConfig = {
      ...DEFAULT_CONFIG,
      connections: [{ id: "clickup:9012", kind: "clickup", site: "9012", account: "Sam", auth: "token", sources: [{ key: "901", name: "Sprint", workspace: "local/acme" }] }],
    };
    expect(migrateSources(clickup).boards?.map((b) => b.origin)).toEqual([{ kind: "clickup_list", list: "901" }]);
  });
});

describe("addRepoBoards (X50 a workspace's GitHub repositories)", () => {
  it("gives each repository of a workspace's projects its board once, whatever its case", () => {
    const after = addRepoBoards(DEFAULT_CONFIG, "local/acme", ["acme/storefront", "Acme/Storefront"]);
    expect(after.boards).toEqual([
      { id: "github:github.com/acme/storefront@local/acme", name: "acme/storefront", connection: "github:github.com", workspace: "local/acme", origin: { kind: "github_repo", repo: "acme/storefront" } },
    ]);
    expect(after.migrated).toEqual(["local/acme github:github.com/acme/storefront"]);
  });

  it("keeps a board removed later removed", () => {
    const after = addRepoBoards(DEFAULT_CONFIG, "local/acme", ["acme/storefront"]);
    expect(addRepoBoards({ ...after, boards: [] }, "local/acme", ["acme/storefront"]).boards).toEqual([]);
  });

  it("gives a repository seen on a later sync its board then (a host offline, a remote added later)", () => {
    const first = addRepoBoards(DEFAULT_CONFIG, "local/acme", []);
    expect(first).toBe(DEFAULT_CONFIG);
    const later = addRepoBoards(first, "local/acme", ["acme/web"]);
    expect(later.boards?.map((b) => b.id)).toEqual(["github:github.com/acme/web@local/acme"]);
    expect(addRepoBoards(later, "local/acme", ["acme/web"])).toBe(later);
  });
});

describe("startProjects (X50 New sessions from this board start in)", () => {
  // The "Add a board" design's rules.
  const rules = [
    { when: "default" as const, project: "website" },
    { when: { component: "design-system" }, project: "ui-kit" },
    { when: { label: "docs" }, project: "handbook" },
  ];
  const task = (components: string[], labels: string[]): Task => ({
    connection: "jira:acme.atlassian.net",
    key: "WEB-233",
    title: "New pricing page layout",
    url: "",
    column: "todo",
    priority: 0,
    assignees: [],
    labels,
    components,
    description: "",
    updatedMs: 0,
  });

  it("takes the first matching component or label rule, then the board's default, then the projects linking the tracker project", () => {
    expect(startProjects(rules, task(["design-system"], ["docs"]), ["linked"])).toEqual(["ui-kit"]);
    expect(startProjects(rules, task([], ["docs"]), ["linked"])).toEqual(["handbook"]);
    expect(startProjects(rules, task(["frontend"], []), ["linked"])).toEqual(["website"]);
    expect(startProjects([], task(["frontend"], []), ["linked"])).toEqual(["linked"]);
    // Several rules for the same match (a By default row of two projects): all of them.
    expect(startProjects([...rules, { when: "default", project: "docs-site" }, { when: { label: "docs" }, project: "guides" }], task([], ["docs"]), [])).toEqual(["handbook", "guides"]);
    expect(startProjects([...rules, { when: "default", project: "docs-site" }], task([], []), [])).toEqual(["website", "docs-site"]);
    expect(startProjects(undefined, task([], []), [])).toEqual([]);
  });
});

describe("taskFromBoardIssue (X50 a Jira board's issues)", () => {
  it("keeps the status id with the tracker's state, and the card's fields", () => {
    // As `tracker_board_tasks` sends OPS-487 of jira-board-search.json.
    const issue = JSON.parse(
      '{"connection":"jira:acme.atlassian.net","key":"OPS-487","title":"Split the billing worker into two queues","url":"https://acme.atlassian.net/browse/OPS-487","column":"in_review","priority":1,"assignees":["Sam Rivera"],"labels":["billing","refined"],"description":"","updatedMs":1792168918885,"issueType":"Story","tracker":{"id":"149613","state":"Needs Reviews","source":"OPS"},"statusId":"10018","components":["billing"],"points":5.0,"parent":{"key":"OPS-480","title":"Billing reliability"}}',
    );
    expect(taskFromBoardIssue(issue)).toEqual({
      connection: "jira:acme.atlassian.net",
      key: "OPS-487",
      title: "Split the billing worker into two queues",
      url: "https://acme.atlassian.net/browse/OPS-487",
      column: "in_review",
      priority: 1,
      assignees: ["Sam Rivera"],
      labels: ["billing", "refined"],
      description: "",
      updatedMs: 1792168918885,
      issueType: "Story",
      tracker: { id: "149613", state: "Needs Reviews", source: "OPS", statusId: "10018" },
      components: ["billing"],
      points: 5,
      parent: { key: "OPS-480", title: "Billing reliability" },
    });
  });
});

describe("matchColumns (X50 a board's columns on each sync)", () => {
  it("puts a column new in the tracker where the tracker has it, before the next column the board already had", () => {
    const saved: BoardColumn[] = [
      { name: "Todo", statuses: ["Todo"], category: "todo" },
      { name: "Done", statuses: ["Done"], category: "done", show: "fold" },
    ];
    const fresh: BoardColumn[] = [
      { name: "No Status", statuses: [""], category: "todo" },
      { name: "Todo", statuses: ["Todo"], category: "todo" },
      { name: "Review", statuses: ["Review"], category: "in_review" },
      { name: "Done", statuses: ["Done"], category: "done", show: "fold" },
    ];
    expect(matchColumns(saved, fresh).map((c) => c.name)).toEqual(["No Status", "Todo", "Review", "Done"]);
  });

  it("keeps the user's order, folding and categories, takes Jira's names and statuses, adds new columns and drops removed ones", () => {
    const saved: BoardColumn[] = [
      { name: "To Do", statuses: ["10000"], category: "todo" },
      // Folded and moved before In Progress by the user.
      { name: "Code Review", statuses: ["10018"], category: "in_review", show: "fold" },
      { name: "In Progress", statuses: ["3"], category: "in_progress" },
      { name: "Old", statuses: ["999"], category: "todo" },
    ];
    const fresh: BoardColumn[] = [
      { name: "To Do", statuses: ["10000"], category: "todo" },
      { name: "Doing", statuses: ["3", "10012"], category: "in_progress", wip: 4 },
      { name: "Code Review", statuses: ["10018"], category: "in_review" },
      { name: "QA", statuses: ["5"], category: "in_review" },
      { name: "Done", statuses: ["10097"], category: "done", show: "fold" },
    ];
    expect(matchColumns(saved, fresh)).toEqual([
      { name: "To Do", statuses: ["10000"], category: "todo" },
      { name: "Code Review", statuses: ["10018"], category: "in_review", show: "fold" },
      { name: "Doing", statuses: ["3", "10012"], category: "in_progress", wip: 4 },
      { name: "QA", statuses: ["5"], category: "in_review" },
      { name: "Done", statuses: ["10097"], category: "done", show: "fold" },
    ]);
  });

  it("takes the tracker's columns as they are for a board that has none yet", () => {
    const fresh: BoardColumn[] = [{ name: "Todo", statuses: ["s1"], category: "todo" }];
    expect(matchColumns(undefined, fresh)).toEqual(fresh);
  });
});

describe("firstColumns (X50 a migrated board's first columns)", () => {
  it("gives the tracker's states the categories the old state mapping gave them, and hides those not shown", () => {
    const fresh: BoardColumn[] = [
      { name: "Backlog", statuses: ["Backlog"], category: "todo", show: "hide" },
      { name: "Todo", statuses: ["Todo"], category: "todo" },
      { name: "QA", statuses: ["QA"], category: "in_progress" },
      { name: "Done", statuses: ["Done"], category: "done", show: "fold" },
    ];
    expect(firstColumns(fresh, { QA: "in_review", Backlog: "todo", Todo: "hidden" })).toEqual([
      { name: "Backlog", statuses: ["Backlog"], category: "todo" },
      { name: "Todo", statuses: ["Todo"], category: "todo", show: "hide" },
      { name: "QA", statuses: ["QA"], category: "in_review" },
      { name: "Done", statuses: ["Done"], category: "done", show: "fold" },
    ]);
    expect(firstColumns(fresh, undefined)).toEqual(fresh);
  });
});

describe("GITHUB_REPO_COLUMNS (X50 a GitHub repository board)", () => {
  it("is GitHub's Open and Closed, Closed holding both close reasons and folded", () => {
    expect(GITHUB_REPO_COLUMNS).toEqual([
      { name: "Open", statuses: ["open"], category: "todo" },
      { name: "Closed", statuses: ["completed", "not_planned"], category: "done", show: "fold" },
    ]);
  });
});

describe("workspaceBoards (X50 Sync)", () => {
  const b = (id: string, workspace: string, pinned?: false): BoardConfig => ({ id, name: id, connection: "linear:acme", workspace, origin: { kind: "linear_team", team: id }, ...(pinned === false ? { pinned } : {}) });
  it("syncs the workspace's pinned boards and the one shown", () => {
    const boards = [b("a", "local/w"), b("b", "local/w", false), b("c", "local/other"), b("d", "local/w", false)];
    expect(workspaceBoards(boards, "local/w", "d").map((x) => x.id)).toEqual(["a", "d"]);
    expect(workspaceBoards(boards, "local/w", null).map((x) => x.id)).toEqual(["a"]);
  });
});

describe("the Sources dialog edits boards (X50, until Add a board)", () => {
  const conn = { id: "jira:acme.atlassian.net", kind: "jira" as const, site: "acme.atlassian.net", account: "Sam", auth: "token", sources: [] };
  const ops: BoardConfig = {
    id: "jira:acme.atlassian.net/OPS@local/acme",
    name: "Operations",
    connection: conn.id,
    workspace: "local/acme",
    origin: { kind: "jql", query: "project = OPS" },
    columns: [{ name: "To Do", statuses: ["10000"], category: "todo" }],
  };
  const other: BoardConfig = { ...ops, id: "linear:acme/MOON@local/acme", connection: "linear:acme", origin: { kind: "linear_team", team: "MOON" } };

  it("lists the connection's boards as rows", () => {
    expect(boardRows(conn, [ops, other])).toEqual([{ key: "OPS", name: "Operations", workspace: "local/acme" }]);
    expect(boardRows(conn, [other])).toEqual([{ key: "", name: "", workspace: "" }]);
  });

  it("keeps a board whose row stays, adds one per new row and removes those whose row went", () => {
    const rows = [
      { key: "OPS", name: "Operations", workspace: "local/acme" },
      { key: "PLAT", name: "Platform", workspace: "local/acme" },
      { key: "", name: "", workspace: "local/acme" },
    ];
    expect(rowsToBoards(conn, rows, [ops, other])).toEqual([
      ops,
      other,
      { id: "jira:acme.atlassian.net/PLAT@local/acme", name: "Platform", connection: conn.id, workspace: "local/acme", origin: { kind: "jql", query: "project = PLAT" } },
    ]);
    expect(rowsToBoards(conn, [], [ops, other])).toEqual([other]);
  });
});

describe("withStates (X44 States dialog on a board, X50)", () => {
  const board: BoardConfig = { id: "moon", name: "Moonlet", connection: "linear:acme", workspace: "local/w", origin: { kind: "linear_team", team: "MOON" } };
  it("keeps the mapping for the board's first columns, and applies it to columns it already has", () => {
    expect(withStates(board, { Backlog: "todo" })).toEqual({ ...board, states: { Backlog: "todo" } });
    const columns: BoardColumn[] = [
      { name: "Backlog", statuses: ["Backlog"], category: "todo", show: "hide" },
      { name: "QA", statuses: ["QA"], category: "in_progress" },
    ];
    expect(withStates({ ...board, columns }, { Backlog: "todo", QA: "in_review" })).toEqual({
      ...board,
      states: { Backlog: "todo", QA: "in_review" },
      columns: [
        { name: "Backlog", statuses: ["Backlog"], category: "todo" },
        { name: "QA", statuses: ["QA"], category: "in_review" },
      ],
    });
  });
});

describe("syncedColumns (X50 a board's columns after a sync)", () => {
  const base = { id: "b", name: "b", connection: "jira:acme.atlassian.net", workspace: "local/w" };
  const todo: BoardColumn = { name: "To Do", statuses: ["10000"], category: "todo" };
  const review: BoardColumn = { name: "Needs Reviews", statuses: ["10018"], category: "in_review", show: "fold" };
  it("moves a Project board saved with option names onto option ids, keeping the user's order, folding and categories", () => {
    const board: BoardConfig = {
      ...base,
      connection: "github:github.com",
      origin: { kind: "github_project", owner: "acme", number: 2 },
      columns: [
        { name: "No Status", statuses: [""], category: "todo", show: "hide" },
        { name: "In Progress", statuses: ["In Progress"], category: "in_review" },
        { name: "Todo", statuses: ["Todo"], category: "todo" },
        { name: "Done", statuses: ["Done"], category: "done" },
      ],
    };
    const fresh: BoardColumn[] = [
      { name: "No Status", statuses: [""], category: "todo" },
      { name: "Todo", statuses: ["o1"], category: "todo" },
      { name: "In Progress", statuses: ["o2"], category: "in_progress" },
      { name: "Done", statuses: ["o3"], category: "done", show: "fold" },
    ];
    expect(syncedColumns(board, fresh)).toEqual([
      { name: "No Status", statuses: [""], category: "todo", show: "hide" },
      { name: "In Progress", statuses: ["o2"], category: "in_review" },
      { name: "Todo", statuses: ["o1"], category: "todo" },
      { name: "Done", statuses: ["o3"], category: "done" },
    ]);
  });

  it("keeps a Project column whose option was renamed in GitHub, under the new name, with the user's folding and category", () => {
    const board: BoardConfig = { ...base, connection: "github:github.com", origin: { kind: "github_project", owner: "acme", number: 2 }, columns: [{ name: "Todo", statuses: ["o1"], category: "in_progress", show: "fold" }] };
    expect(syncedColumns(board, [{ name: "To do", statuses: ["o1"], category: "todo" }])).toEqual([{ name: "To do", statuses: ["o1"], category: "in_progress", show: "fold" }]);
  });

  it("moves a team's own No Status option onto its id, not onto the column of items with no Status", () => {
    const board: BoardConfig = {
      ...base,
      connection: "github:github.com",
      origin: { kind: "github_project", owner: "acme", number: 2 },
      columns: [
        { name: "No Status", statuses: [""], category: "todo" },
        { name: "No Status", statuses: ["No Status"], category: "in_progress", show: "fold" },
      ],
    };
    const fresh: BoardColumn[] = [
      { name: "No Status", statuses: [""], category: "todo" },
      { name: "No Status", statuses: ["o4"], category: "todo" },
    ];
    expect(syncedColumns(board, fresh)).toEqual([
      { name: "No Status", statuses: [""], category: "todo" },
      { name: "No Status", statuses: ["o4"], category: "in_progress", show: "fold" },
    ]);
  });

  it("only adds columns to a JQL board, since its columns come from the statuses its issues happen to be in", () => {
    const board: BoardConfig = { ...base, origin: { kind: "jql", query: "project = OPS" }, columns: [todo, review] };
    // No issue is in review today: the folded column stays.
    expect(syncedColumns(board, [{ name: "To Do", statuses: ["10000"], category: "todo" }, { name: "QA", statuses: ["5"], category: "in_review" }])).toEqual([
      todo,
      review,
      { name: "QA", statuses: ["5"], category: "in_review" },
    ]);
  });

  it("keeps a JQL board's grouped statuses together on each sync, and gives a status seen later a column of its own", () => {
    const grouped: BoardColumn = { name: "In Progress", statuses: ["3", "10000"], category: "in_progress" };
    const board: BoardConfig = { ...base, origin: { kind: "jql", query: "project = EX" }, columns: [grouped] };
    const fresh: BoardColumn[] = [
      { name: "To Do", statuses: ["10000"], category: "todo" },
      { name: "In Progress", statuses: ["3"], category: "in_progress" },
      { name: "QA Testing", statuses: ["5"], category: "in_review" },
    ];
    expect(syncedColumns(board, fresh)).toEqual([grouped, { name: "QA Testing", statuses: ["5"], category: "in_review" }]);
  });

  it("matches a Jira board's, starts from the tracker's with the old mapping, and keeps what it has without news", () => {
    const board: BoardConfig = { ...base, origin: { kind: "jira_board", board: 10 }, columns: [todo, review] };
    expect(syncedColumns(board, [todo])).toEqual([todo]);
    expect(syncedColumns({ ...board, columns: undefined, states: { "To Do": "hidden" } }, [todo])).toEqual([{ ...todo, show: "hide" }]);
    expect(syncedColumns(board, null)).toEqual([todo, review]);
    expect(syncedColumns({ ...base, origin: { kind: "github_repo", repo: "acme/web" } }, null)).toEqual(GITHUB_REPO_COLUMNS);
  });
});

describe("withColumnShow (X50 a column's ⋯ menu and the header's Columns menu)", () => {
  it("shows, folds or hides one column of the board, kept with the board", () => {
    const board: BoardConfig = {
      id: "b",
      name: "b",
      connection: "linear:acme",
      workspace: "local/w",
      origin: { kind: "linear_team", team: "MOON" },
      columns: [
        { name: "Todo", statuses: ["Todo"], category: "todo" },
        { name: "Done", statuses: ["Done"], category: "done", show: "fold" },
      ],
    };
    expect(withColumnShow(board, "Todo", "fold").columns).toEqual([
      { name: "Todo", statuses: ["Todo"], category: "todo", show: "fold" },
      { name: "Done", statuses: ["Done"], category: "done", show: "fold" },
    ]);
    expect(withColumnShow(board, "Done", "show").columns?.[1]).toEqual({ name: "Done", statuses: ["Done"], category: "done" });
  });
});

describe("assigneeOf and pickAssignee (X50 header: Assignee)", () => {
  const board = (id: string, assignee?: "anyone"): BoardConfig => ({ id, name: id, connection: "linear:acme", workspace: "local/w", origin: { kind: "linear_team", team: id }, ...(assignee && { assignee }) });

  it("is the user's pick for the board while the board's own setting is the one it was made over, else that setting", () => {
    expect(assigneeOf(board("ops", "anyone"), {})).toBe("anyone");
    expect(assigneeOf(board("web"), {})).toBe("me");
    const picks = pickAssignee({}, board("ops", "anyone"), "me", ["ops"]);
    expect(assigneeOf(board("ops", "anyone"), picks)).toBe("me");
    // Board settings changed the board's own setting since: that wins.
    expect(assigneeOf(board("ops"), picks)).toBe("me");
    expect(assigneeOf(board("ops"), pickAssignee({}, board("ops"), "anyone", ["ops"]))).toBe("anyone");
    expect(assigneeOf(board("ops", "anyone"), pickAssignee({}, board("ops"), "anyone", ["ops"]))).toBe("anyone");
    expect(assigneeOf(board("ops", "anyone"), pickAssignee({}, board("ops"), "me", ["ops"]))).toBe("anyone");
  });

  it("forgets the picks of boards that are gone, and keeps an upgrade's Assignee: anyone for boards at me", () => {
    const upgraded = { "*": { to: "anyone" as const, over: "me" as const } };
    expect(assigneeOf(board("web"), upgraded)).toBe("anyone");
    expect(pickAssignee({ ...upgraded, old: { to: "anyone", over: "me" } }, board("ops"), "me", ["ops", "web"])).toEqual({ ...upgraded, ops: { to: "me", over: "me" } });
  });
});

describe("withPinned (X50 Settings › Boards: Pinned)", () => {
  it("pins or unpins a board, writing only an unpinned one", () => {
    const boards: BoardConfig[] = [
      { id: "a", name: "A", connection: "linear:acme", workspace: "local/w", origin: { kind: "linear_team", team: "A" } },
      { id: "b", name: "B", connection: "linear:acme", workspace: "local/w", origin: { kind: "linear_team", team: "B" }, pinned: false },
    ];
    expect(withPinned(boards, "a", false).map((b) => b.pinned)).toEqual([false, false]);
    expect(withPinned(boards, "b", true)).toEqual([boards[0], { id: "b", name: "B", connection: "linear:acme", workspace: "local/w", origin: { kind: "linear_team", team: "B" } }]);
  });
});

describe("a due date given as a time (X50 ClickUp)", () => {
  it("is the day it falls on where the user is", () => {
    // 2017-10-18 23:26 UTC: the 18th in London, the 19th in Warsaw.
    expect(localDay(1_508_369_194_377, 0)).toBe("2017-10-18");
    expect(localDay(1_508_369_194_377, -120)).toBe("2017-10-19");
    expect(localDay(1_508_369_194_377, 300)).toBe("2017-10-18");
    const issue = { connection: "clickup:9012", key: "CU-9hx", title: "x", url: "", column: "todo" as const, priority: 0, assignees: [], labels: [], description: "", updatedMs: 0, statusId: "", dueMs: 1_508_369_194_377 };
    expect(taskFromBoardIssue(issue, 0).due).toBe("2017-10-18");
    expect(taskFromBoardIssue(issue, -120).due).toBe("2017-10-19");
  });
});

describe("linkedProjects (X50 Add a board: By default)", () => {
  it("names the projects whose committed config links the board's tracker project, or any of its connection's for a Jira board", () => {
    const sourceProjects = { "linear:acme MOON": ["web", "api"], "linear:acme DES": ["ui-kit"], "jira:acme.atlassian.net OPS": ["ops-tools"] };
    expect(linkedProjects({ connection: "linear:acme", origin: { kind: "linear_team", team: "MOON" } }, sourceProjects)).toEqual(["web", "api"]);
    expect(linkedProjects({ connection: "jira:acme.atlassian.net", origin: { kind: "jql", query: "project = OPS" } }, sourceProjects)).toEqual(["ops-tools"]);
    // A Jira board's issues can be of any of the site's projects.
    expect(linkedProjects({ connection: "jira:acme.atlassian.net", origin: { kind: "jira_board", board: 10 } }, sourceProjects)).toEqual(["ops-tools"]);
    expect(linkedProjects({ connection: "linear:acme", origin: { kind: "linear_team", team: "ENG" } }, sourceProjects)).toEqual([]);
  });
});

describe("footerTracker (X50 sidebar footer)", () => {
  it("names the tracker of the board shown, a repository's board beside it or not", () => {
    expect(footerTracker({ connection: "jira:acme.atlassian.net" })).toBe("Jira");
    expect(footerTracker({ connection: "linear:acme" })).toBe("Linear");
    expect(footerTracker({ connection: "github:github.com" })).toBe("GitHub");
    // No board shown yet: the repositories' GitHub.
    expect(footerTracker(null)).toBe("GitHub");
  });
});

describe("byDefaultHint (X50 Add a board: By default)", () => {
  it("names the projects that link the tracker project, by name where known", () => {
    const projects = [
      { id: "web", name: "Website" },
      { id: "api", name: "API" },
    ];
    expect(byDefaultHint(["web", "api"], projects)).toBe("The projects that link it: Website, API");
    expect(byDefaultHint(["gone"], projects)).toBe("The projects that link it: gone");
    expect(byDefaultHint([], projects)).toBe("The projects that link it: none yet");
  });
});

describe("projectMove (X50 moving a GitHub Project item)", () => {
  const project = { id: "PVT_1", field: "PVTSSF_1", options: [{ id: "o1", name: "Todo" }, { id: "o2", name: "In Progress" }, { id: "o3", name: "Done" }] };

  it("sets the item's Status field to the column's option", () => {
    expect(projectMove(project, "PVTI_10", "o3")).toEqual({ project: "PVT_1", item: "PVTI_10", field: "PVTSSF_1", option: "o3" });
    // No Status, the column of no option, clears it; an option the team named "No Status" is an option like any other.
    expect(projectMove(project, "PVTI_10", "")).toEqual({ project: "PVT_1", item: "PVTI_10", field: "PVTSSF_1", option: null });
    const named = { ...project, options: [...project.options, { id: "o4", name: "No Status" }] };
    expect(projectMove(named, "PVTI_10", "o4")).toEqual({ project: "PVT_1", item: "PVTI_10", field: "PVTSSF_1", option: "o4" });
    // An option the Project no longer has, or a Project without a Status field: nothing to send.
    expect(projectMove(project, "PVTI_10", "o9")).toBe(null);
    // A board still saved with option names moves by the name.
    expect(projectMove(project, "PVTI_10", "Done")).toEqual({ project: "PVT_1", item: "PVTI_10", field: "PVTSSF_1", option: "o3" });
    expect(projectMove({ ...project, field: null }, "PVTI_10", "o3")).toBe(null);
  });

  it("locks a Project item's State menu without gh's project scope, saying what to run", () => {
    const item = { github: { repo: "acme/web", number: 10, closingPrs: [], project: { id: "PVT_1", item: "PVTI_10", status: null } } };
    expect(projectMoveLock(item, ["repo", "read:project"])).toBe("Moving needs gh's project scope: run gh auth refresh -s project");
    expect(projectMoveLock(item, ["repo", "project"])).toBe(null);
    // Not known yet, or not a Project's item: open.
    expect(projectMoveLock(item, undefined)).toBe(null);
    expect(projectMoveLock({ github: { repo: "acme/web", number: 10, closingPrs: [] } }, [])).toBe(null);
  });
});
