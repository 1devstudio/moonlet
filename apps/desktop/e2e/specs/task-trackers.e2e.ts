// Settings › Task trackers (X44): the GitHub connection through gh, a Keep in
// step rule saved to ~/.moonlet/trackers.toml, and Linear against a mock of its
// GraphQL API answering with the documented shapes (X44, X46). One file, so the
// specs never write trackers.toml from two apps at once.

import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { $, browser, expect } from "@wdio/globals";
import { choose, closeSettings, fill, openSettings, PROJECT, rpc, sel, trackerPort, world } from "../fixtures";

const w = world();
const fakeGh = join(w.root, "bin", "gh");
const file = join(w.home, "trackers.toml");
const rule = "A session starts from an issue → assign it to me";

describe("Task trackers settings", () => {
  before(() => {
    writeFileSync(fakeGh, '#!/bin/sh\n[ "$*" = "api user --jq .login" ] && echo sam-rivera && exit 0\nexit 1\n');
    chmodSync(fakeGh, 0o755);
  });

  after(async () => {
    await closeSettings().catch(() => {});
    rmSync(fakeGh, { force: true });
    rmSync(file, { force: true });
  });

  it("shows who gh is signed in as", async () => {
    await openSettings("Task trackers");
    await expect($(sel.text("Connected as sam-rivera · uses gh on This Mac"))).toBeDisplayed({ wait: 15_000 });
  });

  it("saves a rule to trackers.toml as soon as it changes", async () => {
    await $(sel.settingsOption(rule, "Off")).click();
    await browser.waitUntil(() => existsSync(file) && readFileSync(file, "utf8").includes('session_starts = "off"'), {
      timeout: 10_000,
      timeoutMsg: `trackers.toml: ${existsSync(file) ? readFileSync(file, "utf8") : "missing"}`,
    });
    await expect($(sel.settingsOption(rule, "Off"))).toHaveAttribute("aria-checked", "true");
    await $(sel.settingsOption(rule, "Automatically")).click();
    // Back at the defaults, GitHub's section is left out of the file.
    await browser.waitUntil(() => !readFileSync(file, "utf8").includes("session_starts"), { timeout: 10_000 });
  });

  it("says where tokens are kept, on the page and in the Jira dialog", async () => {
    await expect(
      $(sel.text("Tokens are kept in the macOS Keychain on this Mac and never sent to remote hosts. moonletd only stores which issue each session is linked to. Settings are saved to ~/.moonlet/trackers.toml.")),
    ).toBeDisplayed();
    await $(sel.settingsButton("Connect Jira Cloud")).click();
    await expect($('//div[@role="dialog"]').$(sel.text("The token is saved in the macOS Keychain. Tokens expire. moonlet tells you when Jira stops accepting it."))).toBeDisplayed();
    await $('//div[@role="dialog"]//button[normalize-space()="Cancel"]').click();
  });
});

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "crates", "moonlet-trackers", "tests", "fixtures");
const answer = (name: string) => readFileSync(join(fixtures, name), "utf8");
const moves: { id: string; input: Record<string, string> }[] = [];
let server: Server;
/** Answer every request as Linear does for a token it no longer accepts. */
let rejecting = false;
/** Answer the issues query as if every page had a next one. */
let endlessPages = false;
let issuesAsked = 0;

/** Whether Linear lists a third team, OPS (X50 Add a board). */
let opsTeam = false;

/** Linear's GraphQL endpoint: an answer per query, and a record of every move. */
function linear(query: string, variables: Record<string, unknown>): string {
  // Most specific first. A board's query (X50) reads one team.
  if (query.includes("issueUpdate")) {
    moves.push(variables as (typeof moves)[number]);
    return answer("linear-issue-update.json");
  }
  if (query.includes("issues(")) {
    issuesAsked++;
    const issues = query.includes("BoardIssues") ? "linear-board-issues.json" : "linear-issues.json";
    if (!endlessPages && !query.includes("isMe")) {
      // Everyone's open issues: the account's, and one of Grace's (X45 Assignee: me off).
      const all = JSON.parse(answer(issues));
      const ada = all.data.issues.nodes[1];
      all.data.issues.nodes.push({ ...ada, id: "1a2b3c4d-0000-4000-8000-000000000200", identifier: "ENG-200", title: "Tidy the onboarding copy", url: "https://linear.app/acme/issue/ENG-200", branchName: "grace/eng-200", assignee: { id: "g", name: "Grace Hopper" } });
      return JSON.stringify(all);
    }
    if (!endlessPages) return answer(issues);
    const page = JSON.parse(answer(issues));
    page.data.issues.pageInfo = { hasNextPage: true, endCursor: `c${issuesAsked}` };
    return JSON.stringify(page);
  }
  if (query.includes("organization")) return JSON.stringify({ data: { viewer: { id: "8f1c2d3e-4b5a-4c6d-9e7f-0a1b2c3d4e5f", name: "Ada Lovelace", email: "ada@example.com" }, organization: { urlKey: "acme", name: "Acme" } } });
  if (query.includes("workflowStates")) return answer("linear-states.json");
  if (query.includes("activeCycle")) return answer("linear-active-cycle.json");
  if (query.includes("teams")) {
    if (!opsTeam) return answer("linear-teams.json");
    // A third team, with cycles and no board yet (X50 Add a board).
    const teams = JSON.parse(answer("linear-teams.json"));
    teams.data.teams.nodes.push({ id: "5d4c3b2a-0000-4000-8000-000000000003", key: "OPS", name: "Operations", cyclesEnabled: true });
    return JSON.stringify(teams);
  }
  if (query.includes("viewer")) return answer("linear-viewer.json");
  return JSON.stringify({ errors: [{ message: "unknown query" }] });
}

