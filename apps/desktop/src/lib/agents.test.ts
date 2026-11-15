import { describe, expect, it } from "vitest";
import { agentReadiness, effortAfter, effortsFor, modelLabel, modelMenu, nextMode, resolveMode, resolvePlanMode, tabAgent , tuiCommand } from "./agents";
import type { ClaudeModel } from "./protocol";

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

/** X105: Claude Code 2.1.325's answer to `initialize`, its `models` as the daemon gives them. */
const CAPTURED: ClaudeModel[] = [
  { value: "default", label: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks", resolved: "claude-opus-5-5", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { value: "opus", label: "Opus 5.5", description: "For complex work and everyday tasks", resolved: "claude-opus-5-5", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { value: "fable", label: "Fable 5.2", description: "For your toughest challenges", resolved: "claude-fable-5-2", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { value: "sonnet", label: "Sonnet 5.5", description: "Most efficient for simpler tasks", resolved: "claude-sonnet-5-5", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { value: "haiku", label: "Haiku 5.5", description: "Fastest for quick answers", resolved: "claude-haiku-5-5", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { value: "claude-fable-5-1", label: "Fable 5.1", description: "Most capable for your hardest and longest-running tasks", resolved: "claude-fable-5-1", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5", description: "Fastest for quick answers", resolved: "claude-haiku-4-5-20251001", efforts: [] },
  { value: "claude-sonnet-5", label: "Sonnet 5", description: "Efficient for routine tasks", resolved: "claude-sonnet-5", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { value: "claude-opus-5", label: "Opus 5", description: "Best for everyday, complex tasks", resolved: "claude-opus-5", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { value: "claude-fable-5", label: "Fable 5", description: "Most capable for your hardest and longest-running tasks", resolved: "claude-fable-5", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { value: "claude-opus-4-8", label: "Opus 4.8", description: "Best for everyday, complex tasks", resolved: "claude-opus-4-8", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { value: "claude-opus-4-7", label: "Opus 4.7", description: "Best for everyday, complex tasks", resolved: "claude-opus-4-7", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { value: "claude-opus-4-6", label: "Opus 4.6", description: "Best for everyday, complex tasks", resolved: "claude-opus-4-6", efforts: ["low", "medium", "high", "max"] },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6", description: "Efficient for routine tasks", resolved: "claude-sonnet-4-6", efforts: ["low", "medium", "high", "max"] },
];

describe("modelMenu (X105)", () => {
  it("puts the aliases at the top and the pinned models under More models", () => {
    const menu = modelMenu(CAPTURED);
    expect(menu.latest).toEqual([
      { id: "opus", label: "Opus 5.5" },
      { id: "fable", label: "Fable 5.2" },
      { id: "sonnet", label: "Sonnet 5.5" },
      { id: "haiku", label: "Haiku 5.5" },
    ]);
    expect(menu.more.map((m) => m.label)).toEqual(["Fable 5.1", "Haiku 4.5", "Sonnet 5", "Opus 5", "Fable 5", "Opus 4.8", "Opus 4.7", "Opus 4.6", "Sonnet 4.6"]);
    expect(menu.more[1]).toEqual({ id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" });
  });

  it("falls back to the aliases without versions", () => {
    for (const models of [undefined, []]) {
      expect(modelMenu(models)).toEqual({
        latest: [
          { id: "opus", label: "Opus" },
          { id: "fable", label: "Fable" },
          { id: "sonnet", label: "Sonnet" },
          { id: "haiku", label: "Haiku" },
        ],
        more: [],
      });
    }
  });
});

describe("modelLabel (X105)", () => {
  it("labels a model by Claude Code's name, else by its id", () => {
    expect(modelLabel(CAPTURED, "fable")).toBe("Fable 5.2");
    expect(modelLabel(CAPTURED, "claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelLabel(CAPTURED, "claude-opus-4-1[1m]")).toBe("claude-opus-4-1[1m]");
    expect(modelLabel([], "fable")).toBe("Fable");
    expect(modelLabel(undefined, "claude-opus-5")).toBe("claude-opus-5");
  });
});

describe("effortsFor (X105)", () => {
  it("offers the efforts the chosen model supports", () => {
    expect(effortsFor(CAPTURED, "claude-opus-4-6").map((e) => e.label)).toEqual(["Low", "Medium", "High", "Max"]);
    expect(effortsFor(CAPTURED, "fable").map((e) => e.id)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortsFor(CAPTURED, "claude-haiku-4-5-20251001")).toEqual([]);
    // A model the list does not have, or no list, offers all five.
    expect(effortsFor(CAPTURED, "claude-opus-4-1").map((e) => e.id)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortsFor(undefined, "claude-opus-4-6").map((e) => e.id)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});

describe("effortAfter (X105)", () => {
  it("keeps the effort when the new model supports it, else High", () => {
    expect(effortAfter(CAPTURED, "fable", "xhigh")).toBe("xhigh");
    expect(effortAfter(CAPTURED, "claude-opus-4-6", "xhigh")).toBe("high");
    expect(effortAfter(CAPTURED, "claude-opus-4-6", "max")).toBe("max");
    expect(effortAfter(CAPTURED, "claude-haiku-4-5-20251001", "high")).toBeNull();
    expect(effortAfter(CAPTURED, "claude-sonnet-4-6", null)).toBe("high");
    expect(effortAfter(undefined, "opus", "xhigh")).toBe("xhigh");
  });
});
