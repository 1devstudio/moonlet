import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "./tasks";
import { commentsView, ensureComments, loadComments, useComments } from "./taskComments";

/** The commands' answers per call, and what was asked. */
const tracker = vi.hoisted(() => ({ comments: [] as (() => Promise<unknown>)[], asked: [] as string[] }));
const answers = vi.hoisted(() => ({} as Record<string, (p: object) => unknown>));
vi.mock("./daemon", () => ({
  rpc: vi.fn((_host: string, method: string, params: object) => {
    const answer = answers[method];
    return answer ? Promise.resolve().then(() => answer(params)) : Promise.reject(new Error(`no ${method}`));
  }),
  hostsApi: {
    trackerComments: (id: string, task: string) => {
      tracker.asked.push(`${id} ${task}`);
      const next = tracker.comments.shift();
      return next ? next() : Promise.reject(new Error("no tracker_comments"));
    },
  },
}));

const NOW = Date.parse("2026-10-23T12:00:00Z");

const linear: Task = {
  connection: "linear:acme",
  key: "ENG-124",
  title: "Add dark mode to settings page",
  url: "https://linear.app/acme/issue/ENG-124",
  column: "in_progress",
  priority: 2,
  assignees: [],
  labels: [],
  description: "",
  updatedMs: NOW - 3_600_000,
  tracker: { id: "9cfb482a-81e3-4154-b5b9-2c805e70a02d", state: "In Progress", source: "ENG" },
};

const issue: Task = {
  connection: "github:github.com",
  key: "acme/web#12",
  title: "Gift cards",
  url: "https://github.com/acme/web/issues/12",
  column: "open",
  priority: 0,
  assignees: [],
  labels: [],
  description: "",
  updatedMs: NOW - 86_400_000,
  github: { repo: "acme/web", number: 12, closingPrs: [] },
};

beforeEach(() => {
  useComments.setState({ byTask: {} });
  tracker.comments.length = 0;
  tracker.asked.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
});

