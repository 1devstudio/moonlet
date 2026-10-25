import { describe, expect, it } from "vitest";
import { canvasPage, changedPages, reloadsPage, writingPage } from "./designCanvas";

const change = (over: { system?: string | null; design?: string | null; paths: string[] }) => ({ workspace: "w1", system: null, design: null, ...over });

describe("the page the agent is writing (X65)", () => {
  it("is a page of the latest change to the design, while its agent works", () => {
    const pages = changedPages(change({ design: "settings-page", paths: ["design.toml", "pages/git-a.html", "assets/logo.svg"] }), "settings-page");
    expect(pages).toEqual(["git-a"]);
    expect(writingPage(pages, true)).toBe("git-a");
    expect(writingPage(pages, false)).toBeNull();
    expect(writingPage([], true)).toBeNull();
  });

  it("is none of another design's or a design system's change", () => {
    expect(changedPages(change({ design: "onboarding", paths: ["pages/index.html"] }), "settings-page")).toEqual([]);
    expect(changedPages(change({ system: "moonlet-desktop", paths: ["pages/index.html"] }), "settings-page")).toEqual([]);
  });
});

describe("the canvas's reload (X65)", () => {
  const shown = { design: "settings-page", system: "moonlet-desktop", page: "index" };

  it("comes when the shown page changes, or an asset it may use", () => {
    expect(reloadsPage(change({ design: "settings-page", paths: ["pages/index.html"] }), shown)).toBe(true);
    expect(reloadsPage(change({ design: "settings-page", paths: ["assets/logo.svg"] }), shown)).toBe(true);
    expect(reloadsPage(change({ design: "settings-page", paths: ["pages/git-a.html", "design.toml"] }), shown)).toBe(false);
  });

  it("comes when its design system's styles change, which the page links", () => {
    expect(reloadsPage(change({ system: "moonlet-desktop", paths: ["styles.css"] }), shown)).toBe(true);
    expect(reloadsPage(change({ system: "moonlet-desktop", paths: ["tokens/colors.css"] }), shown)).toBe(true);
    // A card is no file a page loads.
    expect(reloadsPage(change({ system: "moonlet-desktop", paths: ["components/buttons/button/button.html"] }), shown)).toBe(false);
    expect(reloadsPage(change({ system: "moonlet-desktop", paths: ["components.css"] }), shown)).toBe(true);
    expect(reloadsPage(change({ system: "moonlet-desktop", paths: ["fonts/inter.woff2"] }), shown)).toBe(true);
    expect(reloadsPage(change({ system: "moonlet-desktop", paths: ["tokens/colors.json"] }), shown)).toBe(true);
    // Nor are what a sync writes for the agent and moonlet.
    for (const other of ["README.md", "components/buttons/button/button.prompt.md", "_ds_sync.json", "_ds_manifest.json", "config.toml", ".cache/progress.toml"]) {
      expect(reloadsPage(change({ system: "moonlet-desktop", paths: [other] }), shown)).toBe(false);
    }
    expect(reloadsPage(change({ system: "storefront", paths: ["styles.css"] }), shown)).toBe(false);
    expect(reloadsPage(change({ design: "onboarding", paths: ["pages/index.html"] }), shown)).toBe(false);
  });
});

describe("the page the canvas shows (X65)", () => {
  it("is the one picked, or Overview, and the first page once the picked one is gone, or index before any", () => {
    expect(canvasPage("git-a", ["index", "git-a"])).toBe("git-a");
    expect(canvasPage(null, ["index", "git-a"])).toBeNull();
    expect(canvasPage("git-b", ["index", "git-a"])).toBe("index");
    expect(canvasPage("git-b", ["git-a"])).toBe("git-a");
    expect(canvasPage("index", [])).toBe("index");
    expect(canvasPage("git-b", [])).toBe("index");
  });
});
