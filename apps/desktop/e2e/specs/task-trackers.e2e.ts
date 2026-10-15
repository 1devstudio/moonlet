// Settings › Task trackers (X44): the GitHub connection through gh, and a
// Keep in step rule saved to ~/.moonlet/trackers.toml.

import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { closeSettings, openSettings, sel, world } from "../fixtures";

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
    await browser.waitUntil(() => readFileSync(file, "utf8").includes('session_starts = "auto"'), { timeout: 10_000 });
  });
});
