// Tasks mode (X45) with GitHub Issues (X44): the board shows the project's
// issues with the sessions working on them, and a session opens from its card.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { choose, fill, PROJECT, projectId, rpc, sel, SESSION, world } from "../fixtures";

interface Session {
  id: string;
  name: string;
  branch: string;
  task?: { connection: string; key: string; url: string } | null;
}

const w = world();
const fakeGh = join(w.root, "bin", "gh");
const ghLog = join(w.root, "gh.log");
const asked = () => (existsSync(ghLog) ? readFileSync(ghLog, "utf8") : "");
const git = (...args: string[]) => execFileSync("git", args, { cwd: w.repo, env: w.env, stdio: "pipe" });
// `gh issue list --json …` as gh prints it, trimmed to the fields moonlet reads.
const ISSUES = JSON.stringify([
  {
    number: 12,
    title: "Fix checkout button",
    body: "The checkout button does nothing on Safari.",
    url: "https://github.com/acme/storefront/issues/12",
    state: "OPEN",
    stateReason: "",
    assignees: [{ login: "sam-rivera" }],
    labels: [{ name: "bug" }],
    updatedAt: "2026-10-14T10:00:00Z",
    closedByPullRequestsReferences: [],
  },
  {
    number: 15,
    title: "Gift cards at checkout",
    body: "",
    url: "https://github.com/acme/storefront/issues/15",
    state: "OPEN",
    stateReason: "",
    assignees: [{ login: "sam-rivera" }],
    labels: [],
    updatedAt: "2026-10-13T10:00:00Z",
    closedByPullRequestsReferences: [],
  },
]);

// `gh issue view 99 --repo acme/other`: an issue outside the workspace's repositories.
const OTHER_ISSUE = JSON.stringify({
  number: 99,
  title: "Shared design tokens",
  body: "",
  url: "https://github.com/acme/other/issues/99",
  state: "OPEN",
  stateReason: "",
  assignees: [],
  labels: [],
  updatedAt: "2026-10-12T10:00:00Z",
  closedByPullRequestsReferences: [],
});

const LINKED = "Checkout on Safari";
const tasksButton = () => $('//div[@role="group"][@aria-label="Mode"]/button[starts-with(@aria-label, "Tasks")]');
const sessionsButton = () => $('//div[@role="group"][@aria-label="Mode"]/button[@aria-label="Sessions"]');
const card = (key: string, column: string) => $(`//section[@aria-label=${JSON.stringify(column)}]//article[starts-with(@aria-label, ${JSON.stringify(key)})]`);
let linkedId = "";

