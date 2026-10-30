import { describe, expect, it } from "vitest";
import type { Session } from "@desktop/lib/protocol";
import { continueFailed, continueOffer, copyData, dropRelisted, ownerLine, readOnlyLine } from "./copies";

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
    // Terminal 3 as its member lists it; chat 9, which it did not list,
    // stands for its own terminal.
    expect(d?.terminals[3]).toEqual({ id: 3, title: "claude" });
    expect(Object.keys(d?.terminals ?? {})).toEqual(["3", "9"]);
    expect(Object.keys(d?.chats ?? {})).toEqual(["3", "9"]);
  });

  it("keep their chats reachable while their member is away, with no terminal list", () => {
    const d = copyData(
      { terminals: {}, sessions: [session({ worker: "w1", name: "MacBook", reachable: false })], projects: [], workspaces: [], sections: [], reads: [], chats: {}, git: null, copies: [], setups: [], tasks: {}, macOpen: false },
      "5e7f9a1b3c5d",
      [],
      [{ id: 3, state: { status: "done" } as never }],
    );
    // The chat terminal the copy's chat names, so the Chat tab finds it.
    expect(d?.terminals[3]).toMatchObject({ id: 3, session_id: "5e7f9a1b3c5d", chat: true, kind: "agent" });
  });
});

describe("a session listed by its member and by the central host (X72)", () => {
  it("shows once, from its member", () => {
    const own = { ...session(), id: "a1" };
    const copy = { ...session({ worker: "w1", name: "MacBook", reachable: true }), id: "a1" };
    const other = { ...session({ worker: "w2", name: "MacBook Air", reachable: true }), id: "b2" };
    expect(dropRelisted({ book: [own], mini: [copy, other] })).toEqual({ book: [own], mini: [other] });
  });
});

describe("continuing a session whose member is away (X73)", () => {
  it("is offered on the central host while that member is unreachable", () => {
    expect(continueOffer(session({ worker: "w1", name: "MacBook", reachable: false }), "studio-mini")).toBe("Continue on studio-mini");
    expect(continueOffer(session({ worker: "w1", name: "MacBook", reachable: true }), "studio-mini")).toBeNull();
    expect(continueOffer({ ...session({ worker: "w1", name: "MacBook", reachable: false }), pinned: "w1" }, "studio-mini")).toBeNull();
    expect(continueOffer(session(), "studio-mini")).toBeNull();
  });

  it("says why it could not continue, so the user can try again", () => {
    const away = session({ worker: "w1", name: "MacBook", reachable: false });
    expect(continueFailed({ code: "reachable", message: "the member running that session is reachable" }, away, "studio-mini")).toBe(
      "MacBook is back: fix-cart goes on there.",
    );
    expect(continueFailed({ code: "pinned", message: "that session is kept on its member" }, away, "studio-mini")).toBe("fix-cart is kept on MacBook.");
    expect(continueFailed({ code: "no_copy", message: "this host has no copy of that session yet" }, away, "studio-mini")).toBe(
      "studio-mini has no copy of fix-cart yet.",
    );
    expect(continueFailed(new Error("the connection closed"), away, "studio-mini")).toBe("Could not continue on studio-mini: the connection closed");
  });
});
