import { describe, expect, it } from "vitest";
import { atKey, atRows, atSections, nextAtTab, withoutToken } from "./atPicker";
import type { ArtifactRow } from "./artifacts";

const row = (kind: "plan" | "design", id: string, name: string, home: string, usedBy: string | null = null): ArtifactRow => ({
  host: "local",
  info: { id, kind, name, home: { workspace: "w1" }, updated_at: 0, used_by: [] },
  home,
  age: "1h",
  usedBy,
  snippet: null,
});

const artifacts = [
  row("plan", "plan:s1:notify", "Notification settings", "web-admin"),
  row("design", "design:workspace:w1:settings-page", "Settings page", "Workspace", "used by 3"),
  row("design", "design:session:s2:account", "Account settings", "web-admin"),
  row("plan", "plan:s3:checkout", "Checkout retries", "storefront"),
];

const files = [
  "src/pages/SettingsPage.tsx",
  "src/lib/settings.ts",
  "src/components/SettingsForm.test.tsx",
  "src/hooks/useSettings.ts",
  "src/styles/settings.css",
  "docs/settings.md",
  "src/components/Button.tsx",
];

describe("atSections", () => {
  it("lists plans, designs and files that match, at most five of each, with where each lives", () => {
    const { sections } = atSections({ files, artifacts }, "sett", "all");
    expect(sections.map((s) => [s.kind, s.total, s.rows.map((r) => r.label)])).toEqual([
      ["plan", 1, ["Notification settings"]],
      ["design", 2, ["Settings page", "Account settings"]],
      // Files as ⌘P and the @ list rank them (X96, X30).
      ["file", 7, ["docs/settings.md", "src/lib/settings.ts", "src/pages/SettingsPage.tsx", "src/styles/settings.css", "src/hooks/useSettings.ts"]],
    ]);
    expect(sections[1].rows[0]).toMatchObject({ where: "Workspace · used by 3", value: "design:workspace:w1:settings-page" });
    expect(sections[2].rows[1]).toMatchObject({ value: "src/lib/settings.ts", label: "src/lib/settings.ts", where: "src/lib/" });
  });

  it("narrowed to one section, lists all of its matches", () => {
    const { sections } = atSections({ files, artifacts }, "sett", "file");
    expect(sections.map((s) => [s.kind, s.rows.length])).toEqual([["file", 7]]);
  });

  it("leaves out a section with nothing found, and lists everything for a bare @", () => {
    expect(atSections({ files, artifacts }, "checkout", "all").sections.map((s) => s.kind)).toEqual(["plan"]);
    expect(atSections({ files, artifacts }, "", "all").sections.map((s) => [s.kind, s.total])).toEqual([
      ["plan", 2],
      ["design", 2],
      ["file", 7],
    ]);
  });
});

describe("atSections totals", () => {
  it("counts each section's matches whichever section is shown, for the tabs", () => {
    expect(atSections({ files, artifacts }, "sett", "file").totals).toEqual({ plan: 1, design: 2, file: 7 });
  });

  it("shows at most 200 rows of a section narrowed to, and counts them all", () => {
    const many = Array.from({ length: 250 }, (_, i) => `src/settings/s${i}.ts`);
    const found = atSections({ files: many, artifacts: [] }, "sett", "file");
    expect(found.sections[0].rows).toHaveLength(200);
    expect(found.totals.file).toBe(250);
  });
});

describe("withoutToken", () => {
  it("takes the typed @word out, also past the caret, and keeps one space", () => {
    expect(withoutToken("Build it from @sett now", 19, { start: 14 })).toEqual({ text: "Build it from now", caret: 14 });
    expect(withoutToken("@settings", 9, { start: 0 })).toEqual({ text: "", caret: 0 });
    expect(withoutToken("see @sett", 9, { start: 4 })).toEqual({ text: "see ", caret: 4 });
  });
});

describe("atKey", () => {
  it("Tab narrows, Enter picks a row, Esc closes, even with no row", () => {
    expect(atKey("Tab", false, 3)).toBe("next");
    expect(atKey("Tab", true, 3)).toBe("back");
    expect(atKey("Enter", false, 3)).toBe("pick");
    expect(atKey("Enter", false, 0)).toBeNull();
    expect(atKey("Enter", true, 3)).toBeNull();
    expect(atKey("Escape", false, 0)).toBe("close");
    expect(atKey("a", false, 3)).toBeNull();
  });
});

describe("atRows", () => {
  it("is the rows in the order shown, for the arrow keys", () => {
    const rows = atRows(atSections({ files, artifacts }, "checkout", "all").sections);
    expect(rows.map((r) => r.label)).toEqual(["Checkout retries"]);
  });
});

describe("nextAtTab", () => {
  it("goes All, Plans, Designs, Files and round again; back the other way", () => {
    expect(["all", "plan", "design", "file"].map((t) => nextAtTab(t as never, false))).toEqual(["plan", "design", "file", "all"]);
    expect(nextAtTab("all", true)).toBe("file");
    expect(nextAtTab("plan", true)).toBe("all");
  });
});