interface Session {
  id: string;
  name: string;
  task?: { key: string } | null;
}

describe("Linear tracker", () => {
  before(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { query, variables } = JSON.parse(body || "{}");
        res.setHeader("content-type", "application/json");
        res.end(!rejecting && req.url === "/linear/graphql" && req.headers.authorization === "lin_api_e2e" ? linear(query, variables ?? {}) : JSON.stringify({ errors: [{ message: "Authentication required", extensions: { type: "authentication error" } }] }));
      });
    });
    await new Promise<void>((r) => server.listen(trackerPort(w.root), "127.0.0.1", () => r()));
  });

  after(async () => {
    await closeSettings().catch(() => {});
    const tasks = $('//div[@role="group"][@aria-label="Mode"]/button[@aria-label="Sessions"]');
    if (await tasks.isExisting()) await tasks.click();
    for (const s of rpc<Session[]>(w, "session.list", {})) if (s.task?.key?.startsWith("ENG-")) rpc(w, "session.archive", { id: s.id });
    rmSync(join(w.home, "trackers.toml"), { force: true });
    rmSync(join(w.home, "secrets.json"), { force: true });
    await new Promise((r) => server.close(r));
  });

  it("connects with an API key, keeps the key out of trackers.toml, and ends in Add a board for a team (X50)", async () => {
    await openSettings("Task trackers");
    await $(sel.settingsButton("Connect Linear")).click();
    // A key Linear refuses: its error shows in the dialog.
    await fill('//div[@role="dialog"]//input[@type="password"]', "lin_api_wrong");
    await $('//div[@role="dialog"]//button[normalize-space()="Connect"]').click();
    await expect($('//div[@role="dialog"]').$(sel.text("Linear no longer accepts this token. Create a new one and paste it here."))).toBeDisplayed({ wait: 15_000 });
    await fill('//div[@role="dialog"]//input[@type="password"]', "lin_api_e2e");
    await $('//div[@role="dialog"]//button[normalize-space()="Connect"]').click();
    await expect($(sel.text("Signed in as Ada Lovelace · 2 teams visible"))).toBeDisplayed({ wait: 15_000 });
    // The Connect dialog ends in Add a board, on the new connection (X50).
    await $('//div[@role="dialog"]//button[normalize-space()="Add a board"]').click();
    const dialog = '//div[@role="dialog"][@aria-label="Add a board"]';
    await $(`${dialog}//button[@role="radio"][.//span[normalize-space()="Engineering"]]`).click();
    await $(`${dialog}//button[normalize-space()="Continue"]`).click();
    await expect($(`${dialog}//p[contains(normalize-space(), "issues match")]`)).toBeDisplayed({ wait: 15_000 });
    await choose(`${dialog}//select[@aria-label="Finished issues"]`, "14");
    // Continue waits for the changed choice's preview.
    await $(`${dialog}//button[normalize-space()="Continue"]`).waitForEnabled({ timeout: 15_000 });
    await $(`${dialog}//button[normalize-space()="Continue"]`).click();
    await expect($(`${dialog}//div[@role="row"][@aria-label="In Progress"]`)).toBeDisplayed({ wait: 10_000 });
    await $(`${dialog}//button[normalize-space()="Continue"]`).click();
    await $(`${dialog}//button[normalize-space()="Create board"]`).click();
    await openSettings("Task trackers");
    await expect($(sel.text("Connected as Ada Lovelace · API key · 1 board"))).toBeDisplayed({ wait: 10_000 });
    const toml = readFileSync(join(w.home, "trackers.toml"), "utf8");
    expect(toml).toContain('id = "linear:acme"');
    // The chosen team is a board (X50).
    expect(toml).toContain('team = "ENG"');
    expect(toml).not.toContain('team = "DES"');
    expect(toml).not.toContain("lin_api_e2e");
    expect(readFileSync(join(w.home, "secrets.json"), "utf8")).toContain("lin_api_e2e");
  });

  it("edits the connection's boards as sources, row by row (X44, X50)", async () => {
    await $(sel.settingsButton("Sources")).click();
    // The team's board is the first row; a second is added, then removed.
    await expect($('//div[@role="listitem"][@aria-label="Engineering"]')).toBeDisplayed({ wait: 10_000 });
    await $('//div[@role="dialog"]//button[normalize-space()="Add source"]').click();
    await choose('//div[@role="dialog"]//select[@aria-label="Source 2"]', "DES");
    await $('//div[@role="dialog"]//button[@aria-label="Remove Design"]').click();
    await $('//div[@role="listitem"][@aria-label="Design"]').waitForExist({ reverse: true });
    await $('//div[@role="dialog"]//button[normalize-space()="Save and sync"]').click();
    await $('//div[@role="dialog"]').waitForExist({ reverse: true, timeout: 10_000 });
    const toml = readFileSync(join(w.home, "trackers.toml"), "utf8");
    expect(toml).toContain('team = "ENG"');
    expect(toml).not.toContain('team = "DES"');
  });

  it("maps a workflow state to another column, saved with the board", async () => {
    await $(sel.settingsButton("States")).click();
    await expect($('//div[@role="dialog"]').$(sel.text("Backlog"))).toBeDisplayed({ wait: 10_000 });
    await choose('//select[@aria-label="Column for Backlog"]', "todo");
    await $('//div[@role="dialog"]//button[normalize-space()="Save"]').click();
    await browser.waitUntil(() => readFileSync(join(w.home, "trackers.toml"), "utf8").includes('Backlog = "todo"'), {
      timeout: 10_000,
      timeoutMsg: readFileSync(join(w.home, "trackers.toml"), "utf8"),
    });
    await closeSettings();
  });

  it("links the team to the project in Project settings", async () => {
    await openSettings(PROJECT);
    await choose('//select[@aria-label="Link a tracker project"]', "linear:acme/ENG");
    await expect($(sel.text("Linear team Engineering (ENG)"))).toBeDisplayed();
    await $(sel.settingsButton("Save")).click();
    const config = () => readFileSync(join(w.repo, ".moonlet", "config.toml"), "utf8");
    await browser.waitUntil(() => config().includes('trackers = ["linear:acme/ENG"]'), { timeout: 10_000, timeoutMsg: config() });
    await closeSettings();
  });

  it("shows the team's issues in Tasks mode", async () => {
    await $('//div[@role="group"][@aria-label="Mode"]/button[starts-with(@aria-label, "Tasks")]').click();
    await expect($('//section[@aria-label="In Progress"]//article[starts-with(@aria-label, "ENG-123")]')).toBeDisplayed({ wait: 15_000 });
    await expect($('//section[@aria-label="Todo"]//article[starts-with(@aria-label, "ENG-124")]')).toBeDisplayed();
    // The sidebar lists the workspace's boards (X50).
    await expect($('//nav[@aria-label="Boards"]//button[.//span[normalize-space()="Engineering"]]')).toBeDisplayed();
    await $('//section[@aria-label="In Progress"]//article[starts-with(@aria-label, "ENG-123")]//button[normalize-space()="Retry failed webhook deliveries"]').click();
    await expect($('//aside[@aria-label="Task detail"]').$(sel.text("· Cycle 42"))).toBeDisplayed();
  });

  it("shows everyone's open issues once the board's Assignee is anyone, others' dimmed (X50)", async () => {
    const assignee = (who: string) => `//div[@role="group"][@aria-label="Filters"]//button[@aria-label="Assignee: ${who}"]`;
    const pick = async (label: string) => {
      await $('//div[@role="group"][@aria-label="Filters"]//button[starts-with(@aria-label, "Assignee: ")]').click();
      await $(`//button[.//span[normalize-space()="${label}"]]`).click();
    };
    const grace = '//section[@aria-label="Todo"]//article[starts-with(@aria-label, "ENG-200")]';
    await pick("Me");
    await expect($(assignee("me"))).toBeDisplayed();
    await expect($(grace)).not.toBeExisting();
    await pick("Anyone");
    await expect($(grace)).toBeDisplayed({ wait: 15_000 });
    await expect($(grace)).toHaveElementClass("opacity-60");
    // Someone else's issue with no session says whose it is (X50 Cards).
    await expect($(`${grace}//span[normalize-space()="Assigned to Grace Hopper"]`)).toBeDisplayed();
    await pick("Me");
    await expect($(grace)).not.toBeExisting();
  });

  it("moves the issue to In Progress and assigns it when a session starts from it", async () => {
    const projectId = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!.id;
    await browser.execute((id: string) => localStorage.setItem(`moonlet.composer.${id}`, JSON.stringify({ agent: "none", model: null, effort: null })), projectId);
    await $('//section[@aria-label="Todo"]//article[starts-with(@aria-label, "ENG-124")]').$(sel.button("Start")).click();
    await expect($('//label[normalize-space()="Move ENG-124 to In Progress and assign it to me"]/input')).toBeSelected();
    await expect($(sel.text("eng-124-add-dark-mode-to-settings-page"))).toBeDisplayed({ wait: 10_000 });
    // The project menu puts the project that links ENG first (X44).
    await $(`//button[normalize-space()=${JSON.stringify(PROJECT)}]`).click();
    await expect($(sel.text("Linked to ENG-124"))).toBeDisplayed();
    await browser.keys("Escape");
    await $(sel.button("Create")).click();
    await browser.waitUntil(() => moves.length > 0, { timeout: 15_000, timeoutMsg: "Linear never got the move" });
    expect(moves[0]).toEqual({
      id: "1a2b3c4d-0000-4000-8000-000000000124",
      input: { stateId: "a1000000-0000-4000-8000-000000000002", assigneeId: "8f1c2d3e-4b5a-4c6d-9e7f-0a1b2c3d4e5f" },
    });
    await browser.execute((id: string) => localStorage.removeItem(`moonlet.composer.${id}`), projectId);
  });

  it("adds a board of a Linear team that uses cycles, following its active cycle, with the card fields picked, and removes it after asking (X50)", async () => {
    opsTeam = true;
    try {
      const tasks = '//div[@role="group"][@aria-label="Mode"]/button[starts-with(@aria-label, "Tasks")]';
      if ((await $(tasks).getAttribute("aria-pressed")) !== "true") await $(tasks).click();
      await $('//button[@title="Add a board"]').click();
      const dialog = '//div[@role="dialog"][@aria-label="Add a board"]';
      await expect($(dialog)).toBeDisplayed({ wait: 10_000 });
      await $(`(${dialog}//button[.//span[normalize-space()="Linear"]])[1]`).click();
      const ops = `${dialog}//button[@role="radio"][.//span[normalize-space()="Operations"]]`;
      await expect($(`${ops}//span[normalize-space()="Cycles"]`)).toBeDisplayed({ wait: 10_000 });
      await expect($(`${dialog}//button[@role="radio"][.//span[normalize-space()="Design"]]//span[normalize-space()="Cycles"]`)).not.toBeExisting();
      await $(ops).click();
      await $(`${dialog}//button[normalize-space()="Continue"]`).click();
      await expect($(`${dialog}//p[contains(normalize-space(), "issues match")]`)).toBeDisplayed({ wait: 15_000 });
      await expect($(`${dialog}//select[@aria-label="Finished issues"]`)).toHaveValue("sprint");
      await $(`${dialog}//button[normalize-space()="Continue"]`).click();
      // The team's workflow states are the columns.
      await expect($(`${dialog}//div[@role="row"][@aria-label="In Review"]`)).toBeDisplayed({ wait: 10_000 });
      await $(`${dialog}//button[normalize-space()="Continue"]`).click();
      // Cards show the estimate and assignee by default; the parent and due date too once ticked.
      for (const field of ["Parent", "Due date"]) await $(`${dialog}//section[@aria-label="Cards show"]//label[normalize-space()="${field}"]/input`).click();
      await $(`${dialog}//button[normalize-space()="Create board"]`).click();
      const card = '//section[@aria-label="In Progress"]//article[starts-with(@aria-label, "ENG-123")]';
      await expect($(`${card}//*[normalize-space()="3 pt"]`)).toBeDisplayed({ wait: 15_000 });
      await expect($(`${card}//div[normalize-space()="ENG-100 Reliable webhooks · Due Oct 20"]`)).toBeDisplayed();
      await expect($('//button[starts-with(@aria-label, "Switch board, current: Operations")]')).toBeDisplayed({ wait: 15_000 });
      const sidebarRow = '//nav[@aria-label="Boards"]//button[.//span[normalize-space()="Operations · Cycle 42"]]';
      await expect($(sidebarRow)).toBeDisplayed();
      // Board settings remove it, after asking; the team's other board stays.
      await $('//button[@title="In Review options"]').click();
      await $('//button[normalize-space()="Board settings…"]').click();
      await $('//div[@role="dialog"][@aria-label="Board settings"]//button[normalize-space()="Remove board"]').click();
      await $(sel.confirmButton("Remove")).click();
      await expect($(sidebarRow)).not.toBeExisting({ wait: 10_000 });
      await expect($('//nav[@aria-label="Boards"]//button[.//span[normalize-space()="Engineering"]]')).toBeDisplayed();
    } finally {
      opsTeam = false;
    }
  });

  it("reads Linear's issues in pages, at most 5 of them", async () => {
    endlessPages = true;
    try {
      await $('//div[@role="group"][@aria-label="Mode"]/button[starts-with(@aria-label, "Tasks")]').click();
      // Opening Tasks mode syncs once; count the pages of one sync after it.
      await new Promise((r) => setTimeout(r, 2_000));
      const before = issuesAsked;
      await $('//button[@title="Refresh tasks"]').click();
      await browser.waitUntil(() => issuesAsked - before >= 5, { timeout: 15_000, timeoutMsg: `asked ${issuesAsked - before} pages` });
      await new Promise((r) => setTimeout(r, 1_000));
      expect(issuesAsked - before).toBe(5);
    } finally {
      endlessPages = false;
    }
  });

  it("stops asking Linear once it rejects the token, the Settings nav shows a dot, and reconnecting ends with Done", async () => {
    rejecting = true;
    await $('//div[@role="group"][@aria-label="Mode"]/button[starts-with(@aria-label, "Tasks")]').click();
    await $('//button[@title="Refresh tasks"]').click();
    // The sidebar marks the board of a connection that needs attention.
    await expect($('//nav[@aria-label="Boards"]//button[.//span[normalize-space()="Engineering"]]/span[@title]')).toBeDisplayed({ wait: 15_000 });
    await openSettings("Task trackers");
    await expect($('//*[@role="img"][@aria-label="1 connection needs attention"]')).toBeDisplayed({ wait: 15_000 });
    rejecting = false;
    // Reconnecting ends with Done, not Add a board (X50).
    await $(sel.settingsButton("Reconnect")).click();
    await fill('//div[@role="dialog"]//input[@type="password"]', "lin_api_e2e");
    await $('//div[@role="dialog"]//button[normalize-space()="Connect"]').click();
    await expect($(sel.text("Signed in as Ada Lovelace · 2 teams visible"))).toBeDisplayed({ wait: 15_000 });
    await expect($('//div[@role="dialog"]//button[normalize-space()="Add a board"]')).not.toBeExisting();
    await $('//div[@role="dialog"]//button[normalize-space()="Done"]').click();
    await expect($('//*[@role="img"][@aria-label="1 connection needs attention"]')).not.toBeExisting({ wait: 10_000 });
  });

  it("disconnects after asking, naming its boards: the token, the connection and its boards are gone", async () => {
    await $(sel.settingsButton("Disconnect")).click();
    await expect($(sel.text("moonlet forgets the token for acme and removes its board Engineering. Sessions keep their links."))).toBeDisplayed({ wait: 10_000 });
    await $('//div[@role="dialog"]//button[normalize-space()="Disconnect"]').click();
    await browser.waitUntil(() => !readFileSync(join(w.home, "trackers.toml"), "utf8").includes("linear:acme"), {
      timeout: 10_000,
      timeoutMsg: readFileSync(join(w.home, "trackers.toml"), "utf8"),
    });
    expect(readFileSync(join(w.home, "secrets.json"), "utf8")).not.toContain("lin_api_e2e");
    await expect($('//*[@role="img"][@aria-label="1 connection needs attention"]')).not.toBeExisting();
  });
});

