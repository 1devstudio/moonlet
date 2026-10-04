import { describe, expect, it } from "vitest";
import { focusThrottle, needsPrPoll } from "./prPoll";

describe("needsPrPoll", () => {
  it("stops polling a session once its PR is merged", () => {
    expect(needsPrPoll({ state: "merged" })).toBe(false);
  });

  it("keeps polling open and closed PRs, sessions without a PR, and sessions not polled yet", () => {
    expect(needsPrPoll({ state: "open" })).toBe(true);
    expect(needsPrPoll({ state: "closed" })).toBe(true);
    expect(needsPrPoll(null)).toBe(true);
    expect(needsPrPoll(undefined)).toBe(true);
  });

  it("polls only open PRs on the minute poll", () => {
    expect(needsPrPoll({ state: "open" }, { openOnly: true })).toBe(true);
    expect(needsPrPoll({ state: "closed" }, { openOnly: true })).toBe(false);
    expect(needsPrPoll({ state: "merged" }, { openOnly: true })).toBe(false);
    expect(needsPrPoll(null, { openOnly: true })).toBe(false);
    expect(needsPrPoll(undefined, { openOnly: true })).toBe(false);
  });
});

describe("focusThrottle", () => {
  it("refreshes on the first focus, then at most once per gap", () => {
    const due = focusThrottle(15_000);
    expect(due(100_000)).toBe(true);
    expect(due(105_000)).toBe(false);
    expect(due(114_999)).toBe(false);
    expect(due(115_000)).toBe(true);
    expect(due(120_000)).toBe(false);
  });
});
