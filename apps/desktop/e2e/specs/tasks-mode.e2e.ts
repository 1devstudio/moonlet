// Tasks mode (X45) with GitHub Issues (X44): the board shows the project's
// issues with the sessions working on them, and a session opens from its card.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { choose, closeSettings, fill, openSettings, PROJECT, projectId, rpc, sel, SESSION, world } from "../fixtures";

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
  // Done, with a worktree left (made in `before`): it needs clean-up.
  { number: 16, title: "Old banner", body: "", url: "https://github.com/acme/storefront/issues/16", state: "CLOSED", stateReason: "COMPLETED", assignees: [{ login: "sam-rivera" }], labels: [], updatedAt: "2026-10-12T10:00:00Z", closedByPullRequestsReferences: [] },
  // Done, with nothing left.
  { number: 17, title: "Typo in footer", body: "", url: "https://github.com/acme/storefront/issues/17", state: "CLOSED", stateReason: "COMPLETED", assignees: [{ login: "sam-rivera" }], labels: [], updatedAt: "2026-10-11T10:00:00Z", closedByPullRequestsReferences: [] },
  // Open, with a worktree and no session (made in `before`).
  { number: 18, title: "Orphan work", body: "", url: "https://github.com/acme/storefront/issues/18", state: "OPEN", stateReason: "", assignees: [{ login: "sam-rivera" }], labels: [], updatedAt: "2026-10-10T10:00:00Z", closedByPullRequestsReferences: [] },
  // Open, with no session at all.
  { number: 19, title: "Saved carts", body: "", url: "https://github.com/acme/storefront/issues/19", state: "OPEN", stateReason: "", assignees: [{ login: "sam-rivera" }], labels: [], updatedAt: "2026-10-09T10:00:00Z", closedByPullRequestsReferences: [] },
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
// While this file exists, the fake gh fails to list issues.
const ghFails = join(w.root, "gh-fails");
// While this file exists, gh lacks the read:project scope (X50 GitHub Projects).
const ghNoScope = join(w.root, "gh-no-scope");
// While this file exists, gh lacks the project scope that moves need.
const ghNoMove = join(w.root, "gh-no-move");
// gh's GraphQL answers for GitHub Projects, captured and sanitised (crates/moonlet-core/tests/fixtures).
const ghFixture = (name: string) => join(process.cwd(), "../../crates/moonlet-core/tests/fixtures", name);
const wt16 = join(w.root, "wt-16-old-banner");
const wt18 = join(w.root, "wt-18-orphan-work");
const tasksButton = () => $('//div[@role="group"][@aria-label="Mode"]/button[starts-with(@aria-label, "Tasks")]');
const sessionsButton = () => $('//div[@role="group"][@aria-label="Mode"]/button[@aria-label="Sessions"]');
const card = (key: string, column: string) => $(`//section[@aria-label=${JSON.stringify(column)}]//article[starts-with(@aria-label, ${JSON.stringify(key)})]`);
let linkedId = "";

