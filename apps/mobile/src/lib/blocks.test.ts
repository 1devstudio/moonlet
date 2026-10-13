import { describe, expect, it } from "vitest";
import { BlockReader } from "./blocks";

// `terminal.attach`'s snapshot of a real zsh in Blocks mode after
// `printf 'one\\ntwo\\n'`, `false` and `echo done` (60 x 16), its path renamed.
const SNAPSHOT = "\u001bc\u001b[0m\u001b]133;A;moonlet_age=5644\u0007\u001b[0m\r\n\u001b[0m\r\n\u001b[1mprintf 'one\\ntwo\\n'\u001b[0m\r\n\u001b]7;file:///Users/alex/.moonlet/worktrees/storefront/add-search\u0007\u001b]133;C;moonlet_age=3605\u0007one\u001b[0m\r\ntwo\u001b[0m\r\n\u001b]133;D;0;moonlet_age=3605\u0007\u001b]133;A;moonlet_age=3604\u0007\u001b[0m\r\n\u001b[0m\r\n\u001b[1mfalse\u001b[0m\r\n\u001b]133;C;moonlet_age=2403\u0007\u001b]133;D;1;moonlet_age=2403\u0007\u001b]133;A;moonlet_age=2403\u0007\u001b[0m\r\n\u001b[0m\r\n\u001b[1mecho done\u001b[0m\r\n\u001b]133;C;moonlet_age=1200\u0007done\u001b[0m\r\n\u001b]133;D;0;moonlet_age=1200\u0007\u001b]133;A;moonlet_age=1199\u0007\u001b[0m\r\n\u001b[0m\r\n\u001b[0m\r\n\u001b[0m\u001b[?25h\u001b[m\u001b[H\u001b[3;1H\u001b[1mprintf 'one\\ntwo\\n'\r\n\u001b[mone\r\ntwo\u001b[8;1H\u001b[1mfalse\u001b[11;1Hecho done\r\n\u001b[mdone\u001b[15;1H\u001b>\u001b[?1l\u001b[?2004h";
const NOW = 1_760_000_000_000;

describe("BlockReader", () => {
  it("reads each command's line, output, exit and directory from the OSC 133 marks", async () => {
    const r = new BlockReader(60, 16, () => NOW);
    await r.write(SNAPSHOT);
    expect(r.blocks().map((b) => [b.command, b.output, b.exit, b.running])).toEqual([
      ["printf 'one\\ntwo\\n'", "one\ntwo", 0, false],
      ["false", "", 1, false],
      ["echo done", "done", 0, false],
    ]);
    expect(r.blocks()[0].cwd).toBe("/Users/alex/.moonlet/worktrees/storefront/add-search");
  });

  it("times a replayed block from the ages the daemon put on its marks", async () => {
    const r = new BlockReader(60, 16, () => NOW);
    await r.write(SNAPSHOT);
    const b = r.blocks()[0];
    // `C;moonlet_age=3605` and `D;0;moonlet_age=3605`.
    expect([b.startedAt, b.endedAt]).toEqual([NOW - 3605, NOW - 3605]);
  });

  it("keeps a command running until its D mark, and starts again on reset", async () => {
    const r = new BlockReader(60, 16, () => NOW);
    await r.write(SNAPSHOT);
    await r.write("\x1b[1msleep 9\x1b[0m\r\n\x1b]133;C\x07half");
    const last = r.blocks().at(-1)!;
    expect([last.command, last.output, last.running, last.exit]).toEqual(["sleep 9", "half", true, null]);
    expect(last.startedAt).toBe(NOW);
    r.reset();
    expect(r.blocks()).toEqual([]);
  });
});
