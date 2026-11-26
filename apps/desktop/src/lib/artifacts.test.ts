import { describe, expect, it } from "vitest";
import { artifactRows, designMatch, homeLine, markParts, versionLine, type ListInput } from "./artifacts";
import type { ArtifactInfo, Design } from "./protocol";

const MIN = 60_000;
const NOW = 1_800_000_000_000;

const plan = (over: Partial<ArtifactInfo>): ArtifactInfo => ({
  id: "plan:a1b2c3d4e5f6:search-plan",
  kind: "plan",
  name: "Add search to the product list",
  home: { workspace: "w1", session: "a1b2c3d4e5f6", project: "p-store" },
  updated_at: NOW - 12 * MIN,
  version: 3,
  used_by: [],
  ...over,
});

const design = (over: Partial<Design>): Design => ({
  slug: "settings-page",
  name: "Settings page",
  kind: "workspace",
  system: "moonlet",
  path: "/x",
  pages: [
    { name: "index.html", label: "Overview" },
    { name: "empty.html", label: "No match" },
  ],
  updated_at: NOW - 60 * MIN,
  open_comments: 0,
  agent: null,
  agent_state: null,
  needs_you: null,
  error: null,
  ...over,
});

const projects: Record<string, string> = { "p-store": "storefront", "p-pay": "payments-api" };

const input = (over: Partial<ListInput> = {}): ListInput => ({
  plans: {
    mac: [plan({}), plan({ id: "plan:0f0f0f0f0f0f:refunds", name: "Idempotent refund endpoint", home: { workspace: "w1", session: "0f0f0f0f0f0f", project: "p-pay", archived: true }, updated_at: NOW - 3 * 86_400_000 })],
  },
  designs: {
    mac: [
      design({}),
      design({ slug: "checkout-flow", name: "Checkout flow", kind: "session", session: "a1b2c3d4e5f6", project: "p-store", updated_at: NOW - 180 * MIN }),
      design({ slug: "account-dark", name: "Account pages, dark", kind: "project", project: "p-store", updated_at: NOW - 5 * 86_400_000 }),
    ],
  },
  workspace: "w1",
  projectName: (id) => projects[id],
  now: NOW,
  ...over,
});

describe("artifactRows", () => {
  it("lists plans and designs together, newest change first, each with its home and age", () => {
    const rows = artifactRows(input(), "all", "", {});
    expect(rows.map((r) => [r.info.kind, r.info.name, r.home, r.age])).toEqual([
      ["plan", "Add search to the product list", "storefront", "12m"],
      ["design", "Settings page", "Workspace", "1h"],
      ["design", "Checkout flow", "storefront", "3h"],
      ["plan", "Idempotent refund endpoint", "payments-api · archived", "3d"],
      ["design", "Account pages, dark", "storefront · merged", "5d"],
    ]);
  });

  it("shows only the kind picked", () => {
    expect(artifactRows(input(), "plan", "", {}).map((r) => r.info.name)).toEqual(["Add search to the product list", "Idempotent refund endpoint"]);
    expect(artifactRows(input(), "design", "", {}).map((r) => r.info.name)).toEqual(["Settings page", "Checkout flow", "Account pages, dark"]);
  });

  it("says how many other sessions use an artifact", () => {
    const rows = artifactRows(input({ plans: { mac: [plan({ used_by: ["s2", "s3"] })] }, designs: {} }), "all", "", {});
    expect(rows[0].usedBy).toBe("used by 2");
  });

  it("while searching, keeps the plans each host found and the designs found by name, brief or page label, with the line found", () => {
    const found = { mac: [{ id: "plan:a1b2c3d4e5f6:search-plan", field: "text" as const, snippet: "…with a 150 ms debounce so typing stays smooth…" }] };
    const designs = { mac: [design({ brief: "Search field with a debounced result count" }), design({ slug: "checkout-flow", name: "Checkout flow" })] };
    const rows = artifactRows(input({ designs }), "all", "debounce", found);
    expect(rows.map((r) => [r.info.name, r.snippet])).toEqual([
      ["Add search to the product list", "…with a 150 ms debounce so typing stays smooth…"],
      ["Settings page", "Brief: Search field with a debounced result count"],
    ]);
  });

  it("gives each design an id from where it lives", () => {
    const rows = artifactRows(input({ plans: {} }), "design", "", {});
    expect(rows.map((r) => r.info.id)).toEqual(["design:workspace:w1:settings-page", "design:session:a1b2c3d4e5f6:checkout-flow", "design:project:p-store:account-dark"]);
    const shared = artifactRows(input({ plans: {}, designs: { mac: [design({ shared: true })] } }), "all", "", {});
    expect(shared[0].info.id).toBe("design:library:settings-page");
  });
});

describe("designMatch", () => {
  it("finds a design by its name, then its brief, then a page's label", () => {
    expect(designMatch(design({}), "SETTINGS")).toEqual({ field: "name" });
    expect(designMatch(design({ brief: "Dense rows" }), "dense")).toEqual({ field: "brief", snippet: "Brief: Dense rows" });
    expect(designMatch(design({}), "no match")).toEqual({ field: "label", snippet: "Page: No match" });
    expect(designMatch(design({}), "checkout")).toBeNull();
  });
});

describe("homeLine", () => {
  it("names a workspace artifact's home Workspace", () => {
    expect(homeLine(plan({ home: { workspace: "w1" } }), () => undefined)).toBe("Workspace");
  });
});

describe("markParts", () => {
  it("marks every place the query is, ignoring case", () => {
    expect(markParts("Debounce, then debounce", "debounce")).toEqual([
      { text: "Debounce", mark: true },
      { text: ", then ", mark: false },
      { text: "debounce", mark: true },
    ]);
    expect(markParts("nothing", "")).toEqual([{ text: "nothing", mark: false }]);
  });
});

describe("versionLine", () => {
  it("names the version shown, its state and age", () => {
    const versions = [
      { n: 1, state: "rejected" as const, at: NOW - 31 * MIN },
      { n: 2, state: "edited" as const, at: NOW - 25 * MIN },
      { n: 3, state: "approved" as const, at: NOW - 12 * MIN },
    ];
    expect(versionLine({ version: 3, versions }, NOW)).toBe("v3, approved 12m ago");
    expect(versionLine({ version: 2, versions }, NOW)).toBe("v2, edited by you 25m ago");
    expect(versionLine({ version: 1, versions: [{ n: 1, state: "pending", at: NOW }] }, NOW)).toBe("v1, pending just now");
  });
});
