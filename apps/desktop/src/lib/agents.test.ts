import { describe, expect, it } from "vitest";
import { nextMode, resolveMode } from "./agents";

describe("nextMode", () => {
  it("cycles manual, accept edits, plan, auto", () => {
    expect(nextMode(undefined, false)).toBe("acceptEdits");
    expect(nextMode("manual", false)).toBe("acceptEdits");
    expect(nextMode("acceptEdits", false)).toBe("plan");
    expect(nextMode("plan", false)).toBe("auto");
    expect(nextMode("auto", false)).toBe("manual");
  });

  it("only includes bypass once it is enabled", () => {
    expect(nextMode("auto", true)).toBe("bypassPermissions");
    expect(nextMode("bypassPermissions", true)).toBe("manual");
  });
});

describe("resolveMode", () => {
  it("keeps the modes the picker offers", () => {
    for (const m of ["auto", "manual", "acceptEdits", "plan"]) expect(resolveMode(m)).toBe(m);
  });

  it("falls back to manual for missing, unknown and bypass values", () => {
    for (const v of [undefined, null, "", "yolo", 3, "bypassPermissions"]) expect(resolveMode(v)).toBe("manual");
  });
});