/** Jira's and ClickUp's REST APIs: an answer per path, and what was asked. */
const asked: { method: string; path: string; auth?: string }[] = [];
let jiraEndless = false;
function jiraClickup(method: string, path: string, auth: string | undefined, body: string): { status: number; body: string } {
  asked.push({ method, path, auth });
  const ok = (b: string) => ({ status: 200, body: b });
  if (path.startsWith("/jira/")) {
    // Basic auth: "e2e@acme.example:bad" is a token Jira refuses.
    if (auth === `Basic ${Buffer.from("e2e@acme.example:bad").toString("base64")}`) return { status: 401, body: answer("jira-error-401.json") };
    if (path.startsWith("/jira/rest/api/3/myself")) return ok(answer("jira-myself.json"));
    if (path.startsWith("/jira/rest/api/3/project/search")) return ok(answer("jira-projects.json"));
    if (path.startsWith("/jira/rest/api/3/search/jql")) return ok(answer(jiraEndless ? "jira-search-page1.json" : "jira-search.json"));
    if (path.includes("/transitions")) return ok(JSON.stringify({ transitions: [] }));
    // A Jira Software site's boards, a Scrum board's configuration and filter (X50 Add a board).
    if (/^\/jira\/rest\/agile\/1\.0\/board\/\d+\/configuration/.test(path)) return ok(answer("jira-board-scrum-configuration.json"));
    if (path.startsWith("/jira/rest/agile/1.0/board")) return ok(answer("jira-boards.json"));
    if (path.startsWith("/jira/rest/api/3/filter/")) return ok(answer("jira-filter-scrum.json"));
    if (path.startsWith("/jira/rest/api/3/status")) return ok(answer("jira-statuses.json"));
    if (path.startsWith("/jira/rest/api/3/field")) return ok(answer("jira-fields.json"));
    void body;
    return { status: 404, body: "{}" };
  }
  if (path === "/clickup/user") return ok(answer("clickup-user.json"));
  // Two ClickUp workspaces: the connection is the first one.
  if (path === "/clickup/team") return ok(JSON.stringify({ teams: [{ id: "1111", name: "First" }, { id: "2222", name: "Second" }] }));
  if (path === "/clickup/team/1111/space") return ok(answer("clickup-spaces.json"));
  if (/^\/clickup\/space\/\d+\/list/.test(path)) return ok(answer("clickup-lists.json"));
  if (/^\/clickup\/space\/\d+\/folder/.test(path)) return ok(answer("clickup-folders.json"));
  return { status: 404, body: "{}" };
}

