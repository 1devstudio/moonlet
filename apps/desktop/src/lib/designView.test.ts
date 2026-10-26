import { describe, expect, it } from "vitest";
import type { DesignCard, DesignSystem } from "./protocol";
import { cardGroups, cardUrl, changedBanner, fitScale, fixMessage, fixState, headerLine, listedCards, problemsLabel, rendersHere, statusLine, variantsLabel, visibleCards, zoomStep } from "./designView";

const NOW = 1_761_200_000_000;
const DAY = 86_400_000;

const card = (group: string, name: string, over: Partial<DesignCard> = {}): DesignCard => ({
  group,
  name,
  path: `components/${group.toLowerCase()}/${name.toLowerCase()}/${name.toLowerCase()}.html`,
  viewport: [900, 700],
  source: [],
  snippets: [],
  marker: `<!-- @dsCard group="${group}" name="${name}" -->`,
  problems: [],
  changed_sources: [],
  ...over,
});

const system = (over: Partial<DesignSystem> = {}): DesignSystem => ({
  slug: "moonlet-desktop",
  name: "moonlet desktop",
  sources: ["/Users/alex/Workspace/moonlet"],
  synced_at: NOW - 3 * DAY,
  synced_commit: "4db5585",
  cards: 9,
  layouts: 2,
  changed_sources: [],
  check_problems: 0,
  to_settle: 0,
  step: null,
  step_summary: null,
  error: null,
  agent: null,
  last_sync: [],
  needs_you: null,
  ...over,
});

const problem = { path: "", line: 14, kind: "unknown_token", message: "var(--color-selected-2) is not in tokens.css" };

describe("the design system view's groups (X64)", () => {
  it("are All, Foundations, the component groups by name, then Custom and Layouts, with counts and a dot for a check problem", () => {
    const cards = [
      card("Layouts", "Settings"),
      card("Custom", "Session row", { problems: [problem] }),
      card("Forms", "Field"),
      card("Buttons", "Button"),
      card("Foundations", "Colours"),
      card("Buttons", "Icon button"),
      card("Custom", "State glyph"),
      card("Foundations", "Type"),
      card("Layouts", "Home"),
      card("Forms", "Switch"),
      card("Custom", "Kbd"),
    ];
    expect(cardGroups(cards)).toEqual([
      { key: "", name: "All", count: 11, problem: true },
      { key: "Foundations", name: "Foundations", count: 2, problem: false },
      { key: "Buttons", name: "Buttons", count: 2, problem: false },
      { key: "Forms", name: "Forms", count: 2, problem: false },
      { key: "Custom", name: "Custom", count: 3, problem: true },
      { key: "Layouts", name: "Layouts", count: 2, problem: false },
    ]);
  });

  it("keeps a group a card names All apart from all the cards", () => {
    expect(cardGroups([card("All", "Everything"), card("Buttons", "Button")]).map((g) => [g.key, g.name, g.count])).toEqual([
      ["", "All", 2],
      ["All", "All", 1],
      ["Buttons", "Buttons", 1],
    ]);
  });
});

describe("the cards the view shows (X64)", () => {
  const cards = [card("Buttons", "Button", { changed_sources: ["src/ui.tsx"] }), card("Forms", "Field", { problems: [problem] }), card("Forms", "Switch")];
  const names = (v: ReturnType<typeof visibleCards>) => v.cards.map((c) => c.name);

  it("are a group's, or all of them", () => {
    expect(names(visibleCards(cards, { group: "Forms", onlyProblems: false, onlyChanged: false }))).toEqual(["Field", "Switch"]);
    expect(names(visibleCards(cards, { group: "", onlyProblems: false, onlyChanged: false }))).toEqual(["Button", "Field", "Switch"]);
  });

  it("are those with a check problem, or made from a changed source, while there are any", () => {
    expect(visibleCards(cards, { group: "", onlyProblems: true, onlyChanged: false })).toEqual({ cards: [cards[1]], onlyProblems: true, onlyChanged: false });
    expect(names(visibleCards(cards, { group: "", onlyProblems: false, onlyChanged: true }))).toEqual(["Button"]);
    // Fixed, or synced: the filter lets go, so the grid never goes blank with no way back.
    const fixed = cards.map((c) => ({ ...c, problems: [], changed_sources: [] }));
    expect(visibleCards(fixed, { group: "", onlyProblems: true, onlyChanged: true })).toEqual({ cards: fixed, onlyProblems: false, onlyChanged: false });
  });
});