describe("a task's comments (X66)", () => {
  it("lists a tracker issue's comments oldest first with author, age and body", async () => {
    tracker.comments.push(() =>
      Promise.resolve({
        comments: [
          { id: "c1", author: "Ada Lovelace", body: "Can we **also** cover it?", markdown: true, createdMs: NOW - 2 * 3_600_000 },
          { id: "c2", author: "", body: "On it.", markdown: true, createdMs: NOW - 30_000 },
        ],
        more: false,
      }),
    );
    await ensureComments(linear, { host: "local", path: null });
    expect(tracker.asked).toEqual(["linear:acme 9cfb482a-81e3-4154-b5b9-2c805e70a02d"]);
    expect(commentsView(useComments.getState().byTask["linear:acme ENG-124"], linear, NOW)).toEqual({
      heading: "Comments 2",
      status: null,
      rows: [
        { id: "c1", author: "Ada Lovelace", ago: "2 h ago", createdMs: NOW - 2 * 3_600_000, body: "Can we **also** cover it?", markdown: true },
        { id: "c2", author: "Someone", ago: "just now", createdMs: NOW - 30_000, body: "On it.", markdown: true },
      ],
      more: null,
    });
  });

  it("reads a GitHub issue's comments through gh in its repository's project", async () => {
    const asked: object[] = [];
    answers["gh.issue_comments"] = (p) => (
      asked.push(p),
      { comments: [{ id: "IC_e2e0001", author: "@sam-rivera", body: "Looks good.", created_ms: NOW - 3 * 86_400_000 }], more: true }
    );
    await ensureComments(issue, { host: "local", path: "/Users/sam/web" });
    expect(asked).toEqual([{ path: "/Users/sam/web", number: 12 }]);
    expect(commentsView(useComments.getState().byTask["github:github.com acme/web#12"], issue, NOW)).toMatchObject({
      heading: "Comments 1",
      rows: [{ author: "@sam-rivera", ago: "3 days ago", body: "Looks good.", markdown: true }],
      more: "More comments are in GitHub",
    });
  });

  it("says no project has a GitHub issue's repository, and loads again on Retry", async () => {
    await ensureComments(issue, { host: "local", path: null });
    const e = useComments.getState().byTask["github:github.com acme/web#12"];
    expect(e.error).toBe("No project in this workspace has acme/web as its origin");
    expect(commentsView(e, issue, NOW)).toMatchObject({ heading: "Comments 0", status: null, rows: [] });
    answers["gh.issue_comments"] = () => ({ comments: [], more: false });
    await loadComments(issue, { host: "local", path: "/Users/sam/web" });
    const after = useComments.getState().byTask["github:github.com acme/web#12"];
    expect(after.error).toBeNull();
    expect(commentsView(after, issue, NOW).status).toBe("empty");
  });

  it("shows loading until the first answer, and keeps the comments shown while they load again", async () => {
    let answer = (_: object) => {};
    tracker.comments.push(() => new Promise((r) => (answer = r)));
    const first = ensureComments(linear, { host: "local", path: null });
    expect(commentsView(useComments.getState().byTask["linear:acme ENG-124"], linear, NOW).status).toBe("loading");
    answer({ comments: [{ id: "c1", author: "Ada Lovelace", body: "Hi", markdown: true, createdMs: NOW }], more: false });
    await first;
    tracker.comments.push(() => new Promise((r) => (answer = r)));
    const again = loadComments(linear, { host: "local", path: null });
    expect(commentsView(useComments.getState().byTask["linear:acme ENG-124"], linear, NOW)).toMatchObject({ status: null, rows: [{ id: "c1" }] });
    answer({ comments: [], more: false });
    await again;
  });

  it("loads again only once the task's updated time changes", async () => {
    const none = () => Promise.resolve({ comments: [], more: false });
    tracker.comments.push(none, none);
    await ensureComments(linear, { host: "local", path: null });
    await ensureComments(linear, { host: "local", path: null });
    expect(tracker.asked).toHaveLength(1);
    await ensureComments({ ...linear, updatedMs: NOW }, { host: "local", path: null });
    expect(tracker.asked).toHaveLength(2);
  });

  it("drops an older load's answer that lands after a newer one", async () => {
    let slow = (_: object) => {};
    tracker.comments.push(
      () => new Promise((r) => (slow = r)),
      () => Promise.resolve({ comments: [{ id: "new", author: "Ada Lovelace", body: "New", markdown: true, createdMs: NOW }], more: false }),
    );
    const older = loadComments(linear, { host: "local", path: null });
    await loadComments(linear, { host: "local", path: null });
    slow({ comments: [], more: false });
    await older;
    expect(useComments.getState().byTask["linear:acme ENG-124"].comments?.map((c) => c.id)).toEqual(["new"]);
  });

  it("loads again for a sync that changes the task while an older load runs", async () => {
    let older = (_: object) => {};
    tracker.comments.push(
      () => new Promise((r) => (older = r)),
      () => Promise.resolve({ comments: [{ id: "c2", author: "Ada Lovelace", body: "Newer", markdown: true, createdMs: NOW }], more: false }),
    );
    const first = ensureComments(linear, { host: "local", path: null });
    await ensureComments({ ...linear, updatedMs: NOW }, { host: "local", path: null });
    expect(tracker.asked).toHaveLength(2);
    older({ comments: [], more: false });
    await first;
    expect(useComments.getState().byTask["linear:acme ENG-124"].comments?.map((c) => c.id)).toEqual(["c2"]);
  });

  it("loads a GitHub issue's comments once its project is known, with no Retry", async () => {
    await ensureComments(issue, { host: "local", path: null });
    expect(useComments.getState().byTask["github:github.com acme/web#12"].error).toBe("No project in this workspace has acme/web as its origin");
    answers["gh.issue_comments"] = () => ({ comments: [{ id: "IC_e2e0001", author: "@sam-rivera", body: "Looks good.", created_ms: NOW }], more: false });
    await ensureComments(issue, { host: "local", path: "/Users/sam/web" });
    const e = useComments.getState().byTask["github:github.com acme/web#12"];
    expect([e.error, e.comments?.length]).toEqual([null, 1]);
  });
});
