// Models from Claude Code (X105): the Composer's model column lists the
// models the host's Claude Code offers, from its answer to `initialize`, with
// the older ones under More models, and the Effort column follows the model.

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { fill, projectId, world } from "../fixtures";

const w = world();
const FAKE = join(w.root, "bin", "claude");

/** Answers `initialize` with part of Claude Code 2.1.325's model list. */
const FAKE_CLAUDE = String.raw`#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*)
      id=$(printf '%s' "$line" | sed 's/.*"request_id":"\([^"]*\)".*/\1/')
      printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"commands":[],"models":[%s]}}}\n' "$id" '{"value":"default","displayName":"Default (recommended)","resolvedModel":"claude-opus-5-5","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"]},{"value":"opus","displayName":"Opus 5.5","resolvedModel":"claude-opus-5-5","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"]},{"value":"fable","displayName":"Fable 5.2","resolvedModel":"claude-fable-5-2","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"]},{"value":"sonnet","displayName":"Sonnet 5.5","resolvedModel":"claude-sonnet-5-5","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"]},{"value":"haiku","displayName":"Haiku 5.5","resolvedModel":"claude-haiku-5-5","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"]},{"value":"claude-fable-5-1","displayName":"Fable 5.1","resolvedModel":"claude-fable-5-1","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"]},{"value":"claude-opus-4-6","displayName":"Opus 4.6","resolvedModel":"claude-opus-4-6","supportsEffort":true,"supportedEffortLevels":["low","medium","high","max"]}' ;;
  esac
done
`;

const opt = (label: string) => `//button[.//span[normalize-space()="${label}"]]`;

describe("models from Claude Code (X105)", () => {
  let before_: string;
  before(async () => {
    before_ = readFileSync(FAKE, "utf8");
    writeFileSync(FAKE, FAKE_CLAUDE);
    chmodSync(FAKE, 0o755);
    await browser.execute((id: string) => localStorage.setItem(`moonlet.composer.${id}`, JSON.stringify({ agent: "claude", model: "fable", effort: "xhigh" })), projectId(w));
  });

  after(async () => {
    writeFileSync(FAKE, before_);
    chmodSync(FAKE, 0o755);
    await browser.execute((id: string) => localStorage.removeItem(`moonlet.composer.${id}`), projectId(w));
    await browser.keys("Escape");
  });

  it("lists the newest models, the older ones under More models, and the efforts of the chosen one", async () => {
    await $('button[title="New session"]').click();
    await fill('//textarea[@placeholder="What do you want to work on?"]', "Pick a model");
    // The picker names the model as Claude Code does once the host has answered.
    const picker = '//button[.//span[normalize-space()="Fable 5.2"]][.//span[normalize-space()="Extra high"]]';
    await expect($(picker)).toBeDisplayed({ wait: 30_000 });
    await $(picker).click();

    for (const label of ["Opus 5.5", "Fable 5.2", "Sonnet 5.5", "Haiku 5.5", "More models"]) await expect($(opt(label))).toBeDisplayed();
    await expect($(opt("Default (recommended)"))).not.toBeExisting();
    await expect($(opt("Opus 4.6"))).not.toBeExisting();

    await $(opt("More models")).click();
    await expect($(opt("Fable 5.1"))).toBeDisplayed();
    await $(opt("Opus 4.6")).click();

    // Opus 4.6 has no Extra high: the effort becomes High.
    await expect($('//button[.//span[normalize-space()="Opus 4.6"]][.//span[normalize-space()="High"]]')).toBeDisplayed();
    await expect($(opt("Extra high"))).not.toBeExisting();
    await expect($(opt("Max"))).toBeDisplayed();
    await browser.keys("Escape");
  });

  it("drops a saved effort the model turns out not to support", async () => {
    await browser.execute((id: string) => localStorage.setItem(`moonlet.composer.${id}`, JSON.stringify({ agent: "claude", model: "claude-opus-4-6", effort: "xhigh" })), projectId(w));
    await $('button[title="New session"]').click();
    await fill('//textarea[@placeholder="What do you want to work on?"]', "Saved effort");
    await expect($('//button[.//span[normalize-space()="Opus 4.6"]][.//span[normalize-space()="High"]]')).toBeDisplayed({ wait: 30_000 });
    const saved = await browser.execute((id: string) => localStorage.getItem(`moonlet.composer.${id}`), projectId(w));
    expect(JSON.parse(saved ?? "{}").effort).toBe("high");
  });
});
