// New session from the composer with the repo's fake agent, then Run.
// The repo has a setup script too, so the session opens two tabs.

import { $, browser, expect } from "@wdio/globals";
import { CONFIG, PROJECT, fill, rpc, sel, world, writeConfig } from "../fixtures";

const w = world();

interface Project {
  id: string;
  name: string;
}
interface Session {
  name: string;
  agent: string | null;
}

describe("new session and Run", () => {
  it("creates a session with the fake agent and runs the run command", async () => {
    writeConfig(w, CONFIG.replace("[agents]", 'run = "echo e2e-run-ok; sleep 60"\n\n[agents]'));
    const project = rpc<Project[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!;
    // Start the composer on "Terminal only" rather than its Claude default.
    // It reads this choice each time it opens.
    await browser.execute((id: string) => localStorage.setItem(`jaunt.composer.${id}`, JSON.stringify({ agent: "none", model: null, effort: null })), project.id);

    await $('button[title="New session"]').click();
    await fill('//textarea[@placeholder="What do you want to work on?"]', "Add e2e banner");
    await $('//button[.//span[normalize-space()="Terminal only"]]').click();
    await $('//button[normalize-space()="fake"]').click();
    await $(sel.button("Create")).click();

    await expect($(sel.sessionRow("Add e2e banner"))).toBeDisplayed({ wait: 30_000 });
    const created = rpc<Session[]>(w, "session.list", {}).find((s) => s.name === "Add e2e banner");
    expect(created?.agent).toBe("fake");
    await expect($('//span[normalize-space()="fake"]')).toBeDisplayed();
    // The project has a setup script; the agent's tab opens, not setup's.
    await expect($('//span[normalize-space()="setup"]')).toBeDisplayed();
    await expect($('//*[@aria-current="true"][.//span[normalize-space()="fake"]]')).toBeDisplayed();

    await $('//button[normalize-space()="Run"]').click();
    await expect($('//span[normalize-space()="run"]')).toBeDisplayed();
  });
});