describe("the design system view's header (X64)", () => {
  it("says where it is from, when it was synced and at which commit, and how many cards it has", () => {
    const projects = [{ path: "/Users/alex/Workspace/moonlet", name: "moonlet" }];
    expect(headerLine(system(), projects, 11, NOW)).toBe("From moonlet · synced 3 days ago at 4db5585 · 11 cards");
    expect(headerLine(system({ synced_at: null, synced_commit: null }), projects, 0, NOW)).toBe("From moonlet · not synced yet · 0 cards");
    // A source outside the workspace's projects goes by its folder name.
    expect(headerLine(system({ sources: ["/Users/alex/Workspace/moonlet", "/Users/alex/Workspace/changedeck"], synced_commit: null }), projects, 1, NOW)).toBe(
      "From moonlet, changedeck · synced 3 days ago · 1 card",
    );
  });
});

describe("the sources-changed banner (X64)", () => {
  it("names the changed sources and how many cards a sync rewrites", () => {
    const cards = [
      card("Custom", "Session row", { changed_sources: ["apps/desktop/src/components/Sidebar.tsx"] }),
      card("Buttons", "Button", { changed_sources: ["apps/desktop/src/components/ui.tsx"] }),
      card("Custom", "Agent", { changed_sources: ["apps/desktop/src/components/AgentView.tsx"] }),
      card("Forms", "Field"),
    ];
    const sys = system({ changed_sources: ["apps/desktop/src/components/Sidebar.tsx", "apps/desktop/src/components/ui.tsx", "apps/desktop/src/components/AgentView.tsx"] });
    expect(changedBanner(sys, cards)).toBe("3 sources changed since sync · Sidebar.tsx, ui.tsx, AgentView.tsx. A sync rewrites only the 3 cards made from them.");
    expect(changedBanner(system({ changed_sources: ["src/ui.tsx"] }), [card("Buttons", "Button", { changed_sources: ["src/ui.tsx"] })])).toBe(
      "1 source changed since sync · ui.tsx. A sync rewrites only the card made from it.",
    );
    expect(changedBanner(system(), cards.slice(3))).toBeNull();
  });

  it("says it right when two sources made one card, or none", () => {
    const two = system({ changed_sources: ["src/ui.tsx", "src/theme.ts"] });
    expect(changedBanner(two, [card("Buttons", "Button", { changed_sources: ["src/ui.tsx", "src/theme.ts"] })])).toBe(
      "2 sources changed since sync · ui.tsx, theme.ts. A sync rewrites only the card made from them.",
    );
    expect(changedBanner(two, [card("Buttons", "Button")])).toBe("2 sources changed since sync · ui.tsx, theme.ts. No card is made from them.");
  });
});

describe("the design system view's status (X64)", () => {
  it("says why it cannot be read, what its agent waits for, or the step a sync is at", () => {
    expect(statusLine(system({ error: "cannot read config.toml" }))).toBe("cannot read config.toml");
    expect(statusLine(system({ needs_you: { kind: "question", text: "Which button set is current?" } }))).toBe("Claude asks: Which button set is current?");
    expect(statusLine(system({ needs_you: { kind: "approval", text: "Bash: rm -r .cache" } }))).toBe("Claude needs your approval: Bash: rm -r .cache");
    expect(statusLine(system({ step: "cards", step_summary: "1 of 3" }))).toBe("Cards · 1 of 3");
    expect(statusLine(system({ step: "tokens" }))).toBe("Tokens");
    expect(statusLine(system())).toBeNull();
  });

  it("shows no cards of a system that cannot be read, whatever was listed before", () => {
    const listed = [card("Buttons", "Button")];
    expect(listedCards(system(), listed)).toBe(listed);
    expect(listedCards(system({ error: "cannot read config.toml" }), listed)).toBeUndefined();
  });

  it("counts check problems", () => {
    expect(problemsLabel(1)).toBe("1 check problem");
    expect(problemsLabel(3)).toBe("3 check problems");
  });

  it("renders cards only on this Mac, where their files are", () => {
    expect(rendersHere("local")).toBe(true);
    expect(rendersHere("studio-mini")).toBe(false);
  });
});

