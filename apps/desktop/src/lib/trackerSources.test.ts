import { describe, expect, it } from "vitest";
import { changedStates, sourceList, sourceChoices, sourceNoun, sourceRows, sourcesToSave, workspaceConnections } from "./trackerSources";
import type { Connection } from "./tasksStore";

const conn = (id: string, sources: Connection["sources"]): Connection => ({ id, kind: id.split(":")[0] as Connection["kind"], site: id.split(":")[1], account: "Sam", auth: "token", sources });

describe("workspaceConnections (X44 sources per workspace)", () => {
  it("lists the connections with a source in the workspace, their keys and the projects sessions start in", () => {
    const connections = [
      conn("linear:acme", [
        { key: "MOON", name: "Moonlet", project: "p-moonlet", workspace: "local/one" },
        { key: "DES", name: "Design", project: "", workspace: "local/two" },
      ]),
      conn("jira:acme.atlassian.net", [{ key: "OPS", name: "Operations", project: "p-ops", workspace: "local/one" }]),
      conn("clickup:9012", [{ key: "901", name: "Sprint", project: "", workspace: "" }]),
    ];
    expect(workspaceConnections(connections, "local/one")).toEqual([
      { id: "linear:acme", keys: ["MOON"], projects: { MOON: "p-moonlet" }, account: "Sam" },
      { id: "jira:acme.atlassian.net", keys: ["OPS"], projects: { OPS: "p-ops" }, account: "Sam" },
    ]);
    expect(workspaceConnections(connections, "local/three")).toEqual([]);
    expect(workspaceConnections(undefined, "local/one")).toEqual([]);
  });
});

describe("sourceList (X44 Where each workspace gets its tasks, X45 sidebar Trackers)", () => {
  it("lists GitHub repositories, then each connection's sources in the workspace, marking a connection that needs attention", () => {
    const linear = { ...conn("linear:acme", [{ key: "ENG", name: "Engineering", project: "", workspace: "local/w1" }, { key: "DES", name: "Design", project: "", workspace: "local/w2" }]), kind: "linear" as const };
    const jira = { ...conn("jira:ops.atlassian.net", [{ key: "OPS", name: "Operations", project: "", workspace: "local/w1" }]), kind: "jira" as const };
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
    const ops = { key: "OPS", name: "Operations", project: "p-ops", workspace: "local/one" };
    expect(sourceRows([ops])).toEqual([ops]);
    expect(sourceRows([])).toEqual([{ key: "", name: "", project: "", workspace: "" }]);
  });
});

describe("sourceChoices (X44 Sources dialog)", () => {
  const visible = [
    { key: "ENG", name: "Engineering" },
    { key: "OPS", name: "Operations" },
    { key: "DES", name: "Design" },
  ];
  const row = (key: string, name: string, workspace = "local/one") => ({ key, name, project: "", workspace });

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
    const eng = { key: "ENG", name: "Engineering", project: "p-web", workspace: "local/one" };
    expect(sourcesToSave([eng, { key: "", name: "", project: "", workspace: "local/one" }])).toEqual([eng]);
    expect(sourcesToSave([{ key: "", name: "", project: "", workspace: "" }])).toEqual([]);
  });

  it("saves a source once per workspace", () => {
    const one = { key: "ENG", name: "Engineering", project: "p-web", workspace: "local/one" };
    const two = { key: "ENG", name: "Engineering", project: "p-api", workspace: "local/two" };
    expect(sourcesToSave([one, two, { ...one, project: "p-other" }])).toEqual([one, two]);
  });
});
