import { describe, expect, it } from "vitest";
import { spawnedFrom, spawnedNotices } from "./spawned";
import type { Project, Session } from "./protocol";

const projects: Project[] = [
  { id: "p-api", name: "api", path: "/code/api", base_branch: "main" },
  { id: "p-web", name: "web", path: "/code/web", base_branch: "main" },
];
const s = (id: string, name: string, extra: Partial<Session> = {}): Session => ({
  id,
  project_id: "p-api",
  name,
  branch: `jaunt/${id}`,
  base: "main",
  path: `/w/${id}`,
  agent: "claude",
  archived: false,
  created_at: 0,
  terminals: [],
  layout: null,
  ...extra,
});

const parent = s("a1", "Billing export");
const child = s("b2", "Add a download button", { project_id: "p-web", spawned_by: "a1" });

describe("spawnedNotices (X22)", () => {
  it("announces a session another agent started, once", () => {
    expect(spawnedNotices([parent], [parent, child], projects)).toEqual([
      { session: "b2", text: "Billing export started Add a download button in web" },
    ]);
    expect(spawnedNotices([parent, child], [parent, child], projects)).toEqual([]);
  });

  it("stays quiet on the first load and for sessions the user created", () => {
    expect(spawnedNotices(undefined, [parent, child], projects)).toEqual([]);
    expect(spawnedNotices([], [parent], projects)).toEqual([]);
  });

  it("names an unknown parent and project generically", () => {
    const orphan = s("c3", "Fix docs", { project_id: "gone", spawned_by: "zz" });
    expect(spawnedNotices([], [orphan], projects)).toEqual([
      { session: "c3", text: "An agent started Fix docs in another project" },
    ]);
  });
});

describe("spawnedFrom (X22)", () => {
  it("names the parent, archived or not", () => {
    expect(spawnedFrom(child, [parent, child])).toBe("from Billing export");
    expect(spawnedFrom(child, [{ ...parent, archived: true }, child])).toBe("from Billing export");
  });

  it("says when the parent is gone, and nothing for a session the user created", () => {
    expect(spawnedFrom(child, [child])).toBe("from a removed session");
    expect(spawnedFrom(parent, [parent, child])).toBeNull();
  });
});
