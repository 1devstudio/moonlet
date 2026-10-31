import { describe, expect, it } from "vitest";
import { bringsHere, followMenu, hostMark, joinWaiting, movedHost, rowMark, moveTargets, offlineLine, readinessOf, readyMark, untilTurnEnds, waitingLine } from "./follow";

const accounts = { local: { account: "mini-id" }, mini: { account: "mini-id" }, vps: { account: "other" } };

describe("where a session runs (X73)", () => {
  it("shows nothing for a session on this Mac, a pin when it is kept here", () => {
    expect(hostMark({}, "local", "This Mac", true)).toBeNull();
    expect(hostMark({ pinned: "book-id" }, "local", "This Mac", true)).toEqual({ server: false, pin: true, dim: false, tooltip: "Kept on this Mac" });
  });

  it("shows the host for a session running on another member, dimmed while it is offline", () => {
    expect(hostMark({}, "mini", "studio-mini", true)).toEqual({ server: true, pin: false, dim: false, tooltip: "Running on studio-mini" });
    expect(hostMark({ pinned: "mini-id" }, "mini", "studio-mini", true)).toEqual({ server: true, pin: true, dim: false, tooltip: "Kept on studio-mini" });
    expect(hostMark({}, "mini", "studio-mini", false, "14:02")).toEqual({ server: true, pin: false, dim: true, tooltip: "Running on studio-mini · offline since 14:02" });
  });

  it("dims the central host's sessions while this Mac cannot reach it, even with the app still connected to it", () => {
    const since = new Date(2026, 9, 29, 14, 2).getTime();
    expect(rowMark({}, "mini", "studio-mini", { connected: true, central: "mini", unreachableSince: since })).toEqual({
      server: true,
      pin: false,
      dim: true,
      tooltip: "Running on studio-mini · offline since 14:02",
    });
    expect(rowMark({}, "mini", "studio-mini", { connected: true, central: "mini", unreachableSince: null })).toEqual({ server: true, pin: false, dim: false, tooltip: "Running on studio-mini" });
    // Another host goes by the app's own connection to it.
    expect(rowMark({}, "vps", "vps", { connected: true, central: "mini", unreachableSince: since })).toEqual({ server: true, pin: false, dim: false, tooltip: "Running on vps" });
    expect(rowMark({}, "vps", "vps", { connected: false, central: "mini", unreachableSince: null })).toEqual({ server: true, pin: false, dim: true, tooltip: "Running on vps · offline" });
  });
});

describe("typing into another member's session (X73)", () => {
  it("brings it here when it is a member of this Mac's account and not kept there", () => {
    expect(bringsHere("mini", accounts, {})).toBe(true);
    expect(bringsHere("mini", accounts, { pinned: "mini-id" })).toBe(false);
    expect(bringsHere("local", accounts, {})).toBe(false);
    // A host outside the account is only ever talked to where it is.
    expect(bringsHere("vps", accounts, {})).toBe(false);
  });

  it("says it waits for the turn there to end", () => {
    expect(waitingLine("studio-mini")).toBe("Moves here when studio-mini's turn ends");
  });
});

describe("the central host offline (X73)", () => {
  it("says since when", () => {
    const since = new Date(2026, 9, 29, 14, 2).getTime();
    expect(offlineLine("studio-mini", since)).toBe("studio-mini is offline since 14:02");
  });
});

describe("Move to… (X73)", () => {
  it("offers this Mac and the central host, with the current owner checked", () => {
    expect(moveTargets({ thisMac: "book-id", central: { id: "mini-id", label: "studio-mini" }, owner: "book-id" })).toEqual([
      { to: "book-id", label: "This Mac", current: true },
      { to: "mini-id", label: "studio-mini", current: false },
    ]);
    expect(moveTargets({ thisMac: "book-id", central: null, owner: "book-id" })).toEqual([]);
  });
});

describe("a session's menu to move it (X73)", () => {
  const base = { centralHost: "mini", me: "book-id", centralId: "mini-id", centralLabel: "studio-mini", pinned: false, unreachableSince: null, now: 100_000, copy: true };
  it("offers Move to… for this Mac's and the central host's sessions", () => {
    expect(followMenu({ ...base, host: "local" })).toEqual([
      { kind: "move", to: "book-id", label: "This Mac", current: true },
      { kind: "move", to: "mini-id", label: "studio-mini", current: false },
    ]);
    expect(followMenu({ ...base, host: "mini", pinned: true }).map((i) => i.kind)).toEqual(["move", "move", "unpin"]);
    expect(followMenu({ ...base, host: "vps" })).toEqual([]);
  });

  it("offers Take over anyway only after 30 s offline, for what the central host runs", () => {
    expect(followMenu({ ...base, host: "mini", unreachableSince: 80_000 })).toEqual([{ kind: "move", to: "book-id", label: "This Mac", current: false }, { kind: "move", to: "mini-id", label: "studio-mini", current: true }]);
    expect(followMenu({ ...base, host: "mini", unreachableSince: 60_000 })).toEqual([{ kind: "take-over" }]);
    expect(followMenu({ ...base, host: "local", unreachableSince: 60_000 })).toEqual([]);
  });

  it("offers Take over anyway only for a session this Mac holds a copy of", () => {
    expect(followMenu({ ...base, host: "mini", unreachableSince: 60_000, copy: false })).toEqual([]);
  });
});