describe("Jira and ClickUp trackers", () => {
  before(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const a = jiraClickup(req.method ?? "GET", req.url ?? "", req.headers.authorization, body);
        res.statusCode = a.status;
        res.setHeader("content-type", "application/json");
        res.end(a.body);
      });
    });
    await new Promise<void>((r) => server.listen(trackerPort(w.root), "127.0.0.1", () => r()));
  });

  after(async () => {
    await closeSettings().catch(() => {});
    const sessions = $('//div[@role="group"][@aria-label="Mode"]/button[@aria-label="Sessions"]');
    if (await sessions.isExisting()) await sessions.click();
    rmSync(join(w.home, "trackers.toml"), { force: true });
    rmSync(join(w.home, "secrets.json"), { force: true });
    await new Promise((r) => server.close(r));
  });

  it("connects ClickUp with its raw token to the account's first workspace, its lists grouped by space in Add a board", async () => {
    await openSettings("Task trackers");
    await $(sel.settingsButton("Connect ClickUp")).click();
    await expect($('//div[@role="dialog"]').$(sel.text("The token is saved in the macOS Keychain."))).toBeDisplayed();
    await fill('//div[@role="dialog"]//input[@type="password"]', "pk_e2e_token");
    await $('//div[@role="dialog"]//button[normalize-space()="Connect"]').click();
    await expect($(sel.text("Signed in as John Doe · 4 lists visible"))).toBeDisplayed({ wait: 15_000 });
    // Add a board lists ClickUp's lists under their space (X50).
    await $('//div[@role="dialog"]//button[normalize-space()="Add a board"]').click();
    const dialog = '//div[@role="dialog"][@aria-label="Add a board"]';
    await expect($(`${dialog}//div[normalize-space()="Second Space Name"]`)).toBeDisplayed({ wait: 15_000 });
    await expect($(`${dialog}//div[normalize-space()="Updated Space Name"]`)).toBeDisplayed();
    await expect($(`${dialog}//button[@role="radio"][.//span[normalize-space()="Sprint Backlog"]]`)).toBeDisplayed();
    await browser.keys("Escape");
    await $(dialog).waitForExist({ reverse: true });
    await openSettings("Task trackers");
    // The token goes as the raw Authorization value, not as a Bearer.
    expect(asked.filter((x) => x.path.startsWith("/clickup/")).every((x) => x.auth === "pk_e2e_token")).toBe(true);
    expect(readFileSync(join(w.home, "trackers.toml"), "utf8")).toContain('id = "clickup:1111"');
  });

  it("shows Jira's refusal in the dialog, then connects two Jira sites side by side", async () => {
    for (const [site, token] of [
      ["acme.atlassian.net", "bad"],
      ["acme.atlassian.net", "good"],
      ["ops.atlassian.net", "good"],
    ]) {
      // After a refusal the dialog stays open; otherwise the last one has to close first.
      if (token !== "good" || site !== "acme.atlassian.net") {
        await $('//div[@role="dialog"]').waitForExist({ reverse: true, timeout: 10_000 });
        await $(sel.settingsButton("Connect Jira Cloud")).click();
      }
      await fill('//div[@role="dialog"]//input[@placeholder="acme.atlassian.net"]', site);
      await fill('//div[@role="dialog"]//input[@placeholder="you@example.com"]', "e2e@acme.example");
      await fill('//div[@role="dialog"]//input[@type="password"]', token);
      await $('//div[@role="dialog"]//button[normalize-space()="Connect"]').click();
      if (token === "bad") {
        await expect($('//div[@role="dialog"]').$(sel.text(`Jira no longer accepts the API token for ${site}. It may have expired or been revoked. Create a new token and paste it here.`))).toBeDisplayed({ wait: 15_000 });
        continue;
      }
      await expect($(sel.text("Signed in as Mia Krystof · 2 projects visible"))).toBeDisplayed({ wait: 15_000 });
      if (site !== "acme.atlassian.net") {
        await $('//div[@role="dialog"]//button[normalize-space()="Later"]').click();
        continue;
      }
      // The first site's board: a query for the EX project (X50 Add a board).
      await $('//div[@role="dialog"]//button[normalize-space()="Add a board"]').click();
      const dialog = '//div[@role="dialog"][@aria-label="Add a board"]';
      await $(`${dialog}//button[.//span[normalize-space()="A JQL query"]]`).click();
      await fill(`${dialog}//textarea`, "project = EX");
      await $(`${dialog}//button[normalize-space()="Continue"]`).click();
      await expect($(`${dialog}//p[contains(normalize-space(), "issues match")]`)).toBeDisplayed({ wait: 15_000 });
      await $(`${dialog}//button[normalize-space()="Continue"]`).click();
      await expect($(`${dialog}//div[@role="row"][@aria-label="In Progress"]`)).toBeDisplayed({ wait: 10_000 });
      await $(`${dialog}//button[normalize-space()="Continue"]`).click();
      await fill(`${dialog}//label[.//span[normalize-space()="Name"]]//input`, "Example");
      await $(`${dialog}//button[normalize-space()="Create board"]`).click();
      await openSettings("Task trackers");
    }
    const toml = readFileSync(join(w.home, "trackers.toml"), "utf8");
    expect([toml.includes('id = "jira:acme.atlassian.net"'), toml.includes('id = "jira:ops.atlassian.net"')]).toEqual([true, true]);
    await closeSettings();
  });

  it("adds an existing Jira board: its filter with Edit in Jira, statuses by name, a changed category outlined, a column dragged (X50)", async () => {
    await $('//div[@role="group"][@aria-label="Mode"]/button[starts-with(@aria-label, "Tasks")]').click();
    await $('//button[@title="Add a board"]').click();
    const dialog = '//div[@role="dialog"][@aria-label="Add a board"]';
    await $(`(${dialog}//button[.//span[normalize-space()="Jira Cloud"]])[1]`).click();
    await $(`${dialog}//button[@role="radio"][.//span[normalize-space()="OPS board"]]`).click();
    await $(`${dialog}//button[normalize-space()="Continue"]`).click();
    // Step 2: the board's filter, read-only, with a link to edit it in Jira.
    await expect($(`${dialog}//section[@aria-label="Board filter"]//span[normalize-space()="project = 10008 ORDER BY Rank ASC"]`)).toBeDisplayed({ wait: 15_000 });
    await expect($(`${dialog}//a[normalize-space()="Edit in Jira"]`)).toHaveAttribute("href", "https://acme.atlassian.net/issues/?filter=10021");
    await $(`${dialog}//button[normalize-space()="Continue"]`).waitForEnabled({ timeout: 15_000 });
    await $(`${dialog}//button[normalize-space()="Continue"]`).click();
    // Step 3: Jira's columns; a category changed from its suggestion is outlined.
    const row = (name: string) => `${dialog}//div[@role="row"][@aria-label="${name}"]`;
    await expect($(row("QA Testing"))).toBeDisplayed({ wait: 10_000 });
    // Each column lists its statuses by name.
    await expect($(`${row("Done")}//span[normalize-space()="Ready to Deploy · Closed"]`)).toBeDisplayed();
    await choose(`${row("QA Testing")}//select`, "in_progress");
    await expect($(`${row("QA Testing")}//select`)).toHaveAttribute("data-changed", "true");
    await expect($(`${row("Open")}//select`)).not.toHaveAttribute("data-changed");
    // Dragging Done onto Open puts it first.
    await browser.execute(() => {
      const rows = [...document.querySelectorAll<HTMLElement>('[role="dialog"] [role="row"][aria-label]')];
      const at = (name: string) => rows.find((r) => r.getAttribute("aria-label") === name)!;
      const data = new DataTransfer();
      // A column drags by its grip.
      document.querySelector<HTMLElement>('[role="dialog"] [aria-label="Drag Done"]')!.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: data }));
      at("Open").dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data }));
      at("Open").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
    });
    await browser.waitUntil(async () => (await $(`(${dialog}//div[@role="row"][@aria-label])[1]`).getAttribute("aria-label")) === "Done", { timeout: 5_000 });
    await expect($(`${dialog}//*[contains(normalize-space(), "Drag to reorder.")]`)).toBeDisplayed();
    await browser.keys("Escape");
    await $(dialog).waitForExist({ reverse: true });
  });

  it("asks Jira who the user is before each search, and reads at most 5 pages", async () => {
    jiraEndless = true;
    try {
      await $('//div[@role="group"][@aria-label="Mode"]/button[starts-with(@aria-label, "Tasks")]').click();
      // Opening Tasks mode syncs once; look at one sync after it.
      await new Promise((r) => setTimeout(r, 2_000));
      asked.length = 0;
      await $('//button[@title="Refresh tasks"]').click();
      await browser.waitUntil(() => asked.filter((x) => x.path.startsWith("/jira/rest/api/3/search/jql")).length >= 5, { timeout: 15_000, timeoutMsg: JSON.stringify(asked) });
      await new Promise((r) => setTimeout(r, 1_000));
      const jira = asked.filter((x) => x.path.startsWith("/jira/"));
      expect(jira[0].path).toBe("/jira/rest/api/3/myself");
      expect(jira.filter((x) => x.path.startsWith("/jira/rest/api/3/search/jql"))).toHaveLength(5);
    } finally {
      jiraEndless = false;
    }
  });

  it("says when no Jira transition leads to the chosen column", async () => {
    await $('//button[@title="Refresh tasks"]').click();
    const card = $('//article[starts-with(@aria-label, "EX-1")]');
    await card.waitForDisplayed({ timeout: 15_000 });
    await card.$('//button[normalize-space()="Main order flow broken"]').click();
    await choose('//select[@aria-label="State of EX-1"]', "3");
    await expect($('//aside[@aria-label="Task detail"]').$(sel.text("No Jira transition leads to that column from here"))).toBeDisplayed({ wait: 15_000 });
  });

  it("adds a board from a JQL query the workspace has no board for, shows it, renames it in Board settings, and removes it from Settings (X50)", async () => {
    await $('//button[@title="Add a board"]').click();
    const dialog = '//div[@role="dialog"][@aria-label="Add a board"]';
    await expect($(dialog)).toBeDisplayed({ wait: 10_000 });
    await $(`(${dialog}//button[.//span[normalize-space()="Jira Cloud"]])[1]`).click();
    await $(`${dialog}//button[.//span[normalize-space()="A JQL query"]]`).click();
    // Each step's footer says what moonlet does with the tracker.
    await expect($(`${dialog}//*[normalize-space()="moonlet reads the board's configuration; it never changes it in Jira."]`)).toBeDisplayed();
    await fill(`${dialog}//textarea`, "project = EX");
    await $(`${dialog}//button[normalize-space()="Continue"]`).click();
    // Step 2 counts what the query brings.
    await expect($(`${dialog}//p[contains(normalize-space(), "3 issues match")]`)).toBeDisplayed({ wait: 15_000 });
    await expect($(`${dialog}//*[normalize-space()="Counts update as you type."]`)).toBeDisplayed();
    await $(`${dialog}//button[normalize-space()="Continue"]`).click();
    // Step 3: a column per status the issues are in.
    await expect($(`${dialog}//div[@role="row"][@aria-label="In Progress"]`)).toBeDisplayed({ wait: 10_000 });
    await $(`${dialog}//button[normalize-space()="Continue"]`).click();
    // The workspace already has a `project = EX` board.
    await expect($(`${dialog}//span[normalize-space()="This workspace already has a board from JQL query."]`)).toBeDisplayed({ wait: 10_000 });
    await expect($(`${dialog}//button[normalize-space()="Create board"]`)).toBeDisabled();
    await $(`${dialog}//nav//button[.//span[normalize-space()="Source"]]`).click();
    await fill(`${dialog}//textarea`, "project = EX AND type = Bug");
    await $(`${dialog}//nav//button[.//span[normalize-space()="Finish"]]`).click();
    await fill(`${dialog}//label[.//span[normalize-space()="Name"]]//input`, "EX query");
    await expect($(`${dialog}//*[normalize-space()="Saved to ~/.moonlet/trackers.toml."]`)).toBeDisplayed();
    await $(`${dialog}//button[normalize-space()="Create board"]`).click();
    await expect($('//nav[@aria-label="Boards"]//button[.//span[normalize-space()="EX query"]]')).toBeDisplayed({ wait: 10_000 });
    await expect($('//button[starts-with(@aria-label, "Switch board, current: EX query")]')).toBeDisplayed();
    await expect($('//article[starts-with(@aria-label, "EX-1")]')).toBeDisplayed({ wait: 15_000 });
    // A column's ⋯ menu opens Board settings, which saves the board where it was.
    await $('//button[@title="In Progress options"]').click();
    await $('//button[normalize-space()="Board settings…"]').click();
    const settings = '//div[@role="dialog"][@aria-label="Board settings"]';
    await expect($(settings)).toBeDisplayed({ wait: 10_000 });
    // Board settings outline a category changed from the board's own.
    await $(`${settings}//nav//button[.//span[normalize-space()="Columns"]]`).click();
    await choose(`${settings}//div[@role="row"][@aria-label="In Progress"]//select`, "in_review");
    await expect($(`${settings}//div[@role="row"][@aria-label="In Progress"]//select`)).toHaveAttribute("data-changed", "true");
    await choose(`${settings}//div[@role="row"][@aria-label="In Progress"]//select`, "in_progress");
    await $(`${settings}//nav//button[.//span[normalize-space()="Finish"]]`).click();
    await fill(`${settings}//label[.//span[normalize-space()="Name"]]//input`, "EX issues");
    await $(`${settings}//button[normalize-space()="Save"]`).click();
    await expect($('//nav[@aria-label="Boards"]//button[.//span[normalize-space()="EX issues"]]')).toBeDisplayed({ wait: 10_000 });
    await expect($('//nav[@aria-label="Boards"]//button[.//span[normalize-space()="EX query"]]')).not.toBeDisplayed();
    // Settings › Boards opens its settings and removes it, after asking (X50 Manage).
    await openSettings("Task trackers");
    const row = '//div[@role="group"][@aria-label="EX issues"]';
    await expect($(`${row}//*[normalize-space()="JQL query"]`)).toBeDisplayed({ wait: 10_000 });
    await $(`${row}//button[normalize-space()="Board settings"]`).click();
    await expect($('//div[@role="dialog"][@aria-label="Board settings"]')).toBeDisplayed({ wait: 10_000 });
    await browser.keys("Escape");
    await openSettings("Task trackers");
    await $(`${row}//button[normalize-space()="Remove"]`).click();
    await $(sel.confirmButton("Remove")).click();
    await expect($(row)).not.toBeExisting({ wait: 10_000 });
    await closeSettings();
    await expect($('//nav[@aria-label="Boards"]//button[.//span[normalize-space()="EX issues"]]')).not.toBeExisting({ wait: 10_000 });
  });
});