describe("Tasks mode", () => {
  before(() => {
    // gh answers the issue list and records issue edits; anything else fails, as with no gh at all.
    writeFileSync(
      fakeGh,
      `#!/bin/sh\nif [ "$1 $2" = "issue list" ]; then cat <<'JSON'\n${ISSUES}\nJSON\nexit 0; fi\nif [ "$1 $2" = "issue edit" ] || [ "$1 $2" = "issue close" ]; then echo "$@" >> "${ghLog}"; exit 0; fi\nif [ "$1 $2 $3 $4 $5" = "issue view 99 --repo acme/other" ]; then cat <<'JSON'\n${OTHER_ISSUE}\nJSON\nexit 0; fi\nexit 1\n`,
    );
    chmodSync(fakeGh, 0o755);
    // GIT_ALLOW_PROTOCOL=file in the e2e env keeps git from ever reaching github.com.
    git("remote", "add", "origin", "https://github.com/acme/storefront.git");
    linkedId = rpc<{ id: string }>(w, "session.create", { project_id: projectId(w), name: LINKED, branch: "12-fix-checkout", agent: "none" }).id;
  });

  // The app keeps the layout and open rows across restarts, and localStorage
  // outlives a run: start and end from the defaults.
  const forgetLayout = () => browser.execute(() => ["moonlet.tasks.layout", "moonlet.tasks.expanded"].forEach((k) => localStorage.removeItem(k)));
  before(async () => {
    await forgetLayout();
    // The store read them when the app started.
    await browser.refresh();
    await tasksButton().waitForDisplayed({ timeout: 15_000 });
  });

  after(async () => {
    if (await sessionsButton().isExisting()) await sessionsButton().click();
    await forgetLayout();
    await browser.execute((id: string) => localStorage.removeItem(`moonlet.composer.${id}`), projectId(w));
    for (const s of rpc<Session[]>(w, "session.list", {})) {
      // The seeded session is shared with other specs: unlink it, don't archive it.
      if (s.name === SESSION) rpc(w, "session.update", { id: s.id, task: null });
      else if (s.id === linkedId || s.task) rpc(w, "session.archive", { id: s.id });
    }
    git("remote", "remove", "origin");
    rmSync(fakeGh, { force: true });
  });

  it("shows the project's GitHub issues with the sessions working on them", async () => {
    await expect($(sel.text(PROJECT))).toBeDisplayed({ wait: 30_000 });
    await tasksButton().click();
    await expect(card("acme/storefront#12", "In Progress")).toBeDisplayed({ wait: 30_000 });
    await expect(card("acme/storefront#15", "Todo")).toBeDisplayed();
    await expect(card("acme/storefront#12", "In Progress").$(sel.text(LINKED))).toBeDisplayed();
    await expect(card("acme/storefront#15", "Todo").$(sel.text("No sessions"))).toBeDisplayed();
  });

  it("opens a session from its card in Sessions mode", async () => {
    await card("acme/storefront#12", "In Progress").$(`.//button[.//span[normalize-space()=${JSON.stringify(LINKED)}]]`).click();
    await expect(sessionsButton()).toHaveAttribute("aria-pressed", "true");
    await expect($(sel.sessionRow(LINKED))).toHaveAttribute("aria-current", "true");
  });

  it("lists sessions without a task, with the issue their name looks like", async () => {
    await tasksButton().click();
    await $('//nav[@aria-label="Views"]//button[starts-with(normalize-space(), "Sessions without a task")]').click();
    const row = $(`//section[@aria-label="Sessions without a task"]/div[.//span[normalize-space()=${JSON.stringify(SESSION)}]]`);
    await expect(row).toBeDisplayed();
    await expect(row.$(sel.text("Looks like acme/storefront#12 Fix checkout button"))).toBeDisplayed();
    await $('//nav[@aria-label="Views"]//button[starts-with(normalize-space(), "My issues")]').click();
  });

  it("starts a session from a task with the issue as the first message, its branch and the link", async () => {
    // "Terminal only", so no agent starts (the composer reads this each time it opens).
    await browser.execute((id: string) => localStorage.setItem(`moonlet.composer.${id}`, JSON.stringify({ agent: "none", model: null, effort: null })), projectId(w));
    await card("acme/storefront#15", "Todo").$(sel.button("Start")).click();
    await expect($(sel.text("For acme/storefront#15"))).toBeDisplayed();
    await expect($('//textarea[@placeholder="What do you want to work on?"]')).toHaveValue("acme/storefront#15 · Gift cards at checkout");
    // Keep in step: "session starts" is Automatically, so the issue is assigned (X46).
    await expect($('//label[normalize-space()="Assign acme/storefront#15 to me"]/input')).toBeSelected();
    // ⌘↵ at once, without waiting for the branch name to show: Create waits for it.
    await $('//textarea[@placeholder="What do you want to work on?"]').click();
    await browser.keys(["Meta", "Enter"]);

    await expect($(sel.sessionRow("Gift cards at checkout"))).toBeDisplayed({ wait: 30_000 });
    await expect(sessionsButton()).toHaveAttribute("aria-pressed", "true");
    const created = rpc<Session[]>(w, "session.list", {}).find((s) => s.name === "Gift cards at checkout");
    expect(created?.branch).toBe("15-gift-cards-at-checkout");
    expect(created?.task).toEqual({ connection: "github:github.com", key: "acme/storefront#15", url: "https://github.com/acme/storefront/issues/15" });
    await browser.waitUntil(() => asked().includes("issue edit 15 --add-assignee @me"), { timeout: 10_000, timeoutMsg: `gh was asked: ${asked()}` });
  });

  it("starts a session on a worktree made outside moonlet, keeping its project", async () => {
    const dir = join(w.root, "wt-12-orphan-fix");
    git("worktree", "add", "-q", "-b", "12-orphan-fix", dir);
    try {
      await tasksButton().click();
      await $('//button[@title="Refresh tasks"]').click();
      // #12 has sessions, so its worktree without one is in the detail panel.
      await card("acme/storefront#12", "In Progress").$('//button[normalize-space()="Fix checkout button"]').click();
      const start = $('//aside[@aria-label="Task detail"]').$(sel.button("Start session"));
      await start.waitForDisplayed({ timeout: 15_000 });
      await start.click();
      await expect($(sel.text("12-orphan-fix · existing worktree"))).toBeDisplayed({ wait: 10_000 });
      // The worktree belongs to its project: the picker stays put.
      await expect($('//button[@title="This worktree belongs to this project"]')).toBeDisabled();
      await $(sel.button("Create")).click();
      await browser.waitUntil(() => rpc<(Session & { branch?: string })[]>(w, "session.list", {}).some((x) => x.branch === "12-orphan-fix"), {
        timeout: 15_000,
        timeoutMsg: "no session on the existing worktree",
      });
    } finally {
      for (const x of rpc<(Session & { branch?: string })[]>(w, "session.list", {})) if (x.branch === "12-orphan-fix") rpc(w, "session.archive", { id: x.id });
      try {
        git("worktree", "remove", "--force", dir);
      } catch {
        // Archiving removed it already.
      }
      try {
        git("branch", "-D", "12-orphan-fix");
      } catch {
        // Already gone.
      }
      if (await sessionsButton().isExisting()) await sessionsButton().click();
    }
  });

  it("puts Closes #N in the new PR of a session working on a GitHub issue", async () => {
    await $(sel.sessionRow("Gift cards at checkout")).click();
    await browser.keys(["Shift", "Meta", "p"]);
    await expect($('//*[@role="dialog"]//textarea')).toHaveValue("Closes #15", { wait: 10_000 });
    await browser.keys(["Escape"]);
  });

  it("shows a linked session's task above the conversation and in the Task tab, and unlinks it", async () => {
    await $(sel.sessionRow(LINKED)).click();
    const bar = $('//*[@role="region"][@aria-label="Task"]');
    await expect(bar.$(sel.text("acme/storefront#12"))).toBeDisplayed({ wait: 30_000 });
    await expect(bar.$(sel.text("Fix checkout button"))).toBeDisplayed();
    await $('//button[@role="tab"][normalize-space()="Task"]').click();
    await expect($('//section[@aria-label="Sessions on this task"]').$(sel.text("this session"))).toBeDisplayed();
    await $('//*[@role="tabpanel"]//button[normalize-space()="Unlink"]').click();
    await expect(bar).not.toBeExisting({ wait: 10_000 });
    const s = rpc<(Session & { task_unlinked?: boolean })[]>(w, "session.list", {}).find((x) => x.id === linkedId);
    expect([s?.task ?? null, s?.task_unlinked]).toEqual([null, true]);
  });

  it("links a session to a task from a pasted key", async () => {
    await tasksButton().click();
    await $('//nav[@aria-label="Views"]//button[starts-with(normalize-space(), "Sessions without a task")]').click();
    await $(`//section[@aria-label="Sessions without a task"]/div[.//span[normalize-space()=${JSON.stringify(SESSION)}]]//button[normalize-space()="Link to task"]`).click();
    // An issue outside the workspace's tasks is asked of gh.
    await fill('//input[@placeholder="Search tasks, or paste a key or URL"]', "https://github.com/acme/other/issues/99");
    await expect($('//section[@aria-label="Pasted"]//button[.//span[normalize-space()="acme/other#99"]]')).toBeDisplayed({ wait: 10_000 });
    // ↵ at once links the pasted task: it waits for the lookup.
    await fill('//input[@placeholder="Search tasks, or paste a key or URL"]', "#12");
    await browser.keys("Enter");
    await browser.waitUntil(() => rpc<Session[]>(w, "session.list", {}).find((x) => x.name === SESSION)?.task?.key === "acme/storefront#12", {
      timeout: 10_000,
      timeoutMsg: "the seeded session was not linked to acme/storefront#12",
    });
    await $('//nav[@aria-label="Views"]//button[starts-with(normalize-space(), "My issues")]').click();
  });

  it("shows the same tasks as a list whose rows open into their sessions", async () => {
    await $('//div[@role="group"][@aria-label="Layout"]/button[normalize-space()="List"]').click();
    const row = $('//section[@aria-label="In Progress"]//div[@role="row"][starts-with(@aria-label, "acme/storefront#15")]');
    await expect(row).toBeDisplayed({ wait: 10_000 });
    await expect(row.$(sel.text("1 session"))).toBeDisplayed();
    await row.$('button[aria-label="Expand acme/storefront#15"]').click();
    await expect(row.$('//button[normalize-space()="Gift cards at checkout"]')).toBeDisplayed();
    await expect($('//section[@aria-label="Todo"]')).toBeDisplayed();
    // Expand all opens every row; Collapse all closes them.
    const twelve = $('button[aria-label="Expand acme/storefront#12"], button[aria-label="Collapse acme/storefront#12"]');
    await $(sel.button("Expand all")).click();
    await expect(twelve).toHaveAttribute("aria-expanded", "true");
    await $(sel.button("Collapse all")).click();
    await expect(twelve).toHaveAttribute("aria-expanded", "false");
    await expect(row.$('button[aria-label="Expand acme/storefront#15"]')).toHaveAttribute("aria-expanded", "false");
    await $('//div[@role="group"][@aria-label="Layout"]/button[normalize-space()="Board"]').click();
    // The board's Done column opens the list.
    await $('//button[starts-with(@aria-label, "Done: ")]').click();
    await expect($('//div[@role="group"][@aria-label="Layout"]/button[normalize-space()="List"]')).toHaveAttribute("aria-pressed", "true");
    await $('//div[@role="group"][@aria-label="Layout"]/button[normalize-space()="Board"]').click();
  });

  it("shows a linked session's task under its name in the sidebar", async () => {
    await sessionsButton().click();
    const row = $(sel.sessionRow("Gift cards at checkout"));
    await expect(row.$('//span[@title="acme/storefront#15 · Gift cards at checkout"]')).toBeDisplayed({ wait: 10_000 });
    await expect(row.$(sel.text("acme/storefront#15"))).toBeDisplayed();
  });

  it("groups the sidebar's sessions by task, each group headed by its task", async () => {
    type Sec = { id: string; project_ids: string[]; view: { group_by: string; sort_by: string; filter: string[] } };
    const sec = rpc<Sec[]>(w, "section.list", {}).find((x) => x.project_ids.includes(projectId(w)))!;
    rpc(w, "section.update", { id: sec.id, view: { ...sec.view, group_by: "task" } });
    try {
      await expect($(sel.text("acme/storefront#15 Gift cards at checkout"))).toBeDisplayed({ wait: 10_000 });
      await expect($(sel.text("No task"))).toBeDisplayed();
    } finally {
      rpc(w, "section.update", { id: sec.id, view: sec.view });
    }
  });

  it("finds a task by its title, and closes an issue from the detail's state menu", async () => {
    await tasksButton().click();
    await fill('//input[@placeholder="Find a task"]', "Gift");
    await expect(card("acme/storefront#15", "In Progress")).toBeDisplayed({ wait: 10_000 });
    await expect(card("acme/storefront#12", "In Progress")).not.toBeExisting();
    await fill('//input[@placeholder="Find a task"]', "");
    await card("acme/storefront#15", "In Progress").$('//button[normalize-space()="Gift cards at checkout"]').click();
    await choose('//select[@aria-label="State of acme/storefront#15"]', "1");
    await browser.waitUntil(() => asked().includes("issue close 15 --reason completed"), { timeout: 10_000, timeoutMsg: `gh was asked: ${asked()}` });
    await expect($('//section[@aria-label="Activity"]').$(sel.text("moonlet closed it"))).toBeDisplayed({ wait: 10_000 });
    await sessionsButton().click();
  });
});
