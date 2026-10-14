import { describe, expect, it } from "vitest";
import { DaemonError } from "@desktop/lib/daemon";
import { errorText } from "./busy";

describe("errorText", () => {
  it("is what a failure says, whatever was thrown", () => {
    expect(errorText(new DaemonError({ code: "nothing_staged", message: "nothing to commit" }))).toBe("nothing to commit");
    expect(errorText({ code: "pair_failed", message: "this phone is not paired with this Mac" })).toBe("this phone is not paired with this Mac");
    expect(errorText("ssh: connection refused")).toBe("ssh: connection refused");
    expect(errorText(42)).toBe("42");
  });
});
