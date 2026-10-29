import { describe, expect, it } from "vitest";
import type { Session } from "@desktop/lib/protocol";
import { copyData, ownerLine, readOnlyLine } from "./copies";

const session = (owner?: Session["owner"]): Session => ({
  id: "5e7f9a1b3c5d",
  project_id: "p1",
  name: "fix-cart",
  branch: "moonlet/fix-cart",
  base: "",
  path: "/Users/alex/.moonlet/copies/MacBook/shop/fix-cart",
  agent: null,
  archived: false,
  created_at: 1790000000002,
  terminals: [],
  layout: null,
  owner,
});

describe("sessions another member owns (X72)", () => {
  it("say where they run, and when that member is away", () => {
    expect(ownerLine(session({ worker: "w1", name: "MacBook", reachable: true }))).toBe("on MacBook");
    expect(ownerLine(session({ worker: "w1", name: "MacBook", reachable: false }))).toBe("MacBook is asleep");
    expect(ownerLine(session())).toBeNull();
  });

  it("open read only while their member is away", () => {
    expect(readOnlyLine(session({ worker: "w1", name: "MacBook", reachable: false }), "studio-mini")).toBe(
      "MacBook is asleep. This is the copy on studio-mini, read only.",
    );
    expect(readOnlyLine(session({ worker: "w1", name: "MacBook", reachable: true }), "studio-mini")).toBeNull();
  });

  it("show the session with the terminals and chats its member gave", () => {
    const d = copyData(
      { terminals: {}, sessions: [session({ worker: "w1", name: "MacBook", reachable: true })], projects: [], workspaces: [], sections: [], reads: [], chats: {}, git: null, copies: [], setups: [], tasks: {}, macOpen: false },
      "5e7f9a1b3c5d",
      [{ id: 3, title: "claude" } as never],
      [{ id: 3, state: { status: "done" } as never }, { id: 9, state: { status: "idle" } as never }],
    );
    expect(d?.sessions.map((s) => [s.id, s.terminals])).toEqual([["5e7f9a1b3c5d", [3, 9]]]);
    expect(Object.keys(d?.terminals ?? {})).toEqual(["3"]);
    expect(Object.keys(d?.chats ?? {})).toEqual(["3", "9"]);
  });
});
