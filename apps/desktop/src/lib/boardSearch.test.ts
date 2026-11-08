import { describe, expect, it } from "vitest";
import { previewOf, revealFound, searchBoard, searchFooter } from "./boardSearch";
import type { ColumnView } from "./boardColumns";
import type { Task } from "./tasks";
import type { BoardSession, Card } from "./tasksBoard";

const LINEAR = "linear:acme";
const task = (key: string, title: string, o: Partial<Task> = {}): Task => ({ connection: LINEAR, key, title, url: `https://linear.app/acme/issue/${key}`, column: "todo", priority: 0, assignees: [], labels: [], description: "", updatedMs: 0, ...o });
const session = (name: string, branch: string, state: BoardSession["state"] = "idle"): BoardSession => ({
  id: branch,
  name,
  branch,
  path: `/src/moonlet/${branch}`,
  archived: false,
  task: null,
  task_unlinked: false,
  state,
  pr: null,
  additions: 0,
  subagents: 0,
  originRepo: null,
});
const card = (t: Task, sessions: BoardSession[] = []): Card => ({
  task: t,
  column: "todo",
  rows: sessions.map((s) => ({ session: s, meta: { text: "", tone: "faint" } })),
  archived: [],
  needsYou: false,
  orphans: [],
  empty: sessions.length ? null : "No sessions",
  drift: null,
});
const column = (name: string, category: ColumnView["category"], cards: Card[], folded = false): ColumnView => ({ name, category, folded, cards });

// The design's board, Moonlet · Cycle 14 (Tasks mode · Searching the board).
const MOONLET: ColumnView[] = [
  column("Todo", "todo", [card(task("MOON-151", "Drag sessions between sections")), card(task("MOON-149", "Show remote host health in the sidebar footer"))]),
  column("In Progress", "in_progress", [
    card(task("MOON-142", "Remote hosts sidebar"), [session("Remote hosts sidebar", "moon-142-remote-hosts", "working"), session("Hosts section spike", "moon-142-hosts-spike")]),
    card(task("MOON-147", "Block styling pass"), [session("Block styling pass", "moon-147-block-styling", "blocked")]),
  ]),
  column("In Review", "in_review", [
    card(task("MOON-139", "Live upgrade handoff"), [session("Live upgrade handoff", "moon-139-live-upgrade", "done")]),
    card(task("MOON-136", "Context window meter in the chat footer"), [session("Meter in the composer", "moon-136-context-meter-on-host", "working")]),
  ]),
  column("Done", "done", [card(task("MOON-127", "Reconnect a host after sleep"), [session("Reconnect after sleep", "moon-127-reconnect", "done")])], true),
];

describe("searchBoard (X93 On this board)", () => {
  it("finds the board's tasks by key or title, ignoring case and outer spaces, in the board's column order, marking the matched text", () => {
    const { on } = searchBoard("  SIDEBAR ", MOONLET);
    expect(on.map((r) => r.key.pre + r.key.mid + r.key.post)).toEqual(["MOON-149", "MOON-142"]);
    expect(on[0]).toMatchObject({ id: "linear:acme MOON-149", column: "Todo", category: "todo", title: { pre: "Show remote host health in the ", mid: "sidebar", post: " footer" }, key: { pre: "MOON-149", mid: "", post: "" } });
    expect(on[1]).toMatchObject({ column: "In Progress", category: "in_progress", title: { pre: "Remote hosts ", mid: "sidebar", post: "" } });
    expect(searchBoard("moon-14", MOONLET).on.map((r) => r.key)).toEqual([
      { pre: "", mid: "MOON-14", post: "9" },
      { pre: "", mid: "MOON-14", post: "2" },
      { pre: "", mid: "MOON-14", post: "7" },
    ]);
  });

  it("finds a task by the name of a session on its card, else by that session's branch, naming the session on a second line only then", () => {
    const { on } = searchBoard("host", MOONLET);
    expect(on.map((r) => r.id.split(" ")[1])).toEqual(["MOON-149", "MOON-142", "MOON-136", "MOON-127"]);
    expect(on[1].via).toBeNull();
    expect(on[2].via).toEqual({ what: "branch", text: { pre: "moon-136-context-meter-on-", mid: "host", post: "" }, state: "working" });
    expect(searchBoard("composer", MOONLET).on).toMatchObject([{ id: "linear:acme MOON-136", via: { what: "session", text: { pre: "Meter in the ", mid: "composer", post: "" }, state: "working" } }]);
    // A session's name wins over its branch.
    expect(searchBoard("spike", MOONLET).on[0].via).toEqual({ what: "session", text: { pre: "Hosts section ", mid: "spike", post: "" }, state: "idle" });
    expect(searchBoard("moon-142-remote", MOONLET).on[0].via).toEqual({ what: "branch", text: { pre: "", mid: "moon-142-remote", post: "-hosts" }, state: "working" });
  });

  it("shows the state of each session on the card", () => {
    expect(searchBoard("remote hosts", MOONLET).on[0].sessions).toEqual(["working", "idle"]);
    expect(searchBoard("drag", MOONLET).on[0].sessions).toEqual([]);
  });

  it("finds nothing for an empty or blank query", () => {
    expect(searchBoard("", MOONLET).on).toEqual([]);
    expect(searchBoard("   ", MOONLET).on).toEqual([]);
  });
});

