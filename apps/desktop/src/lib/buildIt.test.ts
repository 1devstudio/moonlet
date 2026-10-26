import { describe, expect, it } from "vitest";
import { buildComposer, buildPick, designAttachments } from "./buildIt";
import { firstMessage } from "./composer";

const settings = {
  workspace: "a1b2c3d4e5f6",
  slug: "settings-page",
  name: "Settings page",
  system: "moonlet-desktop",
  pages: [
    { name: "index", label: "rows" },
    { name: "git-a", label: "Git section as cards" },
    { name: "git-b", label: "Git section, compact" },
  ],
};

describe("buildComposer (X65 Build it)", () => {
  it("opens the composer on the design system's first source, with the design as its chip, its branch, its prompt and the note", () => {
    const projects = [
      { id: "p-store", path: "/Users/marcin/code/storefront" },
      { id: "p-moon", path: "/Users/marcin/code/moonlet" },
    ];
    expect(buildComposer(settings, { sources: ["/Users/marcin/code/moonlet", "/Users/marcin/code/storefront"], projects, prefix: "marcin/" })).toEqual({
      project: "p-moon",
      chip: "Design · Settings page",
      name: "implement-settings-page",
      branch: "marcin/implement-settings-page",
      prompt: "Implement the Settings page design",
      note: "The project is the design system's first source. The design keeps a link to the session it starts.",
    });
  });

  it("has no project when the design system's first source is not one of the workspace's projects", () => {
    expect(buildComposer(settings, { sources: ["/elsewhere"], projects: [{ id: "p-moon", path: "/Users/marcin/code/moonlet" }], prefix: "" })).toMatchObject({ project: null, branch: "implement-settings-page" });
    expect(buildComposer(settings, { sources: [], projects: [], prefix: "" }).project).toBeNull();
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

  it("unfolds a page to its line and the page, and the styles to their line alone", () => {
    const [index, , , styles] = designAttachments(settings, { systemName: "moonlet desktop", dir: "docs/design", left: [] });
    expect([index.body, index.page]).toEqual(["docs/design/settings-page/pages/index.html · Settings page, rows", "index"]);
    expect([styles.body, styles.page]).toEqual(["docs/design/settings-page/system/styles.css · moonlet desktop styles", undefined]);
  });
});
