// X22: an agent in the fixture session runs `moonlet session new`; the app
// announces the new session and marks where it came from. A3: the toast can
// be dismissed.

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

/** Opens `name` as the agent in the parent session's first terminal would, and returns its toast. */
async function agentOpens(name: string) {
  const parent = rpc<Session[]>(w, "session.list", {}).find((s) => s.name === SESSION)!;
  await $(sel.sessionRow(SESSION)).click();
  execFileSync(join(BIN_DIR, "moonlet"), ["session", "new", PROJECT, "--agent", "none", name], {
    env: { ...w.env, MOONLET_TERMINAL_ID: String(parent.terminals[0]) },
    stdio: "pipe",
  });
  const toast = $(`//div[button[normalize-space()="Go to"]][contains(normalize-space(), "${SESSION} started ${name} in ${PROJECT}")]`);
  await expect(toast).toBeDisplayed({ wait: 15_000 });
  return toast;
}

describe("an agent opens a session", () => {
  it("shows a toast and a from line, without leaving the current session", async () => {
    const toast = await agentOpens("Add a download button");
    const row = $(sel.sessionRow("Add a download button"));
    await expect(row).toBeDisplayed();
    await expect(row).toHaveAttribute("title", expect.stringContaining(`from ${SESSION}`));
    await expect($(sel.sessionRow(SESSION))).toHaveAttribute("aria-current", "true");

    await toast.$("button=Go to").click();
    await expect(row).toHaveAttribute("aria-current", "true");
  });

  it("dismisses the toast without leaving the current session", async () => {
    const toast = await agentOpens("Add a share link");
    await toast.$('button[aria-label="Dismiss"]').click();
    // Well before the 10 s after which the toast closes on its own.
    await expect(toast).not.toBeExisting({ wait: 2_000 });
    await expect($(sel.sessionRow(SESSION))).toHaveAttribute("aria-current", "true");
  });
});
