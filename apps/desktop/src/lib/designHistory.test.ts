import { describe, expect, it } from "vitest";
import { historyRows, previewBar, previewStep, snapshotTime } from "./designHistory";
import type { DesignSnapshot } from "./protocol";

// Local times, so the expected hours hold in any time zone.
const at = (day: number, h: number, m: number) => new Date(2026, 9, day, h, m).getTime();
const NOW = at(25, 10, 45);

const SNAPSHOTS: DesignSnapshot[] = [
  { n: 6, time: at(25, 10, 41), type: "agent_turn", summary: "Wrote git-a.html and git-b.html · 3 pages", pages: ["index", "git-a", "git-b"] },
  { n: 5, time: at(25, 10, 33), type: "edits_by_hand", summary: "Moved section m24, restyled h2 m25, text of m30", pages: ["index"] },
  { n: 4, time: at(25, 10, 12), type: "restored", summary: "", from: { n: 3, time: at(25, 9, 58) }, pages: ["index"] },
];

describe("the History tab (X65)", () => {
  it("lists each snapshot with its type, summary and time, as design.history gives them, newest first", () => {
    expect(historyRows(SNAPSHOTS, NOW)).toEqual([
      { n: 6, kind: "agent_turn", title: "Agent turn", summary: "Wrote git-a.html and git-b.html · 3 pages", time: "10:41" },
      { n: 5, kind: "edits_by_hand", title: "Edits by hand", summary: "Moved section m24, restyled h2 m25, text of m30", time: "10:33" },
      { n: 4, kind: "restored", title: "Restored snapshot 3", summary: "From 09:58", time: "10:12" },
    ]);
  });

  it("says a time of today as its hour, and one of an earlier day with its date", () => {
    expect(snapshotTime(at(25, 9, 5), NOW)).toBe("09:05");
    expect(snapshotTime(at(24, 18, 30), NOW)).toBe("Oct 24, 18:30");
  });
});

describe("previewing a snapshot (X65)", () => {
  it("names the previewed snapshot's time and type for the blue bar", () => {
    expect(previewBar(SNAPSHOTS[1], NOW)).toEqual({ time: "10:33", type: "edits by hand" });
    expect(previewBar(SNAPSHOTS[0], NOW)).toEqual({ time: "10:41", type: "agent turn" });
    expect(previewBar(SNAPSHOTS[2], NOW)).toEqual({ time: "10:12", type: "restored snapshot 3" });
  });

  it("previews the snapshot picked, and goes back to current on Back to current, a restore, or once it is no longer listed", () => {
    expect(previewStep(null, { kind: "pick", n: 5 })).toEqual({ n: 5 });
    expect(previewStep({ n: 5 }, { kind: "pick", n: 6 })).toEqual({ n: 6 });
    expect(previewStep({ n: 5 }, { kind: "back" })).toBeNull();
    expect(previewStep({ n: 5 }, { kind: "restored" })).toBeNull();
    // Listed again with it, it stays; rotated out of the last 50, it goes.
    expect(previewStep({ n: 5 }, { kind: "listed", snapshots: SNAPSHOTS })).toEqual({ n: 5 });
    expect(previewStep({ n: 1 }, { kind: "listed", snapshots: SNAPSHOTS })).toBeNull();
    expect(previewStep(null, { kind: "listed", snapshots: SNAPSHOTS })).toBeNull();
  });
});
