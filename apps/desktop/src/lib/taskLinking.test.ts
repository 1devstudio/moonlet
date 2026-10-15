import { describe, expect, it } from "vitest";
import { acceptanceCriteria, findPasted, linkChoices } from "./taskLinking";
import type { Task } from "./tasks";

const task = (key: string, title: string, o: Partial<Task> = {}): Task => ({
  connection: "linear:acme",
  key,
  title,
  url: "",
  column: "todo",
  priority: 0,
  assignees: [],
  labels: [],
  description: "",
  updatedMs: 0,
  ...o,
});

describe("acceptanceCriteria (X46 Task tab)", () => {
  it("reads checklist items from the description", () => {
    const md = "Add a Hosts section.\n\n- [x] Hosts section lists every connected moonletd\n- [X] Sessions grouped under their host\n- [ ] Reconnecting hosts show an amber dot\n";
    expect(acceptanceCriteria(md)).toEqual([
      { text: "Hosts section lists every connected moonletd", done: true },
      { text: "Sessions grouped under their host", done: true },
      { text: "Reconnecting hosts show an amber dot", done: false },
    ]);
  });

  it("reads the bullets of a section titled Acceptance criteria, not done", () => {
    const md = "Drop a session row on another section header.\n\n## Acceptance criteria\n- Dragging shows a drop line\n* Dropping saves the order\n\n## Notes\n- not a criterion";
    expect(acceptanceCriteria(md)).toEqual([
      { text: "Dragging shows a drop line", done: false },
      { text: "Dropping saves the order", done: false },
    ]);
  });

  it("finds none in plain text", () => {
    expect(acceptanceCriteria("Back off and retry when Notion answers 429.")).toEqual([]);
  });
});

describe("linkChoices (X46 link dialog)", () => {
  const themes = task("CDK-41", "Changelog themes", { column: "in_progress", updatedMs: 5 });
  const dark = task("CDK-44", "Dark theme for public changelog", { updatedMs: 9 });
  const retry = task("CDK-38", "Retry Notion sync on rate limits", { updatedMs: 7 });
  const tasks = [themes, dark, retry];

  it("suggests tasks whose title is the session's name or whose key is in its branch, with the reason", () => {
    const c = linkChoices({ name: "Changelog themes", branch: "themes" }, tasks, "");
    expect(c.suggested.map((s) => [s.task.key, s.reason])).toEqual([["CDK-41", "Title matches the session name"]]);
    const b = linkChoices({ name: "Retries", branch: "cdk-38-retries" }, tasks, "");
    expect(b.suggested.map((s) => [s.task.key, s.reason])).toEqual([["CDK-38", "Branch carries the key"]]);
  });

  it("lists the rest by most recently updated, and filters both by the typed text", () => {
    const c = linkChoices({ name: "Changelog themes", branch: "themes" }, tasks, "");
    expect(c.recent.map((t) => t.key)).toEqual(["CDK-44", "CDK-38"]);
    const q = linkChoices({ name: "Changelog themes", branch: "themes" }, tasks, "dark");
    expect([q.suggested.length, q.recent.map((t) => t.key)]).toEqual([0, ["CDK-44"]]);
    expect(linkChoices({ name: "x", branch: "x" }, tasks, "cdk-38").recent.map((t) => t.key)).toEqual(["CDK-38"]);
  });
});

describe("findPasted", () => {
  const gh = task("acme/web#42", "Fix checkout", { connection: "github:github.com", github: { repo: "acme/web", number: 42, closingPrs: [] } });
  const tasks = [task("MOON-142", "Remote hosts"), gh];

  it("finds the task a pasted key or URL names among the loaded tasks", () => {
    expect(findPasted({ kind: null, key: "MOON-142", site: null }, tasks, null)).toBe(tasks[0]);
    expect(findPasted({ kind: "github", key: "acme/web#42", site: null }, tasks, null)).toBe(gh);
    // `#42` means that number in the project's own repository.
    expect(findPasted({ kind: "github", key: "#42", site: null }, tasks, "acme/web")).toBe(gh);
    expect(findPasted({ kind: "github", key: "#42", site: null }, tasks, "other/repo")).toBe(null);
    expect(findPasted({ kind: "jira", key: "OPS-12", site: "acme.atlassian.net" }, tasks, null)).toBe(null);
  });
});
