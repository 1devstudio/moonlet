import { describe, expect, it } from "vitest";
import { artifactRows, artifactSessionName, KIND_WORDS, copyRefusal, moveRefusal, startRefusal, designFor, designMatch, homeLine, markParts, planArtifactId, planReadOnly, sentArtifacts, startMessage, startPlaceholder, stateLabel, unreachableLine, versionLine, withArtifactLines, type ListInput } from "./artifacts";
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
  projectName: (_host, id) => projects[id],
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
    expect(homeLine(plan({ home: { workspace: "w1" } }), "mac", () => undefined)).toBe("Workspace");
  });

  it("names a project as the artifact's own host names it", () => {
    const names: Record<string, Record<string, string>> = { mac: { p1: "storefront" }, mini: { p1: "other repo" } };
    expect(homeLine(plan({ home: { workspace: "w1", project: "p1" } }), "mini", (host, id) => names[host]?.[id])).toBe("other repo");
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

describe("one row per design", () => {
  it("lists a design copied to another Mac once, from the Mac that owns it", () => {
    const copy = design({ owner: { worker: "mini", name: "studio-mini" } });
    const rows = artifactRows(input({ plans: {}, designs: { laptop: [copy], mini: [design({})] } }), "design", "", {});
    expect(rows.map((r) => [r.host, r.info.id])).toEqual([["mini", "design:workspace:w1:settings-page"]]);
  });

  it("lists a shared design under the library", () => {
    const rows = artifactRows(input({ plans: {}, designs: { mac: [design({ shared: true })] } }), "design", "", {});
    expect(rows.map((r) => r.info.id)).toEqual(["design:library:settings-page"]);
  });
});

describe("designFor", () => {
  it("finds the design an artifact is, never another of the same slug", () => {
    const own = design({ name: "Own" });
    const merged = design({ name: "Merged", kind: "project", project: "p-store" });
    const ofSession = design({ name: "Session's", kind: "session", session: "s1" });
    const all = [merged, ofSession, own];
    expect(designFor(all, "design:workspace:w1:settings-page", "w1")?.name).toBe("Own");
    expect(designFor(all, "design:session:s1:settings-page", "w1")?.name).toBe("Session's");
    expect(designFor(all, "design:workspace:w1:other", "w1")).toBeUndefined();
  });
});

describe("planReadOnly", () => {
  it("is read only in an archived session, or on an older version", () => {
    expect(planReadOnly({ archived: true }, null, 3)).toBe(true);
    expect(planReadOnly({}, 2, 3)).toBe(true);
    expect(planReadOnly({}, null, 3)).toBe(false);
    expect(planReadOnly({}, 3, 3)).toBe(false);
  });
});

describe("stateLabel", () => {
  it("says a version edited by hand was edited by the user", () => {
    expect(["pending", "approved", "rejected", "edited"].map((s) => stateLabel(s as never))).toEqual(["pending", "approved", "rejected", "edited by you"]);
  });
});

describe("unreachableLine", () => {
  it("names the hosts whose artifacts are not listed because they cannot be reached", () => {
    const hosts = { local: { id: "local", label: "This Mac", status: "connected" }, mini: { id: "mini", label: "studio-mini", status: "disconnected" }, pro: { id: "pro", label: "pro", status: "connecting" } };
    expect(unreachableLine(hosts)).toBe("Not listed from studio-mini, pro: they can't be reached");
    expect(unreachableLine({ mini: hosts.mini })).toBe("Not listed from studio-mini: it can't be reached");
    expect(unreachableLine({ local: hosts.local })).toBeNull();
  });
});

describe("markParts with text whose lowercase is longer", () => {
  it("marks the match itself", () => {
    expect(markParts("İstanbul debounce", "debounce")).toEqual([
      { text: "İstanbul ", mark: false },
      { text: "debounce", mark: true },
    ]);
  });
});

describe("planArtifactId", () => {
  it("is the session and the plan file's name, as the daemon keys a plan", () => {
    expect(planArtifactId("a1b2c3d4e5f6", "/Users/me/.claude/plans/search-plan.md")).toBe("plan:a1b2c3d4e5f6:search-plan");
    expect(planArtifactId("a1b2c3d4e5f6", "/tmp/plans/my plan.v2.md")).toBe("plan:a1b2c3d4e5f6:my-plan-v2");
    // One dash per character, as the daemon's key has, whatever its length in UTF-16.
    expect(planArtifactId("a1b2c3d4e5f6", "/tmp/plans/plan 📋.md")).toBe("plan:a1b2c3d4e5f6:plan--");
    expect(planArtifactId("a1b2c3d4e5f6", null)).toBeNull();
    expect(planArtifactId("a1b2c3d4e5f6", "# A plan's text, not a file")).toBeNull();
  });
});

describe("withArtifactLines", () => {
  it("puts each artifact's line before what the user typed", () => {
    const plan = 'Artifact "Add search" (plan, live, read only): /refs/s1/plan-search. It always holds the latest version; it changes only in its home.';
    const design = 'Artifact "Settings page" (design, live, read only): /refs/s1/design-settings-page. It always holds the latest version; it changes only in its home.';
    expect(withArtifactLines("Implement it.", [plan, design])).toBe(`${plan}\n${design}\n\nImplement it.`);
    expect(withArtifactLines("  ", [plan])).toBe(plan);
    expect(withArtifactLines("Hi", [])).toBe("Hi");
  });
});

describe("sentArtifacts", () => {
  it("reads the artifacts a message refers to and the notes before it, then what the user typed", () => {
    const text = [
      "Settings page changed since you last read it: /refs/s1/design-settings-page",
      'Artifact "Add search" (plan, live, read only): /refs/s1/plan-search. It always holds the latest version; it changes only in its home.',
      'Artifact "Settings page" (design, live, read only): /refs/s1/design-settings-page. It always holds the latest version; it changes only in its home.',
      "",
      "Build the results page.",
    ].join("\n");
    expect(sentArtifacts(text)).toEqual({
      refs: [
        { name: "Add search", kind: "plan", folder: "/refs/s1/plan-search" },
        { name: "Settings page", kind: "design", folder: "/refs/s1/design-settings-page" },
      ],
      notes: [{ kind: "changed", text: "Settings page changed since you last read it" }],
      rest: "Build the results page.",
    });
  });

  it("reads a plan edited by hand, and leaves a message with no artifact lines alone", () => {
    expect(sentArtifacts("The plan was edited by hand: /plans/s1/k/v2.md\n\ngo on")).toEqual({ refs: [], notes: [{ kind: "edited", text: "The plan was edited by hand" }], rest: "go on" });
    expect(sentArtifacts("Artifact lines are explained in the README")).toBeNull();
    expect(sentArtifacts("Fix the bug")).toBeNull();
  });

  it("reads the daemon's notes, a blank line, then the artifact lines, as the agent gets them", () => {
    const text = [
      "Add search changed since you last read it: /refs/s1/plan-search",
      "The artifact in /refs/s1/design-settings-page was deleted in its home; that folder keeps its last copy.",
      "",
      'Artifact "Add search" (plan, live, read only): /refs/s1/plan-search. It always holds the latest version; it changes only in its home.',
      "",
      "Build the results page.",
    ].join("\n");
    expect(sentArtifacts(text)).toEqual({
      refs: [{ name: "Add search", kind: "plan", folder: "/refs/s1/plan-search" }],
      notes: [
        { kind: "changed", text: "Add search changed since you last read it" },
        { kind: "deleted", text: "An artifact was deleted in its home; its last copy stays" },
      ],
      rest: "Build the results page.",
    });
  });

  it("takes a note only when it names a folder", () => {
    expect(sentArtifacts("The tests changed since you last read it: see above\n\nok")).toBeNull();
  });
});

describe("starting a session from an artifact", () => {
  it("names the session for what it does with it", () => {
    expect(artifactSessionName({ kind: "plan", name: "Add search to the product list" })).toBe("Implement Add search to the product list");
    expect(artifactSessionName({ kind: "design", name: "Settings page" })).toBe("Build Settings page");
  });

  it("asks what was typed, else to implement the plan or build the design", () => {
    expect(startMessage("plan", "  Keep the sort order.  ")).toBe("Keep the sort order.");
    expect(startMessage("plan", " ")).toBe("Implement the plan.");
    expect(startMessage("design", "")).toBe("Build the design.");
  });

  it("says in the prompt what an empty one does", () => {
    expect(startPlaceholder("plan")).toBe("Anything to add? Leave empty to implement the plan.");
    expect(startPlaceholder("design")).toBe("Anything to add? Leave empty to build the design.");
  });
});

describe("startRefusal", () => {
  const plan = { host: "local", name: "Add search", kind: "plan" as const };
  it("starts with Claude or Codex, on the artifact's own Mac", () => {
    expect(startRefusal(plan, "local", "claude")).toBeNull();
    expect(startRefusal(plan, "local", "codex")).toBeNull();
  });
  it("says why it cannot otherwise, before any session is made", () => {
    expect(startRefusal(plan, "studio", "claude")).toBe("Add search is on another host: a session refers to the artifacts of its own host for now");
    expect(startRefusal(plan, "local", "none")).toBe("Start a session from a plan with Claude or Codex: only their chats are sent its reference");
    expect(startRefusal({ ...plan, kind: "design" }, "local", "gemini")).toBe("Start a session from a design with Claude or Codex: only their chats are sent its reference");
  });
});

describe("KIND_WORDS", () => {
  it("names each kind as the app shows it", () => {
    expect(KIND_WORDS).toEqual({ plan: "Plan", design: "Design" });
  });
});

describe("used by", () => {
  it("counts the sessions that refer to a design, its own session left out", () => {
    const used = { mac: { "design:workspace:w1:settings-page": ["s2", "s3"], "design:session:a1b2c3d4e5f6:checkout-flow": ["a1b2c3d4e5f6", "s4"] } };
    const rows = artifactRows(input({ plans: {}, used }), "design", "", {});
    expect(rows.map((r) => [r.info.name, r.info.used_by, r.usedBy])).toEqual([
      ["Settings page", ["s2", "s3"], "used by 2"],
      ["Checkout flow", ["s4"], "used by 1"],
      ["Account pages, dark", [], null],
    ]);
  });
});

describe("moveRefusal and copyRefusal", () => {
  const info = (id: string, kind: "plan" | "design", session?: string): ArtifactInfo => ({ id, kind, name: "x", home: { workspace: "w1", session }, updated_at: 0, used_by: [] });
  it("moves only a workspace's own, and says why another cannot", () => {
    expect(moveRefusal(info("plan:w-w1:search", "plan"))).toBeNull();
    expect(moveRefusal(info("design:workspace:w1:settings-page", "design"))).toBeNull();
    expect(moveRefusal(info("plan:a1b2c3d4e5f6:search", "plan", "a1b2c3d4e5f6"))).toBe("A session's plan can only be copied");
    expect(moveRefusal(info("design:session:a1b2c3d4e5f6:checkout", "design", "a1b2c3d4e5f6"))).toBe("A session's design can only be copied");
    expect(moveRefusal(info("design:library:settings-page", "design"))).toBe("A shared design moves with Stop sharing");
    expect(moveRefusal(info("design:project:p1:settings-page", "design"))).toBe("A merged design stays in its project");
  });
  it("copies any but a merged design, which Design mode copies", () => {
    expect(copyRefusal(info("design:session:a1b2c3d4e5f6:checkout", "design", "a1b2c3d4e5f6"))).toBeNull();
    expect(copyRefusal(info("design:project:p1:settings-page", "design"))).toBe("Copy a merged design from Design mode");
  });
});
