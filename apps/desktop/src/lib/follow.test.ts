import { describe, expect, it } from "vitest";
import { bringsHere, followMenu, hostMark, moveTargets, offlineLine, readyMark, waitingLine } from "./follow";

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
