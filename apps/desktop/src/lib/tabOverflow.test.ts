import { describe, expect, it } from "vitest";
import { filterTabs, hiddenTabs, revealScroll, scrollStep, tabEdges, tabStatus, wheelScroll } from "./tabOverflow";

describe("tabEdges (X94)", () => {
  it("shows no fade when every tab fits", () => {
    expect(tabEdges({ scrollLeft: 0, clientWidth: 560, scrollWidth: 560 })).toEqual({ left: false, right: false });
  });

  it("shows the right fade at the start of a row that overflows, both in the middle, the left at the end", () => {
    expect(tabEdges({ scrollLeft: 0, clientWidth: 560, scrollWidth: 1008 })).toEqual({ left: false, right: true });
    expect(tabEdges({ scrollLeft: 300, clientWidth: 560, scrollWidth: 1008 })).toEqual({ left: true, right: true });
    expect(tabEdges({ scrollLeft: 448, clientWidth: 560, scrollWidth: 1008 })).toEqual({ left: true, right: false });
  });

  it("ignores the half pixel WebKit leaves at either end", () => {
    expect(tabEdges({ scrollLeft: 0.5, clientWidth: 560, scrollWidth: 1008.5 })).toEqual({ left: false, right: true });
    expect(tabEdges({ scrollLeft: 447.5, clientWidth: 560, scrollWidth: 1008 })).toEqual({ left: true, right: false });
  });
});

describe("hiddenTabs (X94)", () => {
  // Nine tabs at their 112 px minimum, laid from x = 20, in a row from 20 to 508 (the design's "Overflow, start").
  const nine = (offset: number) => Array.from({ length: 9 }, (_, i) => ({ left: 20 + offset + 112 * i, right: 20 + offset + 112 * (i + 1) }));
  const row = { left: 20, right: 508 };

  it("counts nothing when every tab is in the row", () => {
    expect(hiddenTabs(row, nine(0).slice(0, 4))).toBe(0);
  });

  it("counts the tabs wholly or partly out of view at the start, the badge's 5", () => {
    expect(hiddenTabs(row, nine(0))).toBe(5);
  });

  it("counts both sides when scrolled to the middle", () => {
    // Scrolled 300 px: tabs 0–2 are cut on the left, 7 and 8 on the right.
    expect(hiddenTabs(row, nine(-300))).toBe(5);
  });

  it("leaves out a tab with no width (one still being laid out)", () => {
    expect(hiddenTabs(row, [...nine(0).slice(0, 4), { left: 600, right: 600 }])).toBe(0);
  });
});

describe("revealScroll (X94)", () => {
  // A 488 px row of 112 px tabs: tab i starts at 112 * i.
  const tab = (i: number) => ({ offsetLeft: 112 * i, offsetWidth: 112 });

  it("leaves the row where it is when the tab is in view", () => {
    expect(revealScroll(tab(1), { scrollLeft: 0, clientWidth: 488 })).toBeNull();
  });

  it("scrolls a tab past the right edge into view, 40 px clear of it", () => {
    expect(revealScroll(tab(8), { scrollLeft: 0, clientWidth: 488 })).toBe(560);
  });

  it("scrolls a tab past the left edge into view, 40 px clear of it", () => {
    expect(revealScroll(tab(1), { scrollLeft: 300, clientWidth: 488 })).toBe(72);
  });

  it("never scrolls before the start", () => {
    expect(revealScroll(tab(0), { scrollLeft: 20, clientWidth: 488 })).toBe(0);
  });
});

describe("wheelScroll (X94)", () => {
  it("turns a vertical wheel into a sideways scroll", () => {
    expect(wheelScroll(0, 48)).toBe(48);
    expect(wheelScroll(2, -30)).toBe(-30);
  });

  it("leaves a sideways swipe to the row itself", () => {
    expect(wheelScroll(40, 6)).toBe(0);
  });
});

describe("scrollStep (X94)", () => {
  it("scrolls a chevron's click by 60 % of the row", () => {
    expect(scrollStep(500)).toBe(300);
  });

  it("scrolls at least 160 px in a narrow row", () => {
    expect(scrollStep(200)).toBe(160);
  });
});

describe("tabStatus (X94)", () => {
  it("says an agent is running or needs input, and nothing while it is idle", () => {
    expect(tabStatus({ kind: "terminal", agentState: "working" })).toEqual({ tone: "working", label: "Running" });
    expect(tabStatus({ kind: "terminal", agentState: "blocked" })).toEqual({ tone: "blocked", label: "Needs input" });
    expect(tabStatus({ kind: "terminal", agentState: "idle" })).toEqual({ tone: "idle", label: "" });
  });

  it("says a terminal whose process ended has exited, whatever its agent said last", () => {
    expect(tabStatus({ kind: "terminal", agentState: "working", exited: true })).toEqual({ tone: "idle", label: "Exited" });
  });

  it("says a file with edits not saved is unsaved", () => {
    expect(tabStatus({ kind: "file", dirty: true })).toEqual({ tone: "unsaved", label: "Unsaved" });
    expect(tabStatus({ kind: "file", dirty: false })).toEqual({ tone: "idle", label: "" });
  });

  it("says a job is running until it ends, then done on exit 0 and failed otherwise", () => {
    expect(tabStatus({ kind: "job", state: { kind: "waiting", for: "a worker" } })).toEqual({ tone: "working", label: "Running" });
    expect(tabStatus({ kind: "job", state: { kind: "bringing_back" } })).toEqual({ tone: "working", label: "Running" });
    expect(tabStatus({ kind: "job", state: { kind: "done", exit: 0 } })).toEqual({ tone: "done", label: "Done" });
    expect(tabStatus({ kind: "job", state: { kind: "done", exit: 2 } })).toEqual({ tone: "error", label: "Failed" });
    expect(tabStatus({ kind: "job", state: { kind: "lost" } })).toEqual({ tone: "error", label: "Failed" });
  });

  it("says nothing of a diff, or of a terminal or job not known yet", () => {
    expect(tabStatus({ kind: "diff" })).toEqual({ tone: "idle", label: "" });
    expect(tabStatus({ kind: "terminal" })).toEqual({ tone: "idle", label: "" });
    expect(tabStatus({ kind: "job" })).toEqual({ tone: "idle", label: "" });
  });
});

describe("filterTabs (X94)", () => {
  const tabs = [{ name: "claude" }, { name: "claude · tests" }, { name: "codex · migration" }, { name: "zsh" }, { name: "pnpm dev" }];

  it("lists every tab with no filter, or a blank one", () => {
    expect(filterTabs(tabs, "")).toEqual(tabs);
    expect(filterTabs(tabs, "  ")).toEqual(tabs);
  });

  it("keeps the tabs whose name has the filter, in any case", () => {
    expect(filterTabs(tabs, "Claude").map((t) => t.name)).toEqual(["claude", "claude · tests"]);
    expect(filterTabs(tabs, "dev").map((t) => t.name)).toEqual(["pnpm dev"]);
  });

  it("lists none when nothing matches", () => {
    expect(filterTabs(tabs, "vim")).toEqual([]);
  });
});
