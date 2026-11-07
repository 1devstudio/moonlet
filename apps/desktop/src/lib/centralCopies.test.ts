import { describe, expect, it } from "vitest";
import { copyEntries, copyOffers, copyRefused, copyView } from "./centralCopies";
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

describe("the copies the central host's app lists (X88)", () => {
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

describe("what a copy shows when opened (X88)", () => {
  const copy = s("s7", { owner: book, created_at: 1700 });
  const chat = {
    id: 3,
    kind: "agent" as const,
    title: "Claude",
    cwd: "/Users/alex/w/s7",
    command: ["claude"],
    session_id: "s7",
    agent_state: "working" as const,
    cols: 120,
    rows: 40,
    pid: 4242,
    chat: true,
    created_at: 1800,
    last_output_at: 1900,
  };

  it("holds the terminals its member lists", () => {
    expect(copyView(copy, [chat], [3])).toEqual({ session: { ...copy, terminals: [3] }, terminals: [chat] });
  });

  it("stands each chat the copy holds in for its terminal while the member is away", () => {
    expect(copyView(copy, [], [3])).toEqual({
      session: { ...copy, terminals: [3] },
      terminals: [
        {
          id: 3,
          kind: "agent",
          title: "Claude",
          cwd: "/Users/me/.moonlet/copies/MacBook/shop/s7",
          command: [],
          session_id: "s7",
          agent_state: "idle",
          cols: 80,
          rows: 24,
          pid: null,
          chat: true,
          created_at: 1700,
          last_output_at: 0,
        },
      ],
    });
  });
});

describe("what a copy offers (X88)", () => {
  it("offers none of what its member refuses through the central host", () => {
    expect(copyOffers("local#copy:s7")).toEqual({ files: false, newTabs: false, processes: false, projectSettings: false, setup: false, openIn: false });
    expect(copyOffers("local")).toEqual({ files: true, newTabs: true, processes: true, projectSettings: true, setup: true, openIn: true });
    expect(copyOffers("studio-mini")).toEqual({ files: true, newTabs: true, processes: true, projectSettings: true, setup: true, openIn: true });
  });

  it("says where to do what a copy does not offer", () => {
    const copy = s("fix-cart", { owner: book });
    expect(copyRefused(copy, "open new tabs")).toBe("fix-cart runs on MacBook: open new tabs there.");
    expect(copyRefused(copy, "run its scripts")).toBe("fix-cart runs on MacBook: run its scripts there.");
    expect(copyRefused(copy, "change its project settings")).toBe("fix-cart runs on MacBook: change its project settings there.");
  });
});
