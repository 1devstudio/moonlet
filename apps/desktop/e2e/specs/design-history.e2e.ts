// A design's History (X65 entry 11): the daemon's snapshots, taken as the
// design's agent ends a turn that changed its page, listed in the right
// rail's History tab as each is taken; one previewed read only under the
// blue bar, Back to current, and a restore that writes the page file and
// adds a Restored snapshot entry.
//
// The snapshots come from a fake agent whose every turn writes the page:
// the snapshot of edits by hand waits for 10 s of quiet, which the daemon
// tests shorten through MOONLET_DESIGN_QUIET_MS.

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { diskShows, within } from "../design";
import { rpc, world } from "../fixtures";

const w = world();
const FAKE = join(w.root, "bin", "claude");
const workspaceId = () => rpc<{ id: string }[]>(w, "workspace.list", {})[0].id;
const mode = (label: string) => $(`//div[@role="group"][@aria-label="Mode"]/button[starts-with(@aria-label, "${label}")]`);
const SYSTEM = "history-kit";
const SLUG = "history-page";
const file = () => join(w.home, "design", workspaceId(), "designs", SLUG, "pages", "index.html");
const onDisk = () => readFileSync(file(), "utf8");
const history = () => rpc<{ n: number; type: string }[]>(w, "design.history", { workspace: workspaceId(), slug: SLUG });
const agent = () => rpc<{ slug: string; agent: number | null }[]>(w, "design.list", { workspace: workspaceId() }).find((d) => d.slug === SLUG)?.agent ?? null;
const rail = () => $('//aside[@aria-label="Right rail"]');
const row = (n: number) => rail().$(`.//article[@aria-label="Snapshot ${n}"]`);
const bar = (tone: string) => $(`//div[@role="status"][@data-tone="${tone}"]`);
const barButton = (label: string) => bar("blue").$(`.//button[normalize-space()="${label}"]`);
const canvasMode = (label: string) => $(`//div[@role="group"][@aria-label="Canvas mode"]/button[starts-with(normalize-space(), "${label}")]`);

// A design agent whose every turn writes the page, "Turn <n>".
const WRITING_CLAUDE = String.raw`#!/bin/sh
out() { printf '%s\n' "$1"; }
n=0
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) out '{"type":"system","subtype":"init","session_id":"e2e-history","model":"e2e-model","permissionMode":"acceptEdits","slash_commands":[]}' ;;
    *'"type":"user"'*)
      n=$((n+1)); mkdir -p pages
      printf '<!doctype html>\n<html><body data-mid="m1"><h1 data-mid="m2">Turn %s</h1></body></html>\n' "$n" > pages/index.html
      out '{"type":"assistant","message":{"id":"a'"$n"'","content":[{"type":"text","text":"Wrote turn '"$n"'."}]}}'
      out '{"type":"result","subtype":"success","is_error":false,"usage":{}}' ;;
  esac
done
`;

/** Waits until the daemon lists `n` snapshots of the design. */
const snapshots = (n: number) => browser.waitUntil(() => history().length >= n, { timeout: 15_000, timeoutMsg: `no ${n} snapshots: ${JSON.stringify(history())}` });

describe("A design's History", () => {
  let fake = "";
  before(async () => {
    fake = readFileSync(FAKE, "utf8");
    writeFileSync(FAKE, WRITING_CLAUDE);
    chmodSync(FAKE, 0o755);
    const ws = workspaceId();
    rpc(w, "design.system.create", { workspace: ws, name: "History kit", sources: [], agent: false });
    // The brief is the first turn: it writes Turn 1.
    rpc(w, "design.create", { workspace: ws, name: "History page", system: SYSTEM, brief: "A settings page" });
    await snapshots(1);
    rpc(w, "chat.send", { id: agent(), text: "Another take" });
    await snapshots(2);
    await mode("Design").click();
    await $('//nav[@aria-label="Designs"]//button[.//span[normalize-space()="History page"]]').click();
    await expect($('//iframe[@title="index.html"]')).toBeExisting();
  });

  after(async () => {
    writeFileSync(FAKE, fake);
    for (const d of rpc<{ slug: string }[]>(w, "design.list", { workspace: workspaceId() })) rpc(w, "design.remove", { workspace: workspaceId(), slug: d.slug });
    rpc(w, "design.system.remove", { workspace: workspaceId(), slug: SYSTEM });
    await within(5_000, (async () => {
      if (await mode("Sessions").isExisting()) await mode("Sessions").click();
    })());
  });

  it("lists the snapshots in the History tab from the toolbar's History button, newest first, and a new one as its turn ends", async () => {
    await $('//button[@aria-label="History"]').click();
    await expect(rail().$('.//button[@role="tab"][@aria-selected="true"]')).toHaveText("History");
    await expect(rail()).toHaveText(expect.stringContaining("Snapshots of pages/ and assets/. The last 50 are kept."));
    await expect(row(2)).toHaveText(expect.stringContaining("Agent turn"));
    await expect(row(2)).toHaveText(expect.stringContaining("Wrote index.html · 1 page"));
    await expect(row(1)).toBeDisplayed();
    rpc(w, "chat.send", { id: agent(), text: "A third take" });
    await expect(row(3)).toBeDisplayed();
    expect(await rail().$$(".//article").map((a) => a.getAttribute("aria-label"))).toEqual(["Snapshot 3", "Snapshot 2", "Snapshot 1"]);
    await diskShows(onDisk, (html) => html.includes("Turn 3"), "got the third turn");
  });

  it("previews a snapshot read only under the blue bar, in View, and Back to current shows the current page", async () => {
    await row(1).$(".//button").click();
    await expect(bar("blue")).toBeDisplayed();
    expect(await bar("blue").getText()).toMatch(/^Previewing the snapshot from \d\d:\d\d, agent turn\. Nothing changes until you restore it\./);
    const frame = $('//iframe[@title="index.html at snapshot 1"]');
    await expect(frame).toBeExisting();
    expect(await frame.getAttribute("src")).toContain(`/designs/${SLUG}%401/pages/index.html`);
    expect(await frame.getAttribute("src")).not.toContain("moonlet-bridge");
    await expect(canvasMode("Comment")).toBeDisabled();
    await expect(canvasMode("Edit")).toBeDisabled();
    await expect($("//*[normalize-space()='read only' or contains(normalize-space(), '· read only')]")).toBeExisting();
    await barButton("Back to current").click();
    await expect(bar("blue")).not.toBeExisting();
    await expect($('//iframe[@title="index.html"]')).toBeExisting();
    await expect(canvasMode("Comment")).toBeEnabled();
  });

  it("restores a snapshot, which writes the page file on disk and adds a Restored snapshot entry", async () => {
    await row(1).$(".//button").click();
    await expect(bar("blue")).toBeDisplayed();
    await barButton("Restore").click();
    await diskShows(onDisk, (html) => html.includes("Turn 1"), "went back to the first turn");
    await expect(bar("blue")).not.toBeExisting();
    await expect(row(4)).toBeDisplayed();
    await expect(row(4)).toHaveText(expect.stringContaining("Restored snapshot 1"));
    expect(await row(4).getText()).toMatch(/From \d\d:\d\d/);
    expect(history()[0]).toMatchObject({ n: 4, type: "restored" });
  });
});