// The workspace's other board, Changedeck · Cycle 9, and what Linear's search found.
const CHANGEDECK = {
  id: "changedeck",
  label: "Changedeck · Cycle 9",
  views: [
    column("In Progress", "in_progress", [
      card(task("CDK-41", "Changelog themes", { column: "in_progress", tracker: { id: "c41", state: "In Progress", source: "CDK" }, description: "Let each changelog pick a theme for its public page. Mentions host-specific CSS in the description." })),
      card(task("CDK-38", "Retry Notion sync on rate limits", { column: "in_progress" })),
    ]),
  ],
};
const MOON_97 = task("MOON-97", "Ask before trusting a new SSH host key", { tracker: { id: "m97", state: "Backlog", source: "MOON" } });
const MOON_118 = task("MOON-118", "Host picker in the composer", { column: "hidden", cycle: 12, tracker: { id: "m118", state: "Canceled", source: "MOON" } });

describe("searchBoard (X93 Not on this board)", () => {
  it("lists the other boards' tasks, by description too, then what each tracker's search found, saying where each is", () => {
    const { off } = searchBoard("host", MOONLET, [CHANGEDECK], [{ connection: LINEAR, tasks: [MOON_97, MOON_118] }]);
    expect(off).toEqual([
      expect.objectContaining({ id: "linear:acme CDK-41", key: { pre: "CDK-41", mid: "", post: "" }, title: { pre: "Changelog themes", mid: "", post: "" }, where: "Changedeck · Cycle 9 · In Progress", state: "In Progress", glyph: "in_progress", backlog: false, board: { id: "changedeck", label: "Changedeck · Cycle 9" } }),
      expect.objectContaining({ id: "linear:acme MOON-97", title: { pre: "Ask before trusting a new SSH ", mid: "host", post: " key" }, where: "Linear · no cycle · Backlog", state: "Backlog", glyph: "todo", backlog: true, board: null }),
      expect.objectContaining({ id: "linear:acme MOON-118", title: { pre: "", mid: "Host", post: " picker in the composer" }, where: "Linear · Cycle 12 · Canceled", glyph: "hidden", backlog: false, board: null }),
    ]);
    expect(off[1].task).toBe(MOON_97);
  });

  it("leaves out what the shown board or another board already lists, and keeps at most 8 of each tracker's tasks", () => {
    const onBoard = task("MOON-149", "Show remote host health in the sidebar footer");
    const cdk41 = CHANGEDECK.views[0].cards[0].task;
    const many = Array.from({ length: 10 }, (_, i) => task(`MOON-${200 + i}`, `Host ${i}`));
    const { off } = searchBoard("host", MOONLET, [CHANGEDECK], [{ connection: LINEAR, tasks: [onBoard, cdk41, ...many] }]);
    expect(off.map((r) => r.id.split(" ")[1])).toEqual(["CDK-41", "MOON-200", "MOON-201", "MOON-202", "MOON-203", "MOON-204", "MOON-205", "MOON-206", "MOON-207"]);
  });

  it("says where a GitHub or Jira issue is by its tracker and state", () => {
    const gh = { ...task("acme/web#12", "Host list", { connection: "github:github.com", column: "open" }), github: { repo: "acme/web", number: 12, closingPrs: [] } };
    const closed = { ...task("acme/web#9", "Old host list", { connection: "github:github.com", column: "done" }), github: { repo: "acme/web", number: 9, closingPrs: [] } };
    const jira = task("OPS-4", "Host alerts", { connection: "jira:acme.atlassian.net", tracker: { id: "10004", state: "To Do", source: "OPS" } });
    const { off } = searchBoard("host", [], [], [{ connection: "github:github.com", tasks: [gh, closed] }, { connection: "jira:acme.atlassian.net", tasks: [jira] }]);
    expect(off.map((r) => r.where)).toEqual(["GitHub · Open", "GitHub · Closed", "Jira · To Do"]);
    expect(off.map((r) => r.glyph)).toEqual(["todo", "done", "todo"]);
  });
});

