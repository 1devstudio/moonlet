import { describe, expect, it } from "vitest";
import { workspaceConnections } from "./trackerSources";
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
