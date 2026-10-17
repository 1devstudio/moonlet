import { describe, expect, it } from "vitest";
import { boardList, changedStates, connectedText, disconnectText, parseTrackerLink, projectTrackers, trackerLink, sourceChoices, sourceNoun } from "./trackerSources";
import type { BoardConfig } from "./boards";

describe("boardList (X50 Settings › Task trackers › Boards)", () => {
  it("lists the workspace's boards with their origin and pin, marking a board whose connection needs attention", () => {
    const boards: BoardConfig[] = [
      { id: "web", name: "acme/web", connection: "github:github.com", workspace: "local/w1", origin: { kind: "github_repo", repo: "acme/web" } },
      { id: "eng", name: "Engineering", connection: "linear:acme", workspace: "local/w1", origin: { kind: "linear_team", team: "ENG" }, pinned: false },
      { id: "des", name: "Design", connection: "linear:acme", workspace: "local/w2", origin: { kind: "linear_team", team: "DES" } },
      { id: "ops", name: "Operations", connection: "jira:ops.atlassian.net", workspace: "local/w1", origin: { kind: "jira_board", board: 10 } },
    ];
    expect(boardList("local/w1", boards, { "jira:ops.atlassian.net": "Jira no longer accepts the API token" })).toEqual([
      { id: "web", connection: "github:github.com", name: "acme/web", origin: "GitHub acme/web", pinned: true, attention: undefined },
      { id: "eng", connection: "linear:acme", name: "Engineering", origin: "Linear team ENG", pinned: false, attention: undefined },
      { id: "ops", connection: "jira:ops.atlassian.net", name: "Operations", origin: "Jira board 10", pinned: true, attention: "Jira no longer accepts the API token" },
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

describe("disconnectText (X50 Disconnecting removes its boards)", () => {
  it("names the boards that go with the connection", () => {
    const b = (name: string, connection: string): BoardConfig => ({ id: name, name, connection, workspace: "local/w1", origin: { kind: "jql", query: name } });
    const boards = [b("OPS", "jira:ops.atlassian.net"), b("Moonlet", "linear:acme"), b("WEB · Website", "jira:ops.atlassian.net")];
    expect(disconnectText({ id: "jira:ops.atlassian.net", site: "ops.atlassian.net" }, boards)).toBe("moonlet forgets the token for ops.atlassian.net and removes its 2 boards, OPS and WEB · Website. Sessions keep their links.");
    expect(disconnectText({ id: "linear:acme", site: "acme" }, boards)).toBe("moonlet forgets the token for acme and removes its board Moonlet. Sessions keep their links.");
    expect(disconnectText({ id: "clickup:9012", site: "9012" }, boards)).toBe("moonlet forgets the token for 9012 and stops showing its issues. Sessions keep their links.");
  });
});

describe("connectedText (X50 the Connect dialog's end)", () => {
  it("says who signed in, what the account sees and what its first board can be built from", () => {
    expect(connectedText("linear", "Ada Lovelace", 2)).toEqual({ line: "Signed in as Ada Lovelace · 2 teams visible", hint: "Make the first board from one of its teams." });
    expect(connectedText("jira", "Mia Krystof", 1)).toEqual({ line: "Signed in as Mia Krystof · 1 project visible", hint: "Make the first board from a Jira board or a JQL query." });
    expect(connectedText("clickup", "John Doe", 4)).toEqual({ line: "Signed in as John Doe · 4 lists visible", hint: "Make the first board from one of its lists." });
  });
});
