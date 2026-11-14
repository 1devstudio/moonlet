import { describe, expect, it } from "vitest";
import { agentReadiness, nextMode, resolveMode, resolvePlanMode, tabAgent , tuiCommand } from "./agents";

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

describe("agentReadiness (T8)", () => {
  const started = { created_at: 1000, last_output_at: 1000 };

  it("waits until a new agent has printed something", () => {
    expect(agentReadiness(started)).toBe("waiting");
    expect(agentReadiness({ ...started, last_output_at: 1500 })).toBe("ready");
  });

  it("gives up on an agent that exited or is gone", () => {
    expect(agentReadiness({ ...started, exit: { code: 1, signal: null } })).toBe("gone");
    expect(agentReadiness(undefined)).toBe("gone");
  });
});

describe("resolvePlanMode (X24)", () => {
  it("keeps auto and acceptEdits", () => {
    expect(resolvePlanMode("auto")).toBe("auto");
    expect(resolvePlanMode("acceptEdits")).toBe("acceptEdits");
  });

  it("reads a missing or unknown value as auto", () => {
    for (const v of [undefined, null, "", "manual", "plan", "bypassPermissions", 3]) expect(resolvePlanMode(v)).toBe("auto");
  });
});

describe("tabAgent", () => {
  it("opens the session's agent, or Claude when it has none (X38)", () => {
    expect(tabAgent("codex")).toBe("codex");
    expect(tabAgent("claude")).toBe("claude");
    expect(tabAgent(null)).toBe("claude");
    expect(tabAgent("none")).toBe("claude");
    expect(tabAgent("")).toBe("claude");
  });
});

describe("the TUI a chat opens in a terminal (X7, X103)", () => {
  it("resumes Claude's conversation in the footer's mode, with --chrome when the host's switch is on", () => {
    expect(tuiCommand("claude", "s1", "plan", false)).toEqual(["claude", "--resume", "s1", "--permission-mode", "plan"]);
    expect(tuiCommand("claude", "s1", "plan", true)).toEqual(["claude", "--resume", "s1", "--permission-mode", "plan", "--chrome"]);
    expect(tuiCommand("claude", "s1", "bypassPermissions", false)).toEqual(["claude", "--resume", "s1", "--permission-mode", "bypassPermissions"]);
    expect(tuiCommand("claude", "s1", "yolo", false)).toEqual(["claude", "--resume", "s1"]);
    expect(tuiCommand("claude", "s1", null, true)).toEqual(["claude", "--resume", "s1", "--chrome"]);
  });

  it("resumes Codex's thread without Claude's flags", () => {
    expect(tuiCommand("codex", "th9", "plan", true)).toEqual(["codex", "resume", "th9"]);
  });
});
