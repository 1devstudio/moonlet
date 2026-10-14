import { describe, expect, it } from "vitest";
import { moveSelection, searchSettings, type SearchContext } from "./settingsSearch";
import { defaultTermSettings } from "./terminals";

const ctx: SearchContext = {
  settings: {
    term: defaultTermSettings,
    notifyWhenFocused: false,
    defaultMode: "auto",
    sounds: { blocked: "Glass", done: "Hero", error: "" },
    toolCalls: "collapsed",
    shortcuts: { commit: "alt+cmd+g" },
    planApproveMode: "auto",
    editorTheme: "github-dark",
    autoUpdateCheck: true,
  },
  appVersion: "0.1.16",
  claudeInstalled: "2.1.292",
  profiles: 3,
  remoteHosts: 2,
  phones: 0,
  workspaces: [
    { host: "local", id: "personal", name: "Personal", color: "clay", profile: "Default" },
    { host: "local", id: "acme", name: "Acme", color: "blue", profile: "Work" },
  ],
  projects: [{ host: "local", id: "p1", name: "storefront", base_branch: "main" }],
};

const shown = (q: string) => searchSettings(q, ctx).map((r) => [r.before + r.hit + r.after, r.path, r.value]);

describe("searching settings (X43)", () => {
  it("finds every setting whose name has the words, with its page and current value", () => {
    expect(shown("claude")).toEqual([
      ["Claude Code version", "App › General › Updates", "2.1.292"],
      ["Default permission mode for new Claude sessions", "App › Agents", "Auto"],
      ["Claude profiles", "Claude Code › Profiles", "3 profiles"],
      ["Claude Code hooks", "Claude Code › Hooks", ""],
      ["Claude profile", "Workspaces › Personal", "Default"],
      ["Claude profile", "Workspaces › Acme", "Work"],
    ]);
  });

  it("splits the name around the match, whatever its case", () => {
    const [mode] = searchSettings("CLAUDE S", ctx);
    expect(mode).toMatchObject({ before: "Default permission mode for new ", hit: "Claude s", after: "essions" });
  });

  it("opens the setting's page at its row", () => {
    expect(searchSettings("base branch", ctx)).toEqual([
      { key: "project:local:p1:project-base", before: "", hit: "Base branch", after: "", path: "Projects › storefront", value: "main", route: { page: "project", host: "local", id: "p1" }, setting: "project-base" },
    ]);
    expect(searchSettings("tool calls", ctx)[0]).toMatchObject({ route: { page: "agents" }, setting: "tool-calls", value: "Collapsed" });
  });

  it("finds a setting by another word for it, without a highlight", () => {
    expect(searchSettings("webgl", ctx)).toMatchObject([{ before: "GPU rendering", hit: "", after: "", path: "App › Terminal", value: "On" }]);
  });

  it("shows switches as On or Off and sounds by name", () => {
    expect(shown("sound")).toEqual([
      ["Sound when an agent needs you", "App › Notifications", "Glass"],
      ["Sound when an agent is done", "App › Notifications", "Hero"],
      ["Sound when an agent fails", "App › Notifications", "Off"],
    ]);
    expect(shown("notify even")).toEqual([["Notify even while moonlet is focused", "App › Notifications", "Off"]]);
  });

  it("finds nothing for a blank query", () => {
    expect(searchSettings("  ", ctx)).toEqual([]);
  });
});

describe("moving through the search results (X43)", () => {
  it("moves with ↑ and ↓ and stops at the ends", () => {
    expect(moveSelection(0, 6, "ArrowDown")).toBe(1);
    expect(moveSelection(5, 6, "ArrowDown")).toBe(5);
    expect(moveSelection(0, 6, "ArrowUp")).toBe(0);
    expect(moveSelection(3, 6, "ArrowUp")).toBe(2);
  });

  it("ignores other keys", () => {
    expect(moveSelection(2, 6, "a")).toBeNull();
  });
});
