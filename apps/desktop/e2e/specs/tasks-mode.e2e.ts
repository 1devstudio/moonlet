// Tasks mode (X45) with GitHub Issues (X44): the board shows the project's
// issues with the sessions working on them, and a session opens from its card.

import { execFileSync } from "node:child_process";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { PROJECT, projectId, rpc, sel, SESSION, world } from "../fixtures";

interface Session {
  id: string;
  name: string;
  branch: string;
  task?: { connection: string; key: string; url: string } | null;
}

const w = world();
const fakeGh = join(w.root, "bin", "gh");
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

const LINKED = "Checkout on Safari";
const tasksButton = () => $('//div[@role="group"][@aria-label="Mode"]/button[starts-with(@aria-label, "Tasks")]');
const sessionsButton = () => $('//div[@role="group"][@aria-label="Mode"]/button[@aria-label="Sessions"]');
const card = (key: string, column: string) => $(`//section[@aria-label=${JSON.stringify(column)}]//article[starts-with(@aria-label, ${JSON.stringify(key)})]`);
let linkedId = "";

describe("Tasks mode", () => {
  before(() => {
    // gh answers the issue list; anything else fails, as with no gh at all.
    writeFileSync(fakeGh, `#!/bin/sh\nif [ "$1 $2" = "issue list" ]; then cat <<'JSON'\n${ISSUES}\nJSON\nexit 0; fi\nexit 1\n`);
    chmodSync(fakeGh, 0o755);
    // GIT_ALLOW_PROTOCOL=file in the e2e env keeps git from ever reaching github.com.
    git("remote", "add", "origin", "https://github.com/acme/storefront.git");
    linkedId = rpc<{ id: string }>(w, "session.create", { project_id: projectId(w), name: LINKED, branch: "12-fix-checkout", agent: "none" }).id;
  });

  after(async () => {
    if (await sessionsButton().isExisting()) await sessionsButton().click();
    await browser.execute((id: string) => localStorage.removeItem(`moonlet.composer.${id}`), projectId(w));
    for (const s of rpc<Session[]>(w, "session.list", {}).filter((s) => s.id === linkedId || s.task)) rpc(w, "session.archive", { id: s.id });
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
    const row = $(`//section[@aria-label="Sessions without a task"]//button[.//span[normalize-space()=${JSON.stringify(SESSION)}]]`);
    await expect(row).toBeDisplayed();
    await expect(row.$(sel.text("Looks like acme/storefront#12 Fix checkout button"))).toBeDisplayed();
    await $('//nav[@aria-label="Views"]//button[starts-with(normalize-space(), "My issues")]').click();
  });

  it("starts a session from a task with the issue as the first message, its branch and the link", async () => {
    // "Terminal only", so no agent starts (the composer reads this each time it opens).
    await browser.execute((id: string) => localStorage.setItem(`moonlet.composer.${id}`, JSON.stringify({ agent: "none", model: null, effort: null })), projectId(w));
    await card("acme/storefront#15", "Todo").$(sel.button("Start")).click();
    await expect($(sel.text("For acme/storefront#15"))).toBeDisplayed();
    await expect($(sel.text("15-gift-cards-at-checkout"))).toBeDisplayed({ wait: 10_000 });
    await expect($('//textarea[@placeholder="What do you want to work on?"]')).toHaveValue("acme/storefront#15 · Gift cards at checkout");
    await $(sel.button("Create")).click();

    await expect($(sel.sessionRow("Gift cards at checkout"))).toBeDisplayed({ wait: 30_000 });
    await expect(sessionsButton()).toHaveAttribute("aria-pressed", "true");
    const created = rpc<Session[]>(w, "session.list", {}).find((s) => s.name === "Gift cards at checkout");
    expect(created?.branch).toBe("15-gift-cards-at-checkout");
    expect(created?.task).toEqual({ connection: "github:github.com", key: "acme/storefront#15", url: "https://github.com/acme/storefront/issues/15" });
  });
});
