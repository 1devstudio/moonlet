import { describe, expect, it } from "vitest";
import { migrateWorkspace, startProjects, taskFromBoardIssue } from "./boards";
import type { Task } from "./tasks";
import { DEFAULT_CONFIG, type TrackersConfig } from "./tasksStore";

describe("migrateWorkspace (X50 Boards replace sources)", () => {
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

  it("turns the workspace's sources and GitHub repositories into pinned boards", () => {
    // Two projects of the workspace share a repository: one board.
    const after = migrateWorkspace(config, "local/acme", ["acme/storefront", "acme/storefront"]);
    expect(after.boards).toEqual([
      {
        id: "github:github.com/acme/storefront@local/acme",
        name: "acme/storefront",
        connection: "github:github.com",
        workspace: "local/acme",
        origin: { kind: "github_repo", repo: "acme/storefront" },
      },
      {
        id: "jira:acme.atlassian.net/OPS@local/acme",
        name: "Operations",
        connection: "jira:acme.atlassian.net",
        workspace: "local/acme",
        origin: { kind: "jql", query: "project = OPS" },
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
    expect(after.migrated).toEqual(["local/acme"]);
  });

  it("keeps other workspaces' sources until they open, and drops a connection's states with its last source", () => {
    const withUnchosen: TrackersConfig = {
      ...config,
      connections: config.connections?.map((c) => (c.kind === "linear" ? { ...c, sources: [...c.sources, { key: "DES", name: "Design", workspace: "" }] } : c)),
    };
    const after = migrateWorkspace(withUnchosen, "local/acme", []);
    // A source no workspace was ever chosen for showed nowhere: it goes too.
    expect(after.connections?.map((c) => [c.id, c.sources, c.states])).toEqual([
      ["jira:acme.atlassian.net", [{ key: "PLAT", name: "Platform", workspace: "local/other" }], { QA: "in_review", Backlog: "hidden" }],
      ["linear:1devstudio", [], undefined],
    ]);
  });

  it("migrates a workspace once, so a board removed later stays removed", () => {
    const after = migrateWorkspace(config, "local/acme", ["acme/storefront"]);
    expect(migrateWorkspace({ ...after, boards: [] }, "local/acme", ["acme/storefront"]).boards).toEqual([]);
  });

  it("makes a ClickUp list a list board", () => {
    const clickup: TrackersConfig = {
      ...DEFAULT_CONFIG,
      connections: [{ id: "clickup:9012", kind: "clickup", site: "9012", account: "Sam", auth: "token", sources: [{ key: "901", name: "Sprint", workspace: "local/acme" }] }],
    };
    expect(migrateWorkspace(clickup, "local/acme", []).boards?.map((b) => b.origin)).toEqual([{ kind: "clickup_list", list: "901" }]);
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
