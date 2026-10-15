// Settings › Task trackers (X44): the GitHub connection through gh, a Keep in
// step rule saved to ~/.moonlet/trackers.toml, and Linear against a mock of its
// GraphQL API answering with the documented shapes (X44, X46). One file, so the
// specs never write trackers.toml from two apps at once.

import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { $, browser, expect } from "@wdio/globals";
import { choose, closeSettings, fill, openSettings, PROJECT, projectId, rpc, sel, trackerPort, world } from "../fixtures";

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

/** Linear's GraphQL endpoint: an answer per query, and a record of every move. */
function linear(query: string, variables: Record<string, unknown>): string {
  // Most specific first: the issues query names its `$teams` variable.
  if (query.includes("issueUpdate")) {
    moves.push(variables as (typeof moves)[number]);
    return answer("linear-issue-update.json");
  }
  if (query.includes("issues(")) {
    issuesAsked++;
    if (!endlessPages) return answer("linear-issues.json");
    const page = JSON.parse(answer("linear-issues.json"));
    page.data.issues.pageInfo = { hasNextPage: true, endCursor: `c${issuesAsked}` };
    return JSON.stringify(page);
  }
  if (query.includes("organization")) return JSON.stringify({ data: { viewer: { id: "8f1c2d3e-4b5a-4c6d-9e7f-0a1b2c3d4e5f", name: "Ada Lovelace", email: "ada@example.com" }, organization: { urlKey: "acme", name: "Acme" } } });
  if (query.includes("workflowStates")) return answer("linear-states.json");
  if (query.includes("teams")) return answer("linear-teams.json");
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

  it("connects with an API key, keeps the key out of trackers.toml, and shows a chosen team", async () => {
    await openSettings("Task trackers");
    await $(sel.settingsButton("Connect Linear")).click();
    // A key Linear refuses: its error shows in the dialog.
    await fill('//div[@role="dialog"]//input[@type="password"]', "lin_api_wrong");
    await $('//div[@role="dialog"]//button[normalize-space()="Connect"]').click();
    await expect($('//div[@role="dialog"]').$(sel.text("Linear no longer accepts this token. Create a new one and paste it here."))).toBeDisplayed({ wait: 15_000 });
    await fill('//div[@role="dialog"]//input[@type="password"]', "lin_api_e2e");
    await $('//div[@role="dialog"]//button[normalize-space()="Connect"]').click();
    await expect($(sel.text("Signed in as Ada Lovelace · 2 sources visible"))).toBeDisplayed({ wait: 15_000 });
    // Sources are added row by row: the first row starts empty, a second is added, then removed.
    await expect($('//div[@role="dialog"]').$(sel.text("Add the Linear teams whose issues Tasks mode shows. For each, pick the workspace that shows it, whose issues it shows and the moonlet project its sessions start in."))).toBeDisplayed();
    await choose('//div[@role="dialog"]//select[@aria-label="Source 1"]', "ENG");
    await $('//div[@role="dialog"]//button[normalize-space()="Add source"]').click();
    await choose('//div[@role="dialog"]//select[@aria-label="Source 2"]', "DES");
    await $('//div[@role="dialog"]//button[@aria-label="Remove Design"]').click();
    await $('//div[@role="listitem"][@aria-label="Design"]').waitForExist({ reverse: true });
    const eng = '//div[@role="listitem"][@aria-label="Engineering"]';
    const ws = rpc<{ id: string }[]>(w, "workspace.list", {})[0].id;
    await choose(`${eng}//select[@aria-label="Workspace for Engineering"]`, `local/${ws}`);
    await choose(`${eng}//select[@aria-label="Project for Engineering"]`, projectId(w));
    await $('//div[@role="dialog"]//button[normalize-space()="Save and sync"]').click();
    await expect($(sel.text("Connected as Ada Lovelace · API key · 1 source"))).toBeDisplayed({ wait: 10_000 });
    const toml = readFileSync(join(w.home, "trackers.toml"), "utf8");
    expect(toml).toContain('id = "linear:acme"');
    expect(toml).toContain('key = "ENG"');
    expect(toml).not.toContain('key = "DES"');
    expect(toml).not.toContain("lin_api_e2e");
    expect(readFileSync(join(w.home, "secrets.json"), "utf8")).toContain("lin_api_e2e");
  });

  it("maps a workflow state to another column, saved with the connection", async () => {
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

  it("shows the team's issues in Tasks mode", async () => {
    await $('//div[@role="group"][@aria-label="Mode"]/button[starts-with(@aria-label, "Tasks")]').click();
    await expect($('//section[@aria-label="In Progress"]//article[starts-with(@aria-label, "ENG-123")]')).toBeDisplayed({ wait: 15_000 });
    await expect($('//section[@aria-label="Todo"]//article[starts-with(@aria-label, "ENG-124")]')).toBeDisplayed();
    // The sidebar lists the workspace's sources.
    await expect($(sel.text("Linear · Engineering"))).toBeDisplayed();
    await $('//section[@aria-label="In Progress"]//article[starts-with(@aria-label, "ENG-123")]//button[normalize-space()="Retry failed webhook deliveries"]').click();
    await expect($('//aside[@aria-label="Task detail"]').$(sel.text("· Cycle 42"))).toBeDisplayed();
  });

  it("moves the issue to In Progress and assigns it when a session starts from it", async () => {
    const projectId = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!.id;
    await browser.execute((id: string) => localStorage.setItem(`moonlet.composer.${id}`, JSON.stringify({ agent: "none", model: null, effort: null })), projectId);
    await $('//section[@aria-label="Todo"]//article[starts-with(@aria-label, "ENG-124")]').$(sel.button("Start")).click();
    await expect($('//label[normalize-space()="Move ENG-124 to In Progress and assign it to me"]/input')).toBeSelected();
    await expect($(sel.text("eng-124-add-dark-mode-to-settings-page"))).toBeDisplayed({ wait: 10_000 });
    await $(sel.button("Create")).click();
    await browser.waitUntil(() => moves.length > 0, { timeout: 15_000, timeoutMsg: "Linear never got the move" });
    expect(moves[0]).toEqual({
      id: "1a2b3c4d-0000-4000-8000-000000000124",
      input: { stateId: "a1000000-0000-4000-8000-000000000002", assigneeId: "8f1c2d3e-4b5a-4c6d-9e7f-0a1b2c3d4e5f" },
    });
    await browser.execute((id: string) => localStorage.removeItem(`moonlet.composer.${id}`), projectId);
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

  it("stops asking Linear once it rejects the token, and the Settings nav shows a dot", async () => {
    rejecting = true;
    await $('//div[@role="group"][@aria-label="Mode"]/button[starts-with(@aria-label, "Tasks")]').click();
    await $('//button[@title="Refresh tasks"]').click();
    // The sidebar marks the source of a connection that needs attention.
    await expect($('//li[.//span[normalize-space()="Linear · Engineering"]]/span[@title]')).toBeDisplayed({ wait: 15_000 });
    await openSettings("Task trackers");
    await expect($('//*[@role="img"][@aria-label="1 connection needs attention"]')).toBeDisplayed({ wait: 15_000 });
    rejecting = false;
  });

  it("disconnects after asking: the token and the connection are gone", async () => {
    await $(sel.settingsButton("Disconnect")).click();
    await expect($(sel.text("moonlet forgets the token for acme and stops showing its issues. Sessions keep their links."))).toBeDisplayed({ wait: 10_000 });
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

  it("connects ClickUp with its raw token to the account's first workspace", async () => {
    await openSettings("Task trackers");
    await $(sel.settingsButton("Connect ClickUp")).click();
    await expect($('//div[@role="dialog"]').$(sel.text("The token is saved in the macOS Keychain."))).toBeDisplayed();
    await fill('//div[@role="dialog"]//input[@type="password"]', "pk_e2e_token");
    await $('//div[@role="dialog"]//button[normalize-space()="Connect"]').click();
    await expect($(sel.text("Signed in as John Doe · 4 sources visible"))).toBeDisplayed({ wait: 15_000 });
    await $('//div[@role="dialog"]//button[normalize-space()="Save and sync"]').click();
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
      await expect($(sel.text("Signed in as Mia Krystof · 2 sources visible"))).toBeDisplayed({ wait: 15_000 });
      if (site === "acme.atlassian.net") {
        await choose('//div[@role="dialog"]//select[@aria-label="Source 1"]', "EX");
        const ex = '//div[@role="listitem"][@aria-label="Example"]';
        const ws = rpc<{ id: string }[]>(w, "workspace.list", {})[0].id;
        await choose(`${ex}//select[@aria-label="Workspace for Example"]`, `local/${ws}`);
      }
      await $('//div[@role="dialog"]//button[normalize-space()="Save and sync"]').click();
    }
    const toml = readFileSync(join(w.home, "trackers.toml"), "utf8");
    expect([toml.includes('id = "jira:acme.atlassian.net"'), toml.includes('id = "jira:ops.atlassian.net"')]).toEqual([true, true]);
    await closeSettings();
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
});
