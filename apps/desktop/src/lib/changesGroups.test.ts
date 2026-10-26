import { describe, expect, it } from "vitest";
import { changesGroups } from "./changesGroups";
import type { FileChange } from "./protocol";

const added = (path: string): FileChange => ({ path, status: "added", staged: false, unstaged: true, additions: 1, deletions: 0, binary: false });
const names = (groups: ReturnType<typeof changesGroups>) => groups?.map((g) => [g.name, g.files.map((f) => f.path)]) ?? null;

const files = [
  added("apps/desktop/src/components/SettingsPage.tsx"),
  added("docs/design/settings-page/design.toml"),
  added("docs/specs/X66-settings-page.md"),
  added("docs/design/settings-page/pages/index.html"),
  added("docs/specs/README.md"),
  added("docs/designs.md"),
  added("docs/design/settings-page/pages/git-a.html"),
];

describe("the Changes panel's groups in a session with a design (X65)", () => {
  it("are Design, the design folder, Spec, docs/specs/, and Code, everything else, each in path order", () => {
    expect(names(changesGroups(files, "/wt/settings-page", [{ path: "/wt/settings-page/docs/design/settings-page" }]))).toEqual([
      ["Design", ["docs/design/settings-page/design.toml", "docs/design/settings-page/pages/git-a.html", "docs/design/settings-page/pages/index.html"]],
      ["Spec", ["docs/specs/README.md", "docs/specs/X66-settings-page.md"]],
      ["Code", ["apps/desktop/src/components/SettingsPage.tsx", "docs/designs.md"]],
    ]);
  });

  it("take the design folder the project's config sets, and leave out a group with no files", () => {
    expect(names(changesGroups([added("design/prototypes/onboarding/pages/index.html"), added("src/main.rs")], "/wt/s/", [{ path: "/wt/s/design/prototypes/onboarding" }]))).toEqual([
      ["Design", ["design/prototypes/onboarding/pages/index.html"]],
      ["Code", ["src/main.rs"]],
    ]);
  });

  it("are none in a session without a design, which lists its files as before", () => {
    expect(changesGroups(files, "/wt/settings-page", [])).toBeNull();
  });
});
