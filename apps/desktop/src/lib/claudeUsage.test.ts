import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeUsage } from "./protocol";

const daemon = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./daemon", () => ({ rpc: daemon.rpc }));
import { watchClaudeUsage } from "./claudeUsage";

const usage = (percent: number): ClaudeUsage => ({ plan: "max", limits: [{ kind: "session", group: "session", model: null, percent, severity: "normal", resets_at: null }], at: 1 });

describe("watchClaudeUsage (X115)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    daemon.rpc.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("asks at once and every 5 minutes, and afresh on refresh", async () => {
    daemon.rpc.mockResolvedValue(usage(49));
    const got: (ClaudeUsage | null)[] = [];
    const w = watchClaudeUsage("mac", "ws-1", (u) => got.push(u));
    await vi.advanceTimersByTimeAsync(0);
    expect(daemon.rpc.mock.calls).toEqual([["mac", "claude.usage", { workspace: "ws-1", refresh: false }]]);
    expect(got).toEqual([usage(49)]);

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(daemon.rpc).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(daemon.rpc.mock.calls[1]).toEqual(["mac", "claude.usage", { workspace: "ws-1", refresh: false }]);

    w.refresh();
    expect(daemon.rpc.mock.calls[2]).toEqual(["mac", "claude.usage", { workspace: "ws-1", refresh: true }]);

    // Stopped, as when the footer goes or the workspace changes, it asks no more.
    w.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(daemon.rpc).toHaveBeenCalledTimes(3);
  });

  it("drops an answer that comes after a newer ask's, and a failed ask", async () => {
    let slow!: (u: ClaudeUsage) => void;
    daemon.rpc.mockReturnValueOnce(new Promise((r) => (slow = r))).mockResolvedValueOnce(usage(60)).mockRejectedValueOnce(new Error("unknown method"));
    const got: (ClaudeUsage | null)[] = [];
    const w = watchClaudeUsage("mac", null, (u) => got.push(u));
    expect(daemon.rpc.mock.calls[0]).toEqual(["mac", "claude.usage", { refresh: false }]);
    w.refresh();
    await vi.advanceTimersByTimeAsync(0);
    slow(usage(10));
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual([usage(60)]);

    w.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual([usage(60)]);
  });
});
