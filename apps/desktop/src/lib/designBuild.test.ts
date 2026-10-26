import { describe, expect, it } from "vitest";
import type { Design } from "./protocol";
import { buildRowShows, builtFile, designBuild } from "./designBuild";

const design = (over: Partial<Design> = {}): Design => ({
  slug: "settings-page",
  name: "Settings page",
  kind: "session",
  system: "moonlet-desktop",
  path: "/Users/alex/.moonlet/worktrees/moonlet/settings-page/docs/design/settings-page",
  viewport: "1440x900",
  pages: [
    { name: "index", label: "rows" },
    { name: "git-a", label: "cards" },
  ],
  updated_at: 0,
  open_comments: 0,
  agent: 31,
  agent_state: "idle",
  needs_you: null,
  error: null,
  session: "4f2a9c1e7b3d",
  project: "p-moonlet",
  ...over,
});

describe("the PR's Design and build (X65)", () => {
  it("puts each page, in order, beside its built screenshot, or says it is not built yet", () => {
    const view = designBuild(design(), "/Users/alex/.moonlet/worktrees/moonlet/settings-page", { index: true, "git-a": false });
    expect(view.title).toBe("Design and build");
    expect(view.line).toBe("each page beside the built screen, at 1440×900");
    expect(view.rows.map((r) => [r.page, r.design, r.built, r.builtLabel])).toEqual([
      ["index", "docs/design/settings-page/pages/index.html", "settings-page@built/index.png", ".moonlet/design/settings-page/built/index.png"],
      ["git-a", "docs/design/settings-page/pages/git-a.html", "settings-page@built/git-a.png", "Not built yet"],
    ]);
  });

  it("says nothing of a screenshot until it is looked for, and takes the design's viewport, Desktop without one", () => {
    const view = designBuild(design({ viewport: undefined }), "/Users/alex/.moonlet/worktrees/moonlet/settings-page", {});
    expect(view.line).toBe("each page beside the built screen, at 1440×900");
    expect(view.rows.map((r) => r.builtLabel)).toEqual([null, null]);
    expect(designBuild(design({ viewport: "390x844" }), "/wt", {}).line).toBe("each page beside the built screen, at 390×844");
  });

  it("tries each page's screenshot as an image before it is known to be there, showing it once it loads and Not built yet once it fails, so its bytes travel once", () => {
    const wt = "/Users/alex/.moonlet/worktrees/moonlet/settings-page";
    const looking = designBuild(design(), wt, {}).rows;
    expect(looking.map((r) => [r.built, r.builtLabel])).toEqual([
      ["settings-page@built/index.png", null],
      ["settings-page@built/git-a.png", null],
    ]);
    expect(buildRowShows(looking[0], true)).toEqual({ frame: true, image: true, shown: false });
    const [loaded, failed] = designBuild(design(), wt, { index: true, "git-a": false }).rows;
    expect(buildRowShows(loaded, false)).toEqual({ frame: false, image: true, shown: true });
    expect(buildRowShows(failed, true)).toEqual({ frame: true, image: true, shown: false });
  });

  it("tries a page's screenshot only while its row is near the screen, and keeps one that loaded, near or not", () => {
    const wt = "/Users/alex/.moonlet/worktrees/moonlet/settings-page";
    const [looking] = designBuild(design(), wt, {}).rows;
    expect([buildRowShows(looking, false), buildRowShows(looking, true)]).toEqual([
      { frame: false, image: false, shown: false },
      { frame: true, image: true, shown: false },
    ]);
    const [loaded, failed] = designBuild(design(), wt, { index: true, "git-a": false }).rows;
    expect([buildRowShows(loaded, false), buildRowShows(failed, false), buildRowShows(failed, true)]).toEqual([
      { frame: false, image: true, shown: true },
      { frame: false, image: false, shown: false },
      { frame: true, image: true, shown: false },
    ]);
  });

  it("names a page's screenshot for design.file as the agent saves it", () => {
    expect(builtFile("settings-page", "index")).toBe("settings-page@built/index.png");
  });

  it("frames a page only while its row is near the screen, and shows its built screenshot, an image, either way", () => {
    const [built, notBuilt] = designBuild(design(), "/Users/alex/.moonlet/worktrees/moonlet/settings-page", { index: true, "git-a": false }).rows;
    expect(buildRowShows(built, true)).toEqual({ frame: true, image: true, shown: true });
    expect(buildRowShows(built, false)).toEqual({ frame: false, image: true, shown: true });
    expect(buildRowShows(notBuilt, false)).toEqual({ frame: false, image: false, shown: false });
  });
});