describe("Tasks mode", () => {
  before(() => {
    // gh answers the issue list and records issue edits; anything else fails, as with no gh at all.
    writeFileSync(
      fakeGh,
      `#!/bin/sh\nif [ "$1 $2" = "issue list" ] && [ -e "${ghFails}" ]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi\nif [ "$1 $2" = "issue list" ]; then cat <<'JSON'\n${ISSUES}\nJSON\nexit 0; fi\nif [ "$1 $2" = "issue edit" ] || [ "$1 $2" = "issue close" ]; then echo "$@" >> "${ghLog}"; exit 0; fi\nif [ "$1 $2 $3 $4 $5" = "issue view 99 --repo acme/other" ]; then cat <<'JSON'\n${OTHER_ISSUE}\nJSON\nexit 0; fi\nif [ "$1 $2" = "api graphql" ] && [ -e "${ghNoScope}" ]; then cat '${ghFixture("gh-error-read-project-scope.json")}'; exit 1; fi\nif [ "$1 $2" = "auth status" ] && [ -e "${ghNoMove}" ]; then sed "s/'project', //" '${ghFixture("gh-auth-status.txt")}'; exit 0; fi\nif [ "$1 $2" = "auth status" ]; then cat '${ghFixture("gh-auth-status.txt")}'; exit 0; fi\ncase "$*" in *addProjectV2ItemById*) echo "$@" >> "${ghLog}"; cat '${ghFixture("gh-project-add.json")}'; exit 0;; *"/issues -X POST"*) echo "$@" >> "${ghLog}"; sed -e 's#issues/1"#issues/57"#g' -e 's/"number": 1,/"number": 57,/' -e 's#acme/web#acme/storefront#g' '${ghFixture("gh-issue-create.json")}'; exit 0;; "api user --jq .login") echo sam-rivera; exit 0;; *"/assignees?per_page=100") cat '${ghFixture("gh-assignees.json")}'; exit 0;; *"/labels?per_page=100") cat '${ghFixture("gh-labels.json")}'; exit 0;; "api repos/acme/storefront") cat '${ghFixture("gh-repo-permissions.json")}'; exit 0;; *clearProjectV2ItemFieldValue*) echo "$@" >> "${ghLog}"; cat '${ghFixture("gh-project-clear.json")}'; exit 0;; *updateProjectV2ItemFieldValue*) echo "$@" >> "${ghLog}"; cat '${ghFixture("gh-project-move.json")}'; exit 0;; *"api graphql"*"items(first"*) cat '${ghFixture("gh-project-items.json")}'; exit 0;; *"api graphql"*projectsV2*) cat '${ghFixture("gh-projects.json")}'; exit 0;; esac\nexit 1\n`,
    );
    chmodSync(fakeGh, 0o755);
    // GIT_ALLOW_PROTOCOL=file in the e2e env keeps git from ever reaching github.com.
    git("remote", "add", "origin", "https://github.com/acme/storefront.git");
    git("worktree", "add", "-q", "-b", "16-old-banner", wt16);
    git("worktree", "add", "-q", "-b", "18-orphan-work", wt18);
    linkedId = rpc<{ id: string }>(w, "session.create", { project_id: projectId(w), name: LINKED, branch: "12-fix-checkout", agent: "none" }).id;
  });

  // The app keeps the layout and open rows across restarts, and localStorage
  // outlives a run: start and end from the defaults.
  const forgetLayout = () => browser.execute(() => ["moonlet.tasks.layout", "moonlet.tasks.expanded", "moonlet.tasks.filters", "moonlet.tasks.assignee"].forEach((k) => localStorage.removeItem(k)));
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
    for (const [dir, branch] of [
      [wt16, "16-old-banner"],
      [wt18, "18-orphan-work"],
    ]) {
      try {
        git("worktree", "remove", "--force", dir);
        git("branch", "-D", branch);
      } catch {
        // Already gone.
      }
    }
    rmSync(ghFails, { force: true });
    rmSync(fakeGh, { force: true });
  });

  it("gives a repository no board until the user adds it from Connect a task tracker's GitHub Issues, then shows its issues with the sessions working on them, and a board switcher with bars and ↑ ↓ ↵", async () => {
    await expect($(sel.text(PROJECT))).toBeDisplayed({ wait: 30_000 });
    await tasksButton().click();
    // The project's repository has no board of its own (X50): GitHub Issues opens Add a board on GitHub.
    await expect($(sel.text("Connect a task tracker"))).toBeDisplayed({ wait: 30_000 });
    await expect($('//nav[@aria-label="Boards"]//button')).not.toBeExisting();
    await $('//section[@aria-labelledby="connect-tracker"]//button[.//div[normalize-space()="GitHub Issues"]]').click();
    const dialog = '//div[@role="dialog"][@aria-label="Add a board"]';
    await expect($(dialog)).toBeDisplayed({ wait: 10_000 });
    // It opens on the workspace's repositories.
    await $(`${dialog}//button[@role="radio"][.//span[normalize-space()="acme/storefront"]]`).click();
    const next = `${dialog}//button[normalize-space()="Continue"]`;
    await $(next).click();
    await expect($(`${dialog}//p[contains(normalize-space(), "issues match")]`)).toBeDisplayed({ wait: 15_000 });
    await $(next).waitForEnabled({ timeout: 15_000 });
    await $(next).click();
    await expect($(`${dialog}//div[@role="row"][@aria-label="Open"]`)).toBeDisplayed({ wait: 10_000 });
    await $(next).click();
    await $(`${dialog}//button[normalize-space()="Create board"]`).click();
    await expect(card("acme/storefront#12", "Open")).toBeDisplayed({ wait: 30_000 });
    await expect(card("acme/storefront#15", "Open")).toBeDisplayed();
    await expect(card("acme/storefront#12", "Open").$(sel.text(LINKED))).toBeDisplayed();
    await expect(card("acme/storefront#15", "Open").$(sel.text("No sessions"))).toBeDisplayed();
    // The board's name opens the board switcher, with this workspace's boards (X50).
    await $('//button[starts-with(@aria-label, "Switch board, current: acme/storefront")]').click();
    await expect($('//input[@placeholder="Find a board, team or project"]')).toBeDisplayed();
    const row = '//button[.//span[normalize-space()="acme/storefront"]][.//span[contains(normalize-space(), "Repository")]]';
    await expect($(row)).toBeDisplayed();
    // The row shows a bar per column: Open and Closed.
    await expect($(`${row}//span[@aria-label="2 columns"]`)).toBeDisplayed();
    // ↑ and ↓ move from the current board; ↵ picks: ↓ reaches New board, which opens Add a board.
    await expect($(row)).toHaveAttribute("data-active", "true");
    await browser.keys("ArrowDown");
    await expect($('//button[@data-active="true"][.//span[normalize-space()="New board"]]')).toBeDisplayed();
    await browser.keys("Enter");
    await expect($('//div[@role="dialog"][@aria-label="Add a board"]')).toBeDisplayed({ wait: 10_000 });
    await browser.keys("Escape");
    await $('//div[@role="dialog"][@aria-label="Add a board"]').waitForExist({ reverse: true });
  });

  it("opens Settings at Boards from the switcher's Manage, where a board is unpinned and pinned again (X50)", async () => {
    await $('//button[starts-with(@aria-label, "Switch board, current: acme/storefront")]').click();
    await $('//button[.//span[normalize-space()="Manage"]]').click();
    const row = '//div[@role="group"][@aria-label="acme/storefront"]';
    await expect($(row)).toBeDisplayed({ wait: 10_000 });
    await expect($('//div[@data-setting="boards"]')).toBeDisplayedInViewport();
    await expect($(`${row}//*[normalize-space()="GitHub acme/storefront"]`)).toBeDisplayed();
    const pin = `${row}//button[@role="switch"]`;
    await expect($(pin)).toHaveAttribute("aria-checked", "true");
    await $(pin).click();
    await expect($(pin)).toHaveAttribute("aria-checked", "false");
    await closeSettings();
    // Unpinned, it leaves the sidebar; it is still the board shown.
    await expect($('//nav[@aria-label="Boards"]//button[.//span[normalize-space()="acme/storefront"]]')).not.toBeExisting({ wait: 10_000 });
    await expect($('//button[starts-with(@aria-label, "Switch board, current: acme/storefront")]')).toBeDisplayed();
    await openSettings("Task trackers");
    await $(pin).click();
    await expect($(pin)).toHaveAttribute("aria-checked", "true");
    await closeSettings();
    await expect($('//nav[@aria-label="Boards"]//button[.//span[normalize-space()="acme/storefront"]]')).toBeDisplayed({ wait: 10_000 });
  });

  it("adds a board of a GitHub Project, after gh gets its read:project scope and next to the workspace's repositories, with No Status and the Project's Status as columns and its estimate on cards, moves an item by its Status (X50), and creates one from a column's + (X52)", async () => {
    await $('//button[@title="Add a board"]').click();
    const dialog = '//div[@role="dialog"][@aria-label="Add a board"]';
    await expect($(dialog)).toBeDisplayed({ wait: 10_000 });
    writeFileSync(ghNoScope, "");
    try {
      await $(`${dialog}//button[.//span[normalize-space()="GitHub"]]`).click();
      // Without the scope, step 1 says so, with the command; moonlet never runs gh auth itself.
      await expect($(`${dialog}//code[normalize-space()="gh auth refresh -s read:project"]`)).toBeDisplayed({ wait: 15_000 });
    } finally {
      rmSync(ghNoScope, { force: true });
    }
    await $(`${dialog}//button[normalize-space()="Check again"]`).click();
    // A repository's issues lists the workspace's repositories.
    await $(`${dialog}//button[.//span[normalize-space()="A repository's issues"]]`).click();
    await expect($(`${dialog}//button[@role="radio"][.//span[normalize-space()="acme/storefront"]]`)).toBeDisplayed({ wait: 10_000 });
    await $(`${dialog}//button[.//span[normalize-space()="A GitHub Project"]]`).click();
    const website = `${dialog}//button[@role="radio"][.//span[normalize-space()="Website"]]`;
    await expect($(`${website}//span[normalize-space()="3 columns"]`)).toBeDisplayed({ wait: 15_000 });
    await $(website).click();
    await $(`${dialog}//button[normalize-space()="Continue"]`).click();
    await expect($(`${dialog}//p[contains(normalize-space(), "13 issues match")]`)).toBeDisplayed({ wait: 15_000 });
    await $(`${dialog}//button[normalize-space()="Continue"]`).click();
    await expect($(`${dialog}//div[@role="row"][@aria-label="In Progress"]`)).toBeDisplayed({ wait: 10_000 });
    // No Status comes first, as GitHub shows it.
    await expect($(`(${dialog}//div[@role="row"][@aria-label])[1]`)).toHaveAttribute("aria-label", "No Status");
    await $(`${dialog}//button[normalize-space()="Continue"]`).click();
    // The Project's first number field is offered as the estimate, by its name.
    await $(`${dialog}//label[normalize-space()="Estimate"]`).click();
    await $(`${dialog}//button[normalize-space()="Create board"]`).click();
    // The user's own issue sits in its Status column, with its Estimate.
    await expect(card("acme/web#10", "Todo")).toBeDisplayed({ wait: 15_000 });
    await expect(card("acme/web#10", "Todo").$('.//*[normalize-space()="Estimate 3"]')).toBeDisplayed();
    await expect($('//button[starts-with(@aria-label, "Switch board, current: Website")]')).toBeDisplayed();
    // Its State menu sets the item's Status through gh.
    await card("acme/web#10", "Todo").$('.//button[normalize-space()="Retry failed webhook deliveries"]').click();
    const state = '//select[@aria-label="State of acme/web#10"]';
    await choose(state, "2");
    await browser.waitUntil(() => existsSync(ghLog) && readFileSync(ghLog, "utf8").includes("option=47fc_e2e0004"), { timeout: 10_000, timeoutMsg: existsSync(ghLog) ? readFileSync(ghLog, "utf8") : "no gh log" });
    // No Status clears it.
    await choose(state, "0");
    await browser.waitUntil(() => readFileSync(ghLog, "utf8").includes("clearProjectV2ItemFieldValue"), { timeout: 10_000, timeoutMsg: readFileSync(ghLog, "utf8") });
    // A column's +: the issue is created in a repository, the workspace's first, added to the Project, and given that column's Status (X52).
    const inProgress = '//section[@aria-label="In Progress"]';
    await $(inProgress).moveTo();
    await $(`${inProgress}//button[@title="New issue in In Progress"]`).click();
    const newIssue = '//div[@role="dialog"][@aria-label="New issue in In Progress"]';
    await expect($(`${newIssue}//select`)).toHaveValue("acme/storefront");
    await fill(`${newIssue}//input`, "Retry failed webhook deliveries");
    await $(`${newIssue}//button[normalize-space()="Create"]`).waitForEnabled({ timeout: 10_000 });
    await $(`${newIssue}//button[normalize-space()="Create"]`).click();
    // The fake answers in the repository asked for, as GitHub does.
    await expect($(`${inProgress}//article[starts-with(@aria-label, "acme/storefront#57")]`)).toBeDisplayed({ wait: 10_000 });
    await expect($('//aside[@aria-label="Task detail"]')).toBeDisplayed();
    const created = readFileSync(ghLog, "utf8");
    expect([created.includes("repos/acme/storefront/issues"), created.includes("addProjectV2ItemById"), created.includes("item=PVTI_e2e0050")]).toEqual([true, true, true]);
    // Back to #10, for its State menu.
    await $('//article[starts-with(@aria-label, "acme/web#10")]//button[normalize-space()="Retry failed webhook deliveries"]').click();
    // Without gh's project scope the menu is disabled and says what to run.
    writeFileSync(ghNoMove, "");
    try {
      await $('//button[@title="Refresh tasks"]').click();
      await expect($(state)).toBeDisabled({ wait: 15_000 });
      await expect($('//span[normalize-space()="Moving needs gh\'s project scope: run gh auth refresh -s project"]')).toBeDisplayed();
      // Nor can a column's + add an issue to the Project (X52).
      await expect($('//section[@aria-label="In Progress"]//button[@title="Adding issues to a Project needs gh\'s project scope: run gh auth refresh -s project"]')).toHaveAttribute("aria-disabled", "true");
    } finally {
      rmSync(ghNoMove, { force: true });
    }
    // Removed again, the repository's board shows.
    await $('//button[@title="Todo options"]').click();
    await $('//button[normalize-space()="Board settings…"]').click();
    await $('//div[@role="dialog"][@aria-label="Board settings"]//button[normalize-space()="Remove board"]').click();
    await $(sel.confirmButton("Remove")).click();
    await expect($('//button[starts-with(@aria-label, "Switch board, current: acme/storefront")]')).toBeDisplayed({ wait: 15_000 });
  });

  it("opens a session from its card in Sessions mode", async () => {
    await card("acme/storefront#12", "Open").$(`.//button[.//span[normalize-space()=${JSON.stringify(LINKED)}]]`).click();
    await expect(sessionsButton()).toHaveAttribute("aria-pressed", "true");
    await expect($(sel.sessionRow(LINKED))).toHaveAttribute("aria-current", "true");
  });

  it("lists sessions without a task, with the issue their name looks like", async () => {
    await tasksButton().click();
    // Sessions without a task are the List's last group (X50).
    await $('//div[@role="group"][@aria-label="Layout"]/button[normalize-space()="List"]').click();
    const row = $(`//section[@aria-label="Sessions without a task"]/div[.//span[normalize-space()=${JSON.stringify(SESSION)}]]`);
    await expect(row).toBeDisplayed();
    await expect(row.$(sel.text("Looks like acme/storefront#12 Fix checkout button"))).toBeDisplayed();
    await $('//div[@role="group"][@aria-label="Layout"]/button[normalize-space()="Board"]').click();
  });

  it("starts a session from a task with the issue as the first message, its branch and the link", async () => {
    // "Terminal only", so no agent starts (the composer reads this each time it opens).
    await browser.execute((id: string) => localStorage.setItem(`moonlet.composer.${id}`, JSON.stringify({ agent: "none", model: null, effort: null })), projectId(w));
    await card("acme/storefront#15", "Open").$(sel.button("Start")).click();
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
      await card("acme/storefront#12", "Open").$('//button[normalize-space()="Fix checkout button"]').click();
      // `.//`: within the detail, not the whole page.
      const start = $('//aside[@aria-label="Task detail"]').$(`.${sel.button("Start session")}`);
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

  it("counts done tasks left to clean up on the folded Closed column, and filters the board", async () => {
    await tasksButton().click();
    await $('//button[@title="Refresh tasks"]').click();
    // A GitHub repository board folds its Closed column (X50).
    const done = $('//button[starts-with(@aria-label, "Closed: ")]');
    await expect(done).toHaveAttribute("aria-label", "Closed: 2 tasks, 1 needs clean-up", { wait: 15_000 });
    await $('//div[@role="group"][@aria-label="Filters"]/button[normalize-space()="Hide empty Done"]').click();
    await expect(done).toHaveAttribute("aria-label", "Closed: 1 task, 1 needs clean-up");
    await $('//div[@role="group"][@aria-label="Filters"]/button[normalize-space()="Hide empty Done"]').click();
  });

  it("offers Start session on a card whose task has a worktree and no session, and No sessions yet on one with neither", async () => {
    await expect(card("acme/storefront#18", "Open").$(`.${sel.button("Start session")}`)).toBeDisplayed();
    await card("acme/storefront#19", "Open").$('//button[normalize-space()="Saved carts"]').click();
    const detail = $('//aside[@aria-label="Task detail"]');
    await expect(detail.$(`.${sel.text("No sessions yet. Starting one names the branch after the issue.")}`)).toBeDisplayed();
    // + New session opens the composer for the task.
    await detail.$(`.${sel.button("+ New session")}`).click();
    await expect($(sel.text("For acme/storefront#19"))).toBeDisplayed({ wait: 10_000 });
    await browser.keys("Escape");
    // So does Start a session for <key> in the list.
    await $('//div[@role="group"][@aria-label="Layout"]/button[normalize-space()="List"]').click();
    const row = $('//div[@role="row"][starts-with(@aria-label, "acme/storefront#19")]');
    await row.$('button[aria-label="Expand acme/storefront#19"]').click();
    await row.$(`.${sel.button("Start a session for acme/storefront#19")}`).click();
    await expect($(sel.text("For acme/storefront#19"))).toBeDisplayed({ wait: 10_000 });
    await browser.keys("Escape");
    await $('//div[@role="group"][@aria-label="Layout"]/button[normalize-space()="Board"]').click();
  });

  it("shows each session's card in the detail, and ↵ opens the first", async () => {
    await card("acme/storefront#12", "Open").$('.//button[normalize-space()="Fix checkout button"]').click();
    const session = $('//aside[@aria-label="Task detail"]').$(`.//div[@role="group"][@aria-label="Session ${LINKED}"]`);
    await expect(session.$(`.${sel.text("e2e-repo/12-fix-checkout")}`)).toBeDisplayed({ wait: 10_000 });
    await expect(session.$(`.${sel.text("No pull request · Create PR ⇧⌘P")}`)).toBeDisplayed();
    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
    await browser.keys("Enter");
    await expect(sessionsButton()).toHaveAttribute("aria-pressed", "true", { wait: 10_000 });
    await expect($(sel.sessionRow(LINKED))).toHaveAttribute("aria-current", "true");
    await tasksButton().click();
  });

  it("copies a task's key from its detail", async () => {
    await card("acme/storefront#19", "Open").$('//button[normalize-space()="Saved carts"]').click();
    await $('//aside[@aria-label="Task detail"]').$('.//button[@title="Copy issue key"]').click();
    await expect($(sel.text("Copied acme/storefront#19"))).toBeDisplayed({ wait: 5_000 });
  });

  it("says the board shown could not be read, with gh's error, and the footer that the sync failed (X50)", async () => {
    const banner = '//div[@role="alert"][starts-with(normalize-space(), "moonlet could not read acme/storefront: ")]';
    writeFileSync(ghFails, "");
    try {
      await $('//button[@title="Refresh tasks"]').click();
      await expect($(banner)).toBeDisplayed({ wait: 15_000 });
      await expect($(`${banner}[contains(normalize-space(), "Its last tasks are shown.")]`)).toBeDisplayed();
      // The banner says why; the footer only that the sync failed.
      await expect($('//*[normalize-space()="GitHub sync failed"]')).toBeDisplayed();
    } finally {
      rmSync(ghFails, { force: true });
    }
    await $('//button[@title="Refresh tasks"]').click();
    await expect($(banner)).not.toBeExisting({ wait: 15_000 });
    await expect($('//*[normalize-space()="GitHub sync failed"]')).not.toBeExisting();
  });

  it("asks to connect a task tracker in a workspace with no board", async () => {
    // A workspace with no project: no GitHub repository, no board (X50).
    const empty = rpc<{ id: string }>(w, "workspace.create", { name: "Empty", color: "grey" });
    const ctrlCmd = (key: string) =>
      browser.execute((k: string) => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, metaKey: true, ctrlKey: true, bubbles: true })), key);
    try {
      await ctrlCmd("2");
      await expect($('button[aria-label="Switch workspace, current: Empty"]')).toBeDisplayed({ wait: 15_000 });
      await tasksButton().click();
      await expect($(sel.text("Connect a task tracker"))).toBeDisplayed({ wait: 15_000 });
      await expect($(sel.button("Open Settings › Task trackers"))).toBeDisplayed();
      await $(sel.button("Not now")).click();
    } finally {
      await ctrlCmd("1");
      rpc(w, "workspace.delete", { id: empty.id });
    }
    await expect($('button[aria-label="Switch workspace, current: Personal"]')).toBeDisplayed({ wait: 15_000 });
    await tasksButton().click();
    await expect(card("acme/storefront#19", "Open")).toBeDisplayed({ wait: 15_000 });
    await sessionsButton().click();
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

  it("offers Link to task… in a session's right-click menu", async () => {
    if (await sessionsButton().isExisting()) await sessionsButton().click();
    const row = sel.sessionRow(SESSION);
    await expect($(row)).toBeDisplayed({ wait: 10_000 });
    await expect($(`${row}//*[contains(normalize-space(), "No task")]`)).not.toBeExisting();
    // The embedded driver has no right click: send the contextmenu event itself.
    await browser.execute((xp: string) => {
      const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 }));
    }, row);
    await $(sel.button("Link to task…")).click();
    await expect($(`//div[@role="dialog"]`).$(sel.text(`Link “${SESSION}” to a task`))).toBeDisplayed();
    await browser.keys("Escape");
    await expect($(`//div[@role="dialog"]`)).not.toBeExisting();
  });

  it("links a session to a task from a pasted key", async () => {
    await tasksButton().click();
    // Sessions without a task are the List's last group (X50).
    await $('//div[@role="group"][@aria-label="Layout"]/button[normalize-space()="List"]').click();
    await $(`//section[@aria-label="Sessions without a task"]/div[.//span[normalize-space()=${JSON.stringify(SESSION)}]]//button[normalize-space()="Link to task"]`).click();
    await expect($(`//div[@role="dialog"]`).$(sel.text(`Link “${SESSION}” to a task`))).toBeDisplayed();
    await expect($(sel.text("Links live in moonlet; the tracker hears of a PR only through Keep in step."))).toBeDisplayed();
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
    await $('//div[@role="group"][@aria-label="Layout"]/button[normalize-space()="Board"]').click();
  });

  it("shows the task bar on a session of a task with two sessions", async () => {
    // A second session on #12, linked by its branch.
    const second = rpc<{ id: string }>(w, "session.create", { project_id: projectId(w), name: "Second look", branch: "12-second-look", agent: "none" }).id;
    await sessionsButton().click();
    await $(sel.sessionRow(SESSION)).click();
    const bar = $('//div[@role="region"][@aria-label="Task"]');
    await expect(bar.$(`.${sel.text("acme/storefront#12")}`)).toBeDisplayed({ wait: 10_000 });
    await expect(bar.$('.//button[normalize-space()="Tasks"]')).toBeDisplayed();
    await expect(bar.$('.//div[@aria-label="Sessions on this task"]')).toHaveText(/Session \d of 2/);
    await expect(bar.$('.//a[normalize-space()="GitHub"]')).toHaveAttribute("href", "https://github.com/acme/storefront/issues/12");
    rpc(w, "session.archive", { id: second });
    await tasksButton().click();
  });

  it("shows the same tasks as a list whose rows open into their sessions, and unfolds and folds a column", async () => {
    await $('//div[@role="group"][@aria-label="Layout"]/button[normalize-space()="List"]').click();
    const row = $('//section[@aria-label="Open"]//div[@role="row"][starts-with(@aria-label, "acme/storefront#15")]');
    await expect(row).toBeDisplayed({ wait: 10_000 });
    await expect(row.$(sel.text("1 session"))).toBeDisplayed();
    await row.$('button[aria-label="Expand acme/storefront#15"]').click();
    await expect(row.$('//button[normalize-space()="Gift cards at checkout"]')).toBeDisplayed();
    await expect($('//section[@aria-label="Closed"]')).toBeDisplayed();
    // Expand all opens every row; Collapse all closes them.
    const twelve = $('button[aria-label="Expand acme/storefront#12"], button[aria-label="Collapse acme/storefront#12"]');
    await $(sel.button("Expand all")).click();
    await expect(twelve).toHaveAttribute("aria-expanded", "true");
    await $(sel.button("Collapse all")).click();
    await expect(twelve).toHaveAttribute("aria-expanded", "false");
    await expect(row.$('button[aria-label="Expand acme/storefront#15"]')).toHaveAttribute("aria-expanded", "false");
    await $('//div[@role="group"][@aria-label="Layout"]/button[normalize-space()="Board"]').click();
    // A folded column unfolds when clicked, and its ⋯ menu folds it again (X50).
    await $('//button[starts-with(@aria-label, "Closed: ")]').click();
    await expect($('//section[@aria-label="Closed"]')).toBeDisplayed({ wait: 10_000 });
    await $('//button[@title="Closed options"]').click();
    await $(sel.button("Fold")).click();
    await expect($('//button[starts-with(@aria-label, "Closed: ")]')).toBeDisplayed({ wait: 10_000 });
  });

  const rowStyle = async (option: string) => {
    await openSettings("Appearance");
    await $(sel.settingsOption("Session rows", option)).click();
    await expect($(sel.settingsOption("Session rows", option))).toHaveAttribute("aria-checked", "true");
    await closeSettings();
  };

  it("A · shows a linked session's issue number in a column, its prefix on the project heading (X48)", async () => {
    await sessionsButton().click();
    await rowStyle("A · Issue number column");
    await expect($(`${sel.sessionRow("Gift cards at checkout")}//span[normalize-space()="15"]`)).toBeDisplayed({ wait: 10_000 });
    await expect($(`//aside//button[.//span[normalize-space()=${JSON.stringify(PROJECT)}]]//span[normalize-space()="#"]`)).toBeDisplayed();
    await expect($(sel.sessionRow("Gift cards at checkout"))).toHaveAttribute("title", /^acme\/storefront#15 · Open · Gift cards at checkout/);
  });

  it("B · puts the sessions under a line for their task, those without a task last (X48)", async () => {
    await rowStyle("B · Task as a sub-header");
    try {
      await expect($('//aside//div[@title="acme/storefront#15 · Gift cards at checkout"]')).toBeDisplayed({ wait: 10_000 });
      await expect($('//aside//div[@title="Not linked to a task"]')).toBeDisplayed();
      await expect($(`${sel.sessionRow("Gift cards at checkout")}//span[normalize-space()="15"]`)).not.toBeExisting();
    } finally {
      await rowStyle("A · Issue number column");
    }
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
    await expect(card("acme/storefront#15", "Open")).toBeDisplayed({ wait: 10_000 });
    await expect(card("acme/storefront#12", "Open")).not.toBeExisting();
    await fill('//input[@placeholder="Find a task"]', "");
    await card("acme/storefront#15", "Open").$('//button[normalize-space()="Gift cards at checkout"]').click();
    await choose('//select[@aria-label="State of acme/storefront#15"]', "1");
    await browser.waitUntil(() => asked().includes("issue close 15 --reason completed"), { timeout: 10_000, timeoutMsg: `gh was asked: ${asked()}` });
    await expect($('//section[@aria-label="Activity"]').$(sel.text("moonlet closed it"))).toBeDisplayed({ wait: 10_000 });
    await sessionsButton().click();
  });
});
