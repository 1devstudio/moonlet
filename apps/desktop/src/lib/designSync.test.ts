import { describe, expect, it } from "vitest";
import type { ChatItem, DesignCard, DesignSystem } from "./protocol";
import { afterSyncLine, afterSyncShown, agentShown, changedRows, needsYou, orphanLine, proposalLabel, rewritingCard, stepBar, syncNotice } from "./designSync";

const system = (over: Partial<DesignSystem> = {}): DesignSystem => ({
  slug: "moonlet-desktop",
  name: "moonlet desktop",
  sources: ["/Users/alex/Workspace/moonlet"],
  synced_at: 1,
  synced_commit: "4db5585",
  cards: 9,
  layouts: 2,
  changed_sources: [],
  check_problems: 0,
  to_settle: 0,
  step: null,
  step_summary: null,
  error: null,
  agent: 7,
  last_sync: [],
  needs_you: null,
  steps: [],
  ...over,
});

const card = (path: string, name: string, over: Partial<DesignCard> = {}): DesignCard => ({
  group: "Custom",
  name,
  path,
  viewport: [900, 700],
  source: [],
  snippets: [],
  marker: "",
  problems: [],
  changed_sources: [],
  proposals: [],
  edited_by_hand: false,
  orphaned: false,
  kept: false,
  ...over,
});

const reported = system({
  step: "cards",
  step_summary: "1 of 3",
  steps: [
    { step: "inventory", summary: "3 changed, 1 new, 1 gone" },
    { step: "tokens", summary: "no change" },
    { step: "cards", summary: "1 of 3" },
  ],
});

describe("the sync step bar (X64)", () => {
  it("shows each step's result, the one at work, and the steps to come", () => {
    expect(stepBar(reported, true)).toEqual([
      { step: "inventory", label: "Inventory", state: "done", summary: "3 changed, 1 new, 1 gone" },
      { step: "tokens", label: "Tokens", state: "done", summary: "no change" },
      { step: "cards", label: "Cards", state: "current", summary: "1 of 3" },
      { step: "layouts", label: "Layouts", state: "pending", summary: null },
    ]);
  });

  it("starts on Inventory before the agent reports a step", () => {
    expect(stepBar(system({ synced_at: null }), true)?.map((s) => s.state)).toEqual(["current", "pending", "pending", "pending"]);
  });

  it("reads Needs you with the question's first line while the agent waits", () => {
    const waiting = { ...reported, needs_you: { kind: "question" as const, text: "Two button sets: which is current?\nThe old one is in legacy/." } };
    expect(stepBar(waiting, true)?.[2]).toEqual({ step: "cards", label: "Cards", state: "needs", summary: "Two button sets: which is current?" });
  });

  it("says a sync stopped before it was recorded, and shows nothing when no sync is under way", () => {
    expect(stepBar(reported, false)?.[2]).toEqual({ step: "cards", label: "Cards", state: "stopped", summary: "1 of 3" });
    expect(stepBar(system(), false)).toBeNull();
  });
});

