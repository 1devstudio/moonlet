import { describe, expect, it } from "vitest";
import { branchPrefix, buildItTarget, buildNames, buildPick, buildProject, buildingIn, createFailure, createReady, designAttachments, designDir, promptAfterDrop } from "./buildIt";
import { firstMessage } from "./composer";

const settings = {
  workspace: "a1b2c3d4e5f6",
  slug: "settings-page",
  name: "Settings page",
  system: "moonlet-desktop",
  systemName: "moonlet desktop",
  pages: [
    { name: "index", label: "rows" },
    { name: "git-a", label: "Git section as cards" },
    { name: "git-b", label: "Git section, compact" },
  ],
};

describe("Build it's composer (X65)", () => {
  it("opens the composer on the design system's first source, with the design as its chip, its branch, its prompt and the note", () => {
    const projects = [
      { id: "p-store", path: "/Users/marcin/code/storefront" },
      { id: "p-moon", path: "/Users/marcin/code/moonlet" },
    ];
    expect(buildProject(["/Users/marcin/code/moonlet", "/Users/marcin/code/storefront"], projects)).toBe("p-moon");
    expect(buildNames(settings, "marcin/")).toEqual({
      chip: "Design · Settings page",
      name: "implement-settings-page",
      branch: "marcin/implement-settings-page",
      prompt: "Implement the Settings page design",
      note: "The project is the design system's first source. The design keeps a link to the session it starts.",
    });
  });

  it("has no project when the design system's first source is not one of the workspace's projects", () => {
    expect(buildProject(["/elsewhere"], [{ id: "p-moon", path: "/Users/marcin/code/moonlet" }])).toBeNull();
    expect(buildProject([], [])).toBeNull();
    expect(buildNames(settings, "").branch).toBe("implement-settings-page");
  });

  it("opens on the first source's project, and is disabled, saying why, when that project is not one of the workspace's or the design system has no source", () => {
    const projects = [{ id: "p-moon", path: "/Users/marcin/code/moonlet" }];
    expect(buildItTarget(["/Users/marcin/code/moonlet"], projects)).toEqual({ project: "p-moon" });
    expect(buildItTarget(["/Users/marcin/code/storefront", "/Users/marcin/code/moonlet"], projects)).toEqual({
      unavailable: "storefront, the design system's first source, is not a project of this workspace",
    });
    expect(buildItTarget([], projects)).toEqual({ unavailable: "The design system has no source project to build in" });
  });

  it("takes the project's branch prefix, else the host's, as the daemon does", () => {
    expect(branchPrefix({ branch_prefix: "acme/" }, "moonlet/")).toBe("acme/");
    expect(branchPrefix({ branch_prefix: "  " }, "moonlet/")).toBe("moonlet/");
    expect(branchPrefix({}, "moonlet/")).toBe("moonlet/");
    expect(branchPrefix(null, "")).toBe("");
  });

  it("names its lines by the project's design folder, trimmed, else docs/design", () => {
    expect(designDir({ design: { dir: " ui/prototypes " } })).toBe("ui/prototypes");
    expect(designDir({ design: { dir: "" } })).toBe("docs/design");
    expect(designDir({})).toBe("docs/design");
    expect(designDir(null)).toBe("docs/design");
  });

  it("creates only once the project's config is read while it builds a design, as its lines name the project's design folder", () => {
    expect(createReady({ busy: false, project: true, building: true, configRead: false })).toBe(false);
    expect(createReady({ busy: false, project: true, building: true, configRead: true })).toBe(true);
    expect(createReady({ busy: false, project: true, building: false, configRead: false })).toBe(true);
    expect(createReady({ busy: true, project: true, building: false, configRead: true })).toBe(false);
    expect(createReady({ busy: false, project: false, building: false, configRead: true })).toBe(false);
  });

  it("says a refused Create in the composer while it builds a design, and in a toast otherwise", () => {
    const refused = "docs/design/settings-page is in the worktree already: rename the design before building it";
    expect(createFailure(true, refused)).toEqual({ refused });
    expect(createFailure(false, "no such project")).toEqual({ toast: "no such project" });
  });
});

