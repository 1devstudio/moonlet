import { describe, expect, it } from "vitest";
import { atRows, atSections, nextAtTab } from "./atPicker";
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
    const sections = atSections({ files, artifacts }, "sett", "all");
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
    const sections = atSections({ files, artifacts }, "sett", "file");
    expect(sections.map((s) => [s.kind, s.rows.length])).toEqual([["file", 7]]);
  });

  it("leaves out a section with nothing found, and lists everything for a bare @", () => {
    expect(atSections({ files, artifacts }, "checkout", "all").map((s) => s.kind)).toEqual(["plan"]);
    expect(atSections({ files, artifacts }, "", "all").map((s) => [s.kind, s.total])).toEqual([
      ["plan", 2],
      ["design", 2],
      ["file", 7],
    ]);
  });
});

describe("atRows", () => {
  it("is the rows in the order shown, for the arrow keys", () => {
    const rows = atRows(atSections({ files, artifacts }, "checkout", "all"));
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