describe("after a sync (X64)", () => {
  const cards = [
    card("components/custom/session-row/session-row.html", "Session row", { edited_by_hand: true, proposals: ["components/custom/session-row/session-row.proposed.html"] }),
    card("components/custom/toolbar/toolbar.html", "Toolbar", { orphaned: true }),
    card("components/custom/old/old.html", "Old", { orphaned: true, kept: true }),
    card("components/buttons/button/button.html", "Button", { source: ["src/ui.tsx"] }),
  ];
  const synced = system({
    last_sync: [
      { path: "components/buttons/button/button.html", change: "rewritten", sources: ["src/ui.tsx"] },
      { path: "components/custom/turn-footer/turn-footer.html", change: "rewritten", sources: ["src/AgentView.tsx"] },
      { path: "components/forms/kbd/kbd.html", change: "new", sources: ["src/ui.tsx"] },
      { path: "components/custom/gone/gone.html", change: "removed", sources: [] },
    ],
  });

  it("sums up what it did and what is left to the user", () => {
    expect(afterSyncLine(synced, cards)).toBe("2 cards rewritten, 1 new, 1 removed, 1 change to settle, 1 orphaned. 0 check problems.");
    expect(afterSyncLine(system({ last_sync: [{ path: "a.html", change: "new", sources: [] }], check_problems: 2 }), [])).toBe("1 new. 2 check problems.");
  });

  it("lists a card edited by hand beside its proposal, and an orphan not kept", () => {
    expect(needsYou(cards)).toEqual([
      { kind: "edited", card: cards[0], proposal: "components/custom/session-row/session-row.proposed.html" },
      { kind: "orphaned", card: cards[1], proposal: null },
    ]);
  });

  it("lists an orphan that also has the sync's proposals both ways, so it can be removed too", () => {
    const both = card("components/custom/bar/bar.html", "Bar", { orphaned: true, proposals: ["components/custom/bar/bar.proposed.css"] });
    expect(needsYou([both]).map((i) => i.kind)).toEqual(["edited", "orphaned"]);
  });

  it("labels the sync's version, and says what an orphan was made from", () => {
    expect(proposalLabel(needsYou(cards)[0])).toBe("session-row.proposed.html");
    const cssOnly = card("components/custom/bar/bar.html", "Bar", { proposals: ["components/custom/bar/bar.proposed.css", "components/custom/bar/bar.proposed.prompt.md"] });
    expect(proposalLabel(needsYou([cssOnly])[0])).toBe("bar.proposed.css, bar.proposed.prompt.md");
    expect(orphanLine(card("components/custom/toolbar/toolbar.html", "Toolbar", { source: ["apps/desktop/src/components/Toolbar.tsx"] }))).toBe(
      "Its source Toolbar.tsx was deleted. Designs that inserted it keep their copy.",
    );
    expect(orphanLine(card("components/custom/toolbar/toolbar.html", "Toolbar", { source: ["a/One.tsx", "b/Two.tsx"] }))).toBe(
      "Its sources One.tsx, Two.tsx were deleted. Designs that inserted it keep their copy.",
    );
  });

  it("sums up a sync that finished while the app runs, even one that changed nothing, and one that left something", () => {
    const started = 1_000;
    expect(afterSyncShown(system({ synced_at: 2_000 }), [], started)).toBe(true);
    expect(afterSyncLine(system({ synced_at: 2_000 }), [])).toBe("Nothing changed. 0 check problems.");
    expect(afterSyncShown(system({ synced_at: 500 }), [], started)).toBe(false);
    expect(afterSyncShown(system({ synced_at: 500 }), cards, started)).toBe(true);
    expect(afterSyncShown(system({ synced_at: null }), cards, started)).toBe(false);
  });

  it("lists what it changed, each with its name and sources", () => {
    expect(changedRows(synced, cards)).toEqual([
      { path: "components/buttons/button/button.html", label: "Rewritten", name: "Button", sources: "ui.tsx", open: true },
      { path: "components/custom/turn-footer/turn-footer.html", label: "Rewritten", name: "turn-footer", sources: "AgentView.tsx", open: false },
      { path: "components/forms/kbd/kbd.html", label: "New", name: "kbd", sources: "ui.tsx", open: false },
      { path: "components/custom/gone/gone.html", label: "Removed", name: "gone", sources: "", open: false },
    ]);
  });
});

describe("the docked sync agent (X64)", () => {
  it("opens by itself while the agent asks something, even when hidden", () => {
    expect(agentShown(false, system())).toBe(true);
    expect(agentShown(true, system())).toBe(false);
    expect(agentShown(true, system({ needs_you: { kind: "question", text: "Which?" } }))).toBe(true);
  });
});

describe("the card a sync is writing (X64)", () => {
  const tool = (name: string, file_path: string, status: "running" | "ok"): ChatItem => ({ id: file_path + status, kind: "tool", text: "", ts: 0, tool: { name, summary: "", input: { file_path }, status } });
  const dir = "/Users/alex/.moonlet/design/w1/systems/moonlet-desktop";

  it("is the card its running Write or Edit is on", () => {
    expect(rewritingCard([tool("Write", `${dir}/components/buttons/button/button.html`, "running")], dir)).toBe("components/buttons/button/button.html");
    expect(rewritingCard([tool("Edit", `${dir}/components/buttons/button/button.css`, "running")], dir)).toBe("components/buttons/button/button.html");
  });

  it("is none once the write is done, or for a file outside a card", () => {
    expect(rewritingCard([tool("Write", `${dir}/components/buttons/button/button.html`, "ok")], dir)).toBeNull();
    expect(rewritingCard([tool("Write", `${dir}/tokens/colors.css`, "running")], dir)).toBeNull();
    expect(rewritingCard([tool("Read", `${dir}/components/buttons/button/button.html`, "running")], dir)).toBeNull();
  });
});

describe("the sync agent's notifications (X64, X65)", () => {
  it("say when it asks, when it needs an approval, and when the sync is done", () => {
    // `state` is the event a session's would be (X47), for the same settings.
    expect(syncNotice(system(), system({ needs_you: { kind: "question", text: "Which button set is current?" } }))).toEqual({
      title: "Design · moonlet desktop",
      body: "asks: Which button set is current?",
      state: "blocked",
    });
    expect(syncNotice(system(), system({ needs_you: { kind: "approval", text: "Bash: rm -r .cache" } }))).toEqual({
      title: "Design · moonlet desktop",
      body: "needs your approval: Bash: rm -r .cache",
      state: "blocked",
    });
    expect(syncNotice(system({ synced_at: 1 }), system({ synced_at: 2, to_settle: 2 }))).toEqual({ title: "Design · moonlet desktop", body: "moonlet desktop synced · 2 to settle", state: "done" });
    expect(syncNotice(system({ synced_at: 1 }), system({ synced_at: 2 }))).toEqual({ title: "Design · moonlet desktop", body: "moonlet desktop synced", state: "done" });
  });

  it("say nothing for the same question, or nothing new", () => {
    const asking = system({ needs_you: { kind: "question", text: "Which?" } });
    expect(syncNotice(asking, asking)).toBeNull();
    expect(syncNotice(system(), system({ step: "tokens" }))).toBeNull();
  });
});
