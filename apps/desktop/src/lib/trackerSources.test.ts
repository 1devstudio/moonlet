import { describe, expect, it } from "vitest";
import { changedStates, parseTrackerLink, projectTrackers, trackerLink, sourceList, sourceChoices, sourceNoun, sourceRows, sourcesToSave, workspaceConnections } from "./trackerSources";
import type { Connection } from "./tasksStore";

const conn = (id: string, sources: Connection["sources"]): Connection => ({ id, kind: id.split(":")[0] as Connection["kind"], site: id.split(":")[1], account: "Sam", auth: "token", sources });

describe("workspaceConnections (X44 sources per workspace)", () => {
  it("lists the connections with a source in the workspace and their keys", () => {
    const connections = [
      conn("linear:acme", [
        { key: "MOON", name: "Moonlet", workspace: "local/one" },
        { key: "DES", name: "Design", workspace: "local/two" },
      ]),
      conn("jira:acme.atlassian.net", [{ key: "OPS", name: "Operations", workspace: "local/one" }]),
      conn("clickup:9012", [{ key: "901", name: "Sprint", workspace: "" }]),
    ];
    expect(workspaceConnections(connections, "local/one")).toEqual([
      { id: "linear:acme", keys: ["MOON"], account: "Sam" },
      { id: "jira:acme.atlassian.net", keys: ["OPS"], account: "Sam" },
    ]);
    expect(workspaceConnections(connections, "local/three")).toEqual([]);
    expect(workspaceConnections(undefined, "local/one")).toEqual([]);
  });
});

describe("sourceList (X44 Where each workspace gets its tasks, X45 sidebar Trackers)", () => {
  it("lists GitHub repositories, then each connection's sources in the workspace, marking a connection that needs attention", () => {
    const linear = { ...conn("linear:acme", [{ key: "ENG", name: "Engineering", workspace: "local/w1" }, { key: "DES", name: "Design", workspace: "local/w2" }]), kind: "linear" as const };
    const jira = { ...conn("jira:ops.atlassian.net", [{ key: "OPS", name: "Operations", workspace: "local/w1" }]), kind: "jira" as const };
    expect(sourceList("local/w1", ["acme/web"], [linear, jira], { "jira:ops.atlassian.net": "Jira no longer accepts the API token" })).toEqual([
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

describe("sourceRows (X44 Sources dialog)", () => {
  it("opens with the connection's sources, or one empty row when it has none", () => {
    const ops = { key: "OPS", name: "Operations", workspace: "local/one" };
    expect(sourceRows([ops])).toEqual([ops]);
    expect(sourceRows([])).toEqual([{ key: "", name: "", workspace: "" }]);
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

describe("sourcesToSave (X44 Sources dialog)", () => {
  it("saves the rows with a source picked and drops empty ones", () => {
    const eng = { key: "ENG", name: "Engineering", workspace: "local/one" };
    expect(sourcesToSave([eng, { key: "", name: "", workspace: "local/one" }])).toEqual([eng]);
    expect(sourcesToSave([{ key: "", name: "", workspace: "" }])).toEqual([]);
  });

  it("saves a source once per workspace", () => {
    const one = { key: "ENG", name: "Engineering", workspace: "local/one" };
    const two = { key: "ENG", name: "Engineering", workspace: "local/two" };
    expect(sourcesToSave([one, two, { ...one, name: "Engineering (again)" }])).toEqual([one, two]);
  });
});

describe("projectTrackers (X44 Project settings › Task trackers)", () => {
  it("names the linked tracker projects and offers the connections' other sources once each", () => {
    const linear = conn("linear:acme", [
      { key: "ENG", name: "Engineering", workspace: "local/one" },
      { key: "ENG", name: "Engineering", workspace: "local/two" },
      { key: "DES", name: "Design", workspace: "local/one" },
    ]);
    const jira = conn("jira:acme.atlassian.net", [{ key: "OPS", name: "Operations", workspace: "local/one" }]);
    expect(projectTrackers([linear, jira], ["jira:acme.atlassian.net/OPS", "clickup:9012/901"])).toEqual({
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