describe("designAttachments (X65 Build it)", () => {
  it("are one per page, index first, then the styles, each sending its one line", () => {
    const sent = designAttachments(settings, { systemName: "moonlet desktop", dir: "docs/design", left: [] });
    expect(sent.map((a) => [a.file, a.summary, a.message])).toEqual([
      ["index.html", "Settings page, rows", "docs/design/settings-page/pages/index.html · Settings page, rows"],
      ["git-a.html", "Settings page, Git section as cards", "docs/design/settings-page/pages/git-a.html · Settings page, Git section as cards"],
      ["git-b.html", "Settings page, Git section, compact", "docs/design/settings-page/pages/git-b.html · Settings page, Git section, compact"],
      ["styles.css", "moonlet desktop styles", "docs/design/settings-page/system/styles.css · moonlet desktop styles"],
    ]);
    // X54's text contract: each sends the text it shows, in the order shown, before the prompt.
    expect(firstMessage(sent, "Implement the Settings page design")).toBe(
      [
        "docs/design/settings-page/pages/index.html · Settings page, rows",
        "docs/design/settings-page/pages/git-a.html · Settings page, Git section as cards",
        "docs/design/settings-page/pages/git-b.html · Settings page, Git section, compact",
        "docs/design/settings-page/system/styles.css · moonlet desktop styles",
        "Implement the Settings page design",
      ].join("\n\n"),
    );
  });

  it("puts index first whatever order the pages come in, names a page without a label by the design alone, and takes the project's design folder", () => {
    const sent = designAttachments({ ...settings, pages: [{ name: "git-a", label: null }, { name: "index", label: null }] }, { systemName: "moonlet desktop", dir: "ui/prototypes", left: [] });
    expect(sent.map((a) => a.message)).toEqual([
      "ui/prototypes/settings-page/pages/index.html · Settings page",
      "ui/prototypes/settings-page/pages/git-a.html · Settings page",
      "ui/prototypes/settings-page/system/styles.css · moonlet desktop styles",
    ]);
  });

  it("leaves a page × left out of the message, and the styles can never be left out", () => {
    const sent = designAttachments(settings, { systemName: "moonlet desktop", dir: "docs/design", left: ["git-a", "styles"] });
    expect(sent.map((a) => a.message)).toEqual([
      "docs/design/settings-page/pages/index.html · Settings page, rows",
      "docs/design/settings-page/pages/git-b.html · Settings page, Git section, compact",
      "docs/design/settings-page/system/styles.css · moonlet desktop styles",
    ]);
    expect(sent.map((a) => a.remove)).toEqual(["Leave index.html out of the copy and the message", "Leave git-b.html out of the copy and the message", null]);
    // …and out of the copy session.create makes in the worktree.
    expect(buildPick(settings, ["git-a", "styles"])).toEqual({ workspace: "a1b2c3d4e5f6", slug: "settings-page", pages: ["index", "git-b"] });
  });

  it("keeps at least one page: the last page left has no ×", () => {
    const sent = designAttachments(settings, { systemName: "moonlet desktop", dir: "docs/design", left: ["index", "git-a"] });
    expect(sent.map((a) => [a.file, a.remove])).toEqual([
      ["git-b.html", null],
      ["styles.css", null],
    ]);
  });

  it("unfolds a page to its line and the page, and the styles to their line alone", () => {
    const [index, , , styles] = designAttachments(settings, { systemName: "moonlet desktop", dir: "docs/design", left: [] });
    expect([index.body, index.page]).toEqual(["docs/design/settings-page/pages/index.html · Settings page, rows", "index"]);
    expect([styles.body, styles.page]).toEqual(["docs/design/settings-page/system/styles.css · moonlet desktop styles", undefined]);
  });
});

describe("buildingIn (X65 Build it)", () => {
  const sessions = [{ id: "s7", name: "implement-settings-page", project_id: "p-moon" }];
  const projects = [{ id: "p-moon", name: "moonlet" }];

  it("says where a workspace design is building once its session is made, and which session opens", () => {
    expect(buildingIn({ built_in: { session: "s7", project: "p-moon" } }, sessions, projects)).toEqual({ text: "Building in moonlet · implement-settings-page", session: "s7" });
  });

  it("says nothing for a design never built, or built in a session moonlet no longer has, which Build it may start again", () => {
    expect(buildingIn({}, sessions, projects)).toBeNull();
    expect(buildingIn({ built_in: { session: "s9" } }, sessions, projects)).toBeNull();
  });

  it("says nothing for a design built in a session that is archived, which Build it may start again", () => {
    const archived = [{ id: "s7", name: "implement-settings-page", project_id: "p-moon", archived: true }];
    expect(buildingIn({ built_in: { session: "s7", project: "p-moon" } }, archived, projects)).toBeNull();
  });
});

describe("promptAfterDrop (X65 Build it)", () => {
  it("leaves the composer plain after the chip's ×: the prompt Build it set goes, one the user changed stays", () => {
    expect(promptAfterDrop("Implement the Settings page design", settings)).toBe("");
    expect(promptAfterDrop("Implement the Settings page design, rows first", settings)).toBe("Implement the Settings page design, rows first");
    expect(promptAfterDrop("", settings)).toBe("");
  });
});
