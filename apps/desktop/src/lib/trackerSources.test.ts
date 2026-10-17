import { describe, expect, it } from "vitest";
import { changedStates, parseTrackerLink, projectTrackers, trackerLink, sourceList, sourceChoices, sourceNoun } from "./trackerSources";
import type { BoardConfig } from "./boards";

describe("sourceList (X44 Where each workspace gets its tasks, X45 sidebar Trackers, on boards X50)", () => {
  it("lists the workspace's boards by tracker and name, marking a board whose connection needs attention", () => {
    const b = (id: string, connection: string, workspace: string, name: string): BoardConfig => ({ id, name, connection, workspace, origin: { kind: "linear_team", team: id } });
    const boards = [b("web", "github:github.com", "local/w1", "acme/web"), b("eng", "linear:acme", "local/w1", "Engineering"), b("des", "linear:acme", "local/w2", "Design"), b("ops", "jira:ops.atlassian.net", "local/w1", "Operations")];
    expect(sourceList("local/w1", boards, { "jira:ops.atlassian.net": "Jira no longer accepts the API token" })).toEqual([
      { tracker: "GitHub", name: "acme/web", attention: undefined },
      { tracker: "Linear", name: "Engineering", attention: undefined },
      { tracker: "Jira", name: "Operations", attention: "Jira no longer accepts the API token" },
    ]);
  });
});

describe("changedStates (X44 Workflow states)", () => {
  it("keeps only the states moved off their default column", () => {
    const states = [
      { name: "Backlog", column: "hidden" as const },
      { name: "Todo", column: "todo" as const },
      { name: "QA", column: "in_progress" as const },
    ];
    expect(changedStates(states, { Backlog: "todo", Todo: "todo", QA: "in_review" })).toEqual({ Backlog: "todo", QA: "in_review" });
  });
});

describe("sourceNoun (X44 Sources dialog)", () => {
  it("names what a source is in each tracker", () => {
    expect(sourceNoun("linear")).toBe("Linear team");
    expect(sourceNoun("jira")).toBe("Jira project");
    expect(sourceNoun("clickup")).toBe("ClickUp list");
  });
});

describe("sourceChoices (X44 Sources dialog)", () => {
  const visible = [
    { key: "ENG", name: "Engineering" },
    { key: "OPS", name: "Operations" },
    { key: "DES", name: "Design" },
  ];
  const row = (key: string, name: string, workspace = "local/one") => ({ key, name, workspace });

  it("offers a row its own source and the ones no other row shows in the same workspace", () => {
    const rows = [row("ENG", "Engineering"), row("OPS", "Operations"), row("", "")];
    expect(sourceChoices(visible, rows, 0)).toEqual([
      { key: "ENG", name: "Engineering" },
      { key: "DES", name: "Design" },
    ]);
    expect(sourceChoices(visible, rows, 2)).toEqual([{ key: "DES", name: "Design" }]);
  });

  it("offers a source again for another workspace", () => {
    const rows = [row("ENG", "Engineering", "local/one"), row("", "", "local/two")];
    expect(sourceChoices(visible, rows, 1)).toEqual(visible);
  });

  it("keeps a saved source the account no longer sees in its own row", () => {
    expect(sourceChoices(visible, [row("OLD", "Archived")], 0)).toEqual([
      { key: "OLD", name: "Archived" },
      { key: "ENG", name: "Engineering" },
      { key: "OPS", name: "Operations" },
      { key: "DES", name: "Design" },
    ]);
  });
});

describe("projectTrackers (X44 Project settings › Task trackers)", () => {
  it("names the linked tracker projects and offers the boards' other tracker projects once each (X50)", () => {
    const b = (connection: string, workspace: string, name: string, origin: BoardConfig["origin"]): BoardConfig => ({ id: `${connection}${workspace}${name}`, name, connection, workspace, origin });
    const boards = [
      b("linear:acme", "local/one", "Engineering", { kind: "linear_team", team: "ENG" }),
      b("linear:acme", "local/two", "Engineering", { kind: "linear_team", team: "ENG" }),
      b("linear:acme", "local/one", "Design", { kind: "linear_team", team: "DES" }),
      b("jira:acme.atlassian.net", "local/one", "Operations", { kind: "jql", query: "project = OPS" }),
      b("github:github.com", "local/one", "acme/web", { kind: "github_repo", repo: "acme/web" }),
    ];
    expect(projectTrackers(boards, ["jira:acme.atlassian.net/OPS", "clickup:9012/901"])).toEqual({
      linked: [
        { id: "jira:acme.atlassian.net/OPS", label: "Jira project Operations (OPS)" },
        { id: "clickup:9012/901", label: "clickup:9012/901" },
      ],
      choices: [
        { id: "linear:acme/ENG", label: "Linear team Engineering (ENG)" },
        { id: "linear:acme/DES", label: "Linear team Design (DES)" },
      ],
    });
    expect(projectTrackers(undefined, [])).toEqual({ linked: [], choices: [] });
  });
});

describe("trackerLink and parseTrackerLink (X44 trackers in .moonlet/config.toml)", () => {
  it("writes and reads a project's link to a tracker source", () => {
    expect(trackerLink("jira:acme.atlassian.net", "ABC")).toBe("jira:acme.atlassian.net/ABC");
    expect(parseTrackerLink("jira:acme.atlassian.net/ABC")).toEqual({ connection: "jira:acme.atlassian.net", key: "ABC" });
    expect(parseTrackerLink("clickup:9012/901")).toEqual({ connection: "clickup:9012", key: "901" });
    expect(parseTrackerLink("ABC")).toBe(null);
    expect(parseTrackerLink("jira:acme.atlassian.net/")).toBe(null);
  });
});
