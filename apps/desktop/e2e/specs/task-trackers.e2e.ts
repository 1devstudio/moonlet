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
});

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "crates", "moonlet-trackers", "tests", "fixtures");
const answer = (name: string) => readFileSync(join(fixtures, name), "utf8");
const moves: { id: string; input: Record<string, string> }[] = [];
let server: Server;

/** Linear's GraphQL endpoint: an answer per query, and a record of every move. */
function linear(query: string, variables: Record<string, unknown>): string {
  // Most specific first: the issues query names its `$teams` variable.
  if (query.includes("issueUpdate")) {
    moves.push(variables as (typeof moves)[number]);
    return answer("linear-issue-update.json");
  }
  if (query.includes("issues(")) return answer("linear-issues.json");
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
        res.end(req.url === "/linear/graphql" && req.headers.authorization === "lin_api_e2e" ? linear(query, variables ?? {}) : JSON.stringify({ errors: [{ message: "Authentication required", extensions: { type: "authentication error" } }] }));
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
    await fill('//div[@role="dialog"]//input[@type="password"]', "lin_api_e2e");
    await $('//div[@role="dialog"]//button[normalize-space()="Connect"]').click();
    await expect($(sel.text("Signed in as Ada Lovelace · 2 sources visible"))).toBeDisplayed({ wait: 15_000 });
    const eng = '//div[@role="listitem"][@aria-label="Engineering"]';
    await $(`${eng}//input[@type="checkbox"]`).click();
    const ws = rpc<{ id: string }[]>(w, "workspace.list", {})[0].id;
    await choose(`${eng}//select[@aria-label="Workspace for Engineering"]`, `local/${ws}`);
    await choose(`${eng}//select[@aria-label="Project for Engineering"]`, projectId(w));
    await $('//div[@role="dialog"]//button[normalize-space()="Save and sync"]').click();
    await expect($(sel.text("Connected as Ada Lovelace · API key · 1 source"))).toBeDisplayed({ wait: 10_000 });
    const toml = readFileSync(join(w.home, "trackers.toml"), "utf8");
    expect(toml).toContain('id = "linear:acme"');
    expect(toml).toContain('key = "ENG"');
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
});
