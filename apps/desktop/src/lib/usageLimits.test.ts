import { describe, expect, it } from "vitest";
import type { ClaudeUsage, UsageLimit } from "./protocol";
import { usageView } from "./usageLimits";

// Thursday 27 November 2026, 11:30 in the local time zone.
const now = new Date(2026, 10, 27, 11, 30).getTime();
const at = (...d: [number, number, number, number, number]) => new Date(...d).toISOString();

const limit = (kind: string, percent: number, resets: string | null, more: Partial<UsageLimit> = {}): UsageLimit => ({
  kind,
  group: kind === "session" ? "session" : "weekly",
  model: null,
  percent,
  severity: "normal",
  resets_at: resets,
  ...more,
});

// The limits of the X115 screenshot: Team plan, 48% / 33% / Fable 2%.
const team: ClaudeUsage = {
  plan: "team",
  limits: [
    limit("session", 48, at(2026, 10, 27, 14, 40)),
    limit("weekly_all", 33, at(2026, 11, 2, 5, 0)),
    limit("weekly_scoped", 2, at(2026, 11, 2, 5, 0), { model: "Fable" }),
  ],
  at: now - 3 * 60_000,
};

describe("usageView (X115)", () => {
  it("shows the current session in the footer, and every limit in the card", () => {
    const v = usageView(team, now, "en-US");
    expect(v.footer).toBe("48%");
    expect(v.title).toBe("Claude usage: current session 48%, weekly 33%");
    expect(v.ring).toBe(48);
    expect(v.plan).toBe("Team");
    expect(v.updated).toBe("Updated 3 min ago");
    expect(v.sections).toEqual([
      { heading: "Session", rows: [{ label: "Current session", percent: 48, text: "48%", resets: "Resets 2:40 PM", level: "ok" }] },
      {
        heading: "Weekly",
        rows: [
          { label: "All models", percent: 33, text: "33%", resets: "Resets Wed 5:00 AM", level: "ok" },
          { label: "Fable", percent: 2, text: "2%", resets: "Resets Wed 5:00 AM", level: "ok" },
        ],
      },
    ]);
  });

  it("names a reset more than six days away by its date", () => {
    const v = usageView({ ...team, limits: [limit("weekly_all", 10, at(2026, 11, 9, 5, 0))] }, now, "en-US");
    expect(v.sections[0].rows[0].resets).toBe("Resets Dec 9");
  });

  it("shows no percentage for a limit whose reset has passed", () => {
    const v = usageView({ ...team, limits: [limit("session", 97, at(2026, 10, 27, 11, 0)), limit("weekly_all", 33, at(2026, 11, 2, 5, 0))] }, now, "en-US");
    expect(v.footer).toBe("—");
    expect(v.ring).toBe(0);
    expect(v.sections[0].rows[0]).toEqual({ label: "Current session", percent: 0, text: "—", resets: "Reset at 11:00 AM", level: "ok" });
  });

  it("warns from 80% or Claude's warning, and alarms at 100% or Claude's critical", () => {
    const level = (percent: number, severity = "normal") => usageView({ ...team, limits: [limit("session", percent, null, { severity })] }, now).sections[0].rows[0].level;
    expect(level(79)).toBe("ok");
    expect(level(80)).toBe("warn");
    expect(level(40, "warning")).toBe("warn");
    expect(level(100)).toBe("error");
    expect(level(60, "critical")).toBe("error");
    // The footer's ring takes the current session's level.
    expect(usageView({ ...team, limits: [limit("session", 85, null), limit("weekly_all", 100, null)] }, now).ringLevel).toBe("warn");
  });

  it("leaves out what Claude did not report", () => {
    const v = usageView({ plan: null, limits: [limit("weekly_all", 5, null)], at: now }, now);
    expect(v.footer).toBe("5%");
    expect(v.plan).toBeNull();
    expect(v.updated).toBe("Updated just now");
    expect(v.sections).toEqual([{ heading: "Weekly", rows: [{ label: "All models", percent: 5, text: "5%", resets: null, level: "ok" }] }]);
  });
});
