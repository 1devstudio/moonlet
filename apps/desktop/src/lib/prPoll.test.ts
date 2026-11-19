import { describe, expect, it } from "vitest";
import { focusThrottle, knownPrs, latestPerKey, needsPrPoll } from "./prPoll";

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

  it("asks about a session with no PR, or a closed one, at most every 5 minutes (X107)", () => {
    const now = 10_000_000;
    expect(needsPrPoll(null, { checkedAt: now - 299_999, now })).toBe(false);
    expect(needsPrPoll({ state: "closed" }, { checkedAt: now - 60_000, now })).toBe(false);
    expect(needsPrPoll(null, { checkedAt: now - 300_000, now })).toBe(true);
    expect(needsPrPoll({ state: "closed" }, { checkedAt: now - 300_000, now })).toBe(true);
    // An open PR is asked about on every poll, and a merged one never.
    expect(needsPrPoll({ state: "open" }, { checkedAt: now - 1_000, now })).toBe(true);
    expect(needsPrPoll({ state: "merged" }, { checkedAt: now - 86_400_000, now })).toBe(false);
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

describe("latestPerKey", () => {
  it("drops a slower, older answer for the same session once a newer poll started", () => {
    const polls = latestPerKey();
    const sidebar = polls.start("local/s1");
    const button = polls.start("local/s1");
    expect(button()).toBe(true);
    expect(sidebar()).toBe(false);
  });

  it("keeps sessions independent", () => {
    const polls = latestPerKey();
    const s1 = polls.start("local/s1");
    polls.start("local/s2");
    expect(s1()).toBe(true);
  });
});

describe("knownPrs", () => {
  const merged = { number: 11, url: "https://github.com/acme/web/pull/11", state: "merged", title: "Gift card model", checks: [], review_decision: null, draft: false };
  const open = { ...merged, state: "open" };

  it("takes the daemon's saved PRs and when each was checked (X107)", () => {
    const got = knownPrs("local", {}, { s1: { pr: merged, checked_at: 1_000 }, s2: { pr: null, checked_at: 2_000 } });
    expect(got).toEqual({ prs: { "local/s1": merged, "local/s2": null }, checkedAt: { "local/s1": 1_000, "local/s2": 2_000 } });
  });

  it("keeps a PR the app has already polled over a saved one", () => {
    const got = knownPrs("local", { "local/s1": open }, { s1: { pr: merged, checked_at: 1_000 } });
    expect(got).toEqual({ prs: {}, checkedAt: {} });
  });
});
