import { describe, expect, it } from "vitest";
import type { DesignCard, DesignSystem } from "./protocol";
import { cardGroups, cardUrl, changedBanner, fitScale, fixMessage, headerLine, variantsLabel } from "./designView";

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
      { name: "All", count: 11, problem: true },
      { name: "Foundations", count: 2, problem: false },
      { name: "Buttons", count: 2, problem: false },
      { name: "Forms", count: 2, problem: false },
      { name: "Custom", count: 3, problem: true },
      { name: "Layouts", count: 2, problem: false },
    ]);
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
});

describe("a card (X64, X65)", () => {
  it("is served from its workspace's design folder", () => {
    expect(cardUrl("w-1devstudio", "moonlet-desktop", "components/custom/session-row/session-row.html")).toBe(
      "moonlet-design://w-1devstudio/systems/moonlet-desktop/components/custom/session-row/session-row.html",
    );
    expect(cardUrl("w1", "s", "ui_kits/app/home screen.html")).toBe("moonlet-design://w1/systems/s/ui_kits/app/home%20screen.html");
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
