import { describe, expect, it } from "vitest";
import { Presence } from "./presence";

describe("the phone says where the user is (X75)", () => {
  it("tells each connected host at most every 30 s", () => {
    const p = new Presence();
    expect(p.active(1_000, ["mini"])).toEqual(["mini"]);
    expect(p.active(10_000, ["mini", "book"])).toEqual(["book"]);
    expect(p.active(31_000, ["mini", "book"])).toEqual(["mini"]);
  });

  it("tells a host that connects soon after the user was active, though no host was connected then", () => {
    const p = new Presence();
    expect(p.active(1_000, [])).toEqual([]);
    expect(p.connected("mini", 5_000)).toBe(true);
    // A host that connects long after says nothing until the user is active again.
    expect(p.connected("book", 40_000)).toBe(false);
  });

  it("tries again on the next activity after a report failed", () => {
    const p = new Presence();
    expect(p.active(1_000, ["mini"])).toEqual(["mini"]);
    p.failed("mini");
    expect(p.active(2_000, ["mini"])).toEqual(["mini"]);
  });
});
