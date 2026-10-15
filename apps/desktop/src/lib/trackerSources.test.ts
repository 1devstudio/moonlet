import { describe, expect, it } from "vitest";
import { changedStates, sourceList, workspaceConnections } from "./trackerSources";
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
      { id: "linear:acme", keys: ["MOON"], projects: { MOON: "p-moonlet" }, all: [], account: "Sam" },
      { id: "jira:acme.atlassian.net", keys: ["OPS"], projects: { OPS: "p-ops" }, all: [], account: "Sam" },
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