describe("the readiness mark (X73)", () => {
  it("says why the central host could not continue a session, and nothing when it could", () => {
    expect(readyMark({ session: "s1", ready: false, reason: "Claude Code is not installed here" }, "studio-mini", "fix-cart")).toBe(
      "studio-mini could not continue fix-cart: Claude Code is not installed here.",
    );
    expect(readyMark({ session: "s1", ready: true }, "studio-mini", "fix-cart")).toBeNull();
    expect(readyMark(undefined, "studio-mini", "fix-cart")).toBeNull();
  });
});

describe("asking the central host for readiness (X73)", () => {
  const notReady = { session: "s1", ready: false, reason: "setup is not approved there" };
  it("keeps its answer by session", async () => {
    expect(await readinessOf({ central: "mini", connected: true, ask: async () => [notReady], current: () => "mini" })).toEqual({ s1: notReady });
  });

  it("shows no marks while the central host is away or does not answer", async () => {
    expect(await readinessOf({ central: "mini", connected: false, ask: async () => [notReady], current: () => "mini" })).toEqual({});
    expect(await readinessOf({ central: null, connected: false, ask: async () => [notReady], current: () => null })).toEqual({});
    expect(
      await readinessOf({
        central: "mini",
        connected: true,
        ask: async () => {
          throw new Error("unknown method");
        },
        current: () => "mini",
      }),
    ).toEqual({});
  });

  it("drops an answer from a central host that is no longer this Mac's", async () => {
    expect(await readinessOf({ central: "mini", connected: true, ask: async () => [notReady], current: () => "studio" })).toBeNull();
  });
});

describe("waiting for the turn there to end (X73)", () => {
  class Busy extends Error {
    code = "busy";
  }
  // A clock that moves on by each wait, so ten minutes pass at once.
  const run = (attempt: (now: boolean) => Promise<void>, onWait?: (moveNow: () => void) => void) => {
    let t = 0;
    return untilTurnEnds({
      attempt,
      waiting: onWait ?? (() => {}),
      sleep: async (ms) => {
        t += ms;
      },
      clock: () => t,
      waitMs: 10 * 60_000,
      everyMs: 3000,
    });
  };

  it("goes on as soon as the turn has ended", async () => {
    let turns = 2;
    expect(
      await run(async () => {
        if (turns-- > 0) throw new Busy("a turn is running");
      }),
    ).toBe("done");
  });

  it("gives up once the turn still runs after the wait", async () => {
    expect(
      await run(async () => {
        throw new Busy("a turn is running");
      }),
    ).toBe("timeout");
  });

  it("moves at once with Move now", async () => {
    expect(
      await run(
        async (now) => {
          if (!now) throw new Busy("a turn is running");
        },
        (moveNow) => moveNow(),
      ),
    ).toBe("done");
  });

  it("stops at an error that is not the turn", async () => {
    await expect(
      run(async () => {
        throw new Error("that session is kept where it is");
      }),
    ).rejects.toThrow("that session is kept where it is");
  });
});

describe("messages typed while one waits (X73)", () => {
  it("go with it when typed in the same chat, in order", () => {
    const image = { name: "cart.png", media_type: "image/png", data: "aGVsbG8=" };
    expect(joinWaiting({ terminal: 4, text: "Fix the cart", images: [] }, { terminal: 4, text: "And the tests", images: [image] })).toEqual({
      terminal: 4,
      text: "Fix the cart\n\nAnd the tests",
      images: [image],
    });
  });

  it("do not join one waiting in another chat", () => {
    expect(joinWaiting({ terminal: 4, text: "Fix the cart", images: [] }, { terminal: 7, text: "And the tests", images: [] })).toBeNull();
  });
});

describe("after Move to… (X73)", () => {
  it("shows the session where it is listed now", () => {
    expect(movedHost({ to: "book-id", me: "book-id", centralHost: "mini" })).toBe("local");
    expect(movedHost({ to: "mini-id", me: "book-id", centralHost: "mini" })).toBe("mini");
  });
});
