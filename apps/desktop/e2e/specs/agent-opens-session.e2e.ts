// X22: an agent in the fixture session runs `moonlet session new`; the app
// announces the new session and marks where it came from.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { $, expect } from "@wdio/globals";
import { BIN_DIR, PROJECT, SESSION, rpc, sel, world } from "../fixtures";

const w = world();

interface Session {
  id: string;
  name: string;
  terminals: number[];
}

describe("an agent opens a session", () => {
  it("shows a toast and a from line, without leaving the current session", async () => {
    const parent = rpc<Session[]>(w, "session.list", {}).find((s) => s.name === SESSION)!;
    await $(sel.sessionRow(SESSION)).click();

    // As the agent in the parent session's first terminal would run it.
    execFileSync(join(BIN_DIR, "moonlet"), ["session", "new", PROJECT, "--agent", "none", "Add a download button"], {
      env: { ...w.env, JAUNT_TERMINAL_ID: String(parent.terminals[0]) },
      stdio: "pipe",
    });

    const toast = $(`//div[button[normalize-space()="Go to"]][contains(normalize-space(), "${SESSION} started Add a download button in ${PROJECT}")]`);
    await expect(toast).toBeDisplayed({ wait: 15_000 });
    const row = $(sel.sessionRow("Add a download button"));
    await expect(row).toBeDisplayed();
    await expect(row).toHaveAttribute("title", expect.stringContaining(`from ${SESSION}`));
    await expect($(sel.sessionRow(SESSION))).toHaveAttribute("aria-current", "true");

    await toast.$('button').click();
    await expect(row).toHaveAttribute("aria-current", "true");
  });
});
