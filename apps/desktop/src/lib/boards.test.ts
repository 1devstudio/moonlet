import { describe, expect, it } from "vitest";
import { migrateWorkspace } from "./boards";
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
