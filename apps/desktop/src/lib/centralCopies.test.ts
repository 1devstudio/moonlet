import { describe, expect, it } from "vitest";
import { copyEntries } from "./centralCopies";
import type { Session } from "./protocol";

const s = (id: string, extra: Partial<Session> = {}): Session => ({
  id,
  project_id: "a",
  name: id,
  branch: `moonlet/${id}`,
  base: "",
  path: `/Users/me/.moonlet/copies/MacBook/shop/${id}`,
  agent: null,
  archived: false,
  created_at: 0,
  workspace_id: "personal",
  terminals: [],
  layout: null,
  ...extra,
});
const book = { worker: "book-id", name: "MacBook", reachable: true };

describe("the copies the central host's app lists (X86)", () => {
  // `session.list {copies: true}` from the app's own daemon: its own
  // session, and one the MacBook runs.
  const list = [s("s1"), s("s7", { owner: book })];

  it("lists each session another member runs under its copy host", () => {
    expect(copyEntries(list, { account: "mini-id", central: null })).toEqual({ "local#copy:s7": [s("s7", { owner: book })] });
  });

  it("lists none on a member, whose central host lists its own", () => {
    expect(copyEntries(list, { account: "mini-id", central: "studio-mini" })).toEqual({});
    expect(copyEntries(list, undefined)).toEqual({});
  });

  it("never lists this Mac's own sessions as copies", () => {
    expect(copyEntries([s("s8", { owner: { ...book, worker: "mini-id", name: "studio-mini" } })], { account: "mini-id", central: null })).toEqual({});
  });
});