describe("a card (X64, X65)", () => {
  it("is served from its workspace's design folder", () => {
    expect(cardUrl("w-1devstudio", "moonlet-desktop", "components/custom/session-row/session-row.html")).toBe(
      "moonlet-design://w-1devstudio/systems/moonlet-desktop/components/custom/session-row/session-row.html",
    );
    expect(cardUrl("w1", "s", "ui_kits/app/home screen.html")).toBe("moonlet-design://w1/systems/s/ui_kits/app/home%20screen.html");
    // After a change in the system, a new address, so the frame loads it again.
    expect(cardUrl("w1", "s", "components/a/b/b.html", 3)).toBe("moonlet-design://w1/systems/s/components/a/b/b.html?v=3");
  });

  it("counts its variants", () => {
    expect(variantsLabel(card("Buttons", "Button", { snippets: ["a", "b", "c"] }))).toBe("3 variants");
    expect(variantsLabel(card("Buttons", "Button", { snippets: ["a"] }))).toBe("1 variant");
    expect(variantsLabel(card("Foundations", "Colours"))).toBe("");
  });

  it("fits its viewport into the space it has, at most at 200%", () => {
    expect(fitScale([320, 140], [1200, 800])).toBe(2);
    expect(fitScale([900, 700], [450, 700])).toBe(0.5);
    expect(fitScale([1440, 900], [720, 900])).toBe(0.5);
  });

  it("zooms by steps from 25% to 400%", () => {
    expect(zoomStep(1, 1)).toBe(1.5);
    expect(zoomStep(1, -1)).toBe(0.75);
    // From a fitted zoom, to the next step either way.
    expect(zoomStep(0.85, 1)).toBe(1);
    expect(zoomStep(0.85, -1)).toBe(0.75);
    expect(zoomStep(4, 1)).toBe(4);
    expect(zoomStep(0.25, -1)).toBe(0.25);
  });

  it("asks the sync agent to fix only while it runs, once at a time", () => {
    expect(fixState(7, false)).toEqual({ enabled: true, hint: null });
    expect(fixState(7, true)).toEqual({ enabled: false, hint: null });
    expect(fixState(null, false)).toEqual({ enabled: false, hint: "Its sync agent is not running. Sync starts it." });
  });

  it("names the file of a problem in the card's own .css or .prompt.md", () => {
    const c = card("Buttons", "Button", {
      path: "components/buttons/button/button.html",
      problems: [{ path: "components/buttons/button/button.css", line: 2, kind: "unknown_token", message: "var(--color-nope) is not defined" }],
    });
    expect(fixMessage(c)).toBe(
      "Fix the check problems of components/buttons/button/button.html, then run the check again:\n- components/buttons/button/button.css line 2: var(--color-nope) is not defined",
    );
  });

  it("asks the sync agent to fix its check problems by line", () => {
    const c = card("Custom", "Session row", {
      path: "components/custom/session-row/session-row.html",
      problems: [problem, { path: "", line: 20, kind: "external_url", message: "https://example.com/a.png is outside the design system" }],
    });
    expect(fixMessage(c)).toBe(
      "Fix the check problems of components/custom/session-row/session-row.html, then run the check again:\n- line 14: var(--color-selected-2) is not in tokens.css\n- line 20: https://example.com/a.png is outside the design system",
    );
  });
});