describe("searchFooter (X93 the dropdown's footer and No match)", () => {
  it("counts the results", () => {
    expect(searchFooter(searchBoard("drag", MOONLET), ["Linear"]).count).toBe("1 result");
    expect(searchFooter(searchBoard("host", MOONLET, [CHANGEDECK], [{ connection: LINEAR, tasks: [MOON_97, MOON_118] }]), ["Linear"]).count).toBe("7 results");
  });

  it("says nothing matched, and where it searched, naming the trackers", () => {
    expect(searchFooter(searchBoard("xyzzy", MOONLET), ["Linear"]).none).toBe("Searched this board, your other boards and Linear.");
    expect(searchFooter(searchBoard("xyzzy", MOONLET), ["Linear", "Jira"]).none).toBe("Searched this board, your other boards, Linear and Jira.");
    expect(searchFooter(searchBoard("xyzzy", MOONLET), []).none).toBe("Searched this board and your other boards.");
    expect(searchFooter(searchBoard("host", MOONLET), ["Linear"]).none).toBeNull();
  });
});

describe("revealFound (X93 a found card in a folded column)", () => {
  it("opens the folded column that holds the found task, saying why, and leaves the others as they are", () => {
    const shown = revealFound(MOONLET, "linear:acme MOON-127");
    expect(shown.map((v) => [v.name, v.folded, v.note ?? null])).toEqual([
      ["Todo", false, null],
      ["In Progress", false, null],
      ["In Review", false, null],
      ["Done", false, "unfolded to show MOON-127"],
    ]);
    expect(revealFound(MOONLET, "linear:acme MOON-142").map((v) => v.folded)).toEqual([false, false, false, true]);
    expect(revealFound(MOONLET, null).map((v) => v.folded)).toEqual([false, false, false, true]);
  });
});

describe("previewOf (X93 the preview of a task not on the board)", () => {
  const off = searchBoard("host", MOONLET, [CHANGEDECK], [{ connection: LINEAR, tasks: [MOON_97, MOON_118] }]).off;
  const shown = "Moonlet · Cycle 14";

  it("offers to switch to the other board that has it", () => {
    expect(previewOf(off[0], shown)).toEqual({ why: "This task is on Changedeck · Cycle 9. Switching shows it there with its columns.", action: { kind: "switch", board: "changedeck", label: "Switch to Changedeck · Cycle 9" } });
  });

  it("says the board can't show a task its tracker has elsewhere, with no action", () => {
    expect(previewOf(off[1], shown)).toEqual({ why: "This task is in Linear but not on Moonlet · Cycle 14, so the board can’t show it. You can still start a session from here.", action: null });
  });

  it("offers to reopen a finished task on no board", () => {
    expect(previewOf(off[2], shown)).toEqual({ why: "This task is Canceled in Linear, so the board doesn’t show it.", action: { kind: "reopen", label: "Reopen in Linear" } });
    const closed = { ...task("acme/web#9", "Old host list", { connection: "github:github.com", column: "done" }), github: { repo: "acme/web", number: 9, closingPrs: [] } };
    const [row] = searchBoard("host", [], [], [{ connection: "github:github.com", tasks: [closed] }]).off;
    expect(previewOf(row, shown)).toEqual({ why: "This task is Closed in GitHub, so the board doesn’t show it.", action: { kind: "reopen", label: "Reopen in GitHub" } });
  });
});
