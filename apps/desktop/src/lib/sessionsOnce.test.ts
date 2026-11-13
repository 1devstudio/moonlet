import { describe, expect, it } from "vitest";
import type { Session } from "./protocol";
import { sessionsOnce } from "./sessionsOnce";

const s = (id: string, extra: Partial<Session> = {}): Session => ({
  id,
  project_id: "p1",
  name: id,
  branch: `moonlet/${id}`,
  base: "main",
  path: `/w/${id}`,
  agent: "claude",
  archived: false,
  created_at: 0,
  workspace_id: "W",
  terminals: [],
  layout: null,
  ...extra,
});

describe("each session once across the hosts the app lists (X73)", () => {
  it("lists a session two hosts list, as while it moves between them, once, from the first", () => {
    const listed = sessionsOnce({
      local: [s("s1"), s("s9")],
      "studio-mini": [s("s9"), s("s2"), s("s3", { archived: true })],
    });
    expect(listed.map((e) => `${e.host} ${e.session.id}`)).toEqual(["local s1", "local s9", "studio-mini s2"]);
  });

  it("leaves out the central host's copy of a session another host lists as its own (X86)", () => {
    const owner = { worker: "book-id", name: "MacBook", reachable: true };
    const listed = sessionsOnce({
      local: [s("s1")],
      "local#copy:s7": [s("s7", { owner })],
      "local#copy:s9": [s("s9", { owner })],
      macbook: [s("s9")],
    });
    expect(listed.map((e) => `${e.host} ${e.session.id}`)).toEqual(["local s1", "local#copy:s7 s7", "macbook s9"]);
  });
});
