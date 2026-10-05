import { describe, expect, it } from "vitest";
import { blockAt, blockCopy, blockForAgent, blockHeader, blockRects, commandFromRows, outputToCopy, replayedHeaderLine, selectStep } from "./terminals";

const ctx = { home: "/Users/me", worktree: "/Users/me/src/app", branch: "main" };

describe("block headers (T8)", () => {
  it("shows the directory, the session branch and the duration", () => {
    expect(blockHeader({ cwd: "/Users/me/src/app", end: {}, exit: 0, startedAt: 0, endedAt: 53 }, ctx)).toEqual({
      place: "~/src/app git:(main)",
      exit: null,
      duration: "(0.053s)",
      running: false,
    });
  });

  it("adds a failing exit code before the duration", () => {
    expect(blockHeader({ cwd: "/Users/me", end: {}, exit: 1, startedAt: 0, endedAt: 300 }, ctx)).toEqual({
      place: "~",
      exit: "exit 1",
      duration: "(0.300s)",
      running: false,
    });
  });

  it("leaves the branch out outside the session's worktree", () => {
    expect(blockHeader({ cwd: "/tmp", end: {}, exit: 0, startedAt: 0, endedAt: 12_340 }, ctx).place).toBe("/tmp");
  });

  it("formats long durations like T7", () => {
    expect(blockHeader({ cwd: "/tmp", end: {}, startedAt: 0, endedAt: 12_340 }, ctx).duration).toBe("(12.3s)");
    expect(blockHeader({ cwd: "/tmp", end: {}, startedAt: 0, endedAt: 125_000 }, ctx).duration).toBe("(2m 5s)");
  });

  it("marks a running block and has no duration yet", () => {
    expect(blockHeader({ cwd: "/Users/me/src/app/lib", startedAt: 0 }, ctx)).toEqual({
      place: "~/src/app/lib git:(main)",
      exit: null,
      duration: null,
      running: true,
    });
  });

  it("has no duration for a block replayed from before the app attached", () => {
    expect(blockHeader({ cwd: "/Users/me", end: {}, exit: 0 }, ctx).duration).toBeNull();
  });

  it("does not treat a sibling directory as inside the worktree", () => {
    expect(blockHeader({ cwd: "/Users/me/src/app-old", end: {} }, ctx).place).toBe("~/src/app-old");
  });
});

describe("block backgrounds (T8)", () => {
  // A failed block on rows 10-14 (its end mark is on row 15, the next header).
  const failed = { start: 10, end: 15, exit: 2 };

  it("covers a failed block's rows in the viewport", () => {
    expect(blockRects([failed], 8, 24)).toEqual([{ top: 2, height: 5, kind: "failed" }]);
  });

  it("clips a block whose header scrolled above the viewport", () => {
    expect(blockRects([failed], 12, 24)).toEqual([{ top: 0, height: 3, kind: "failed" }]);
  });

  it("highlights the selected block, even a failed one", () => {
    expect(blockRects([{ start: 0, end: 4, exit: 0, selected: true }, { ...failed, selected: true }], 0, 24)).toEqual([
      { top: 0, height: 4, kind: "selected" },
      { top: 10, height: 5, kind: "selected" },
    ]);
  });

  it("skips successful, running and off-screen blocks", () => {
    expect(blockRects([{ start: 0, end: 4, exit: 0 }, { start: 4 }, { start: 40, end: 45, exit: 1 }], 0, 24)).toEqual([]);
  });
});

describe("header row of a block whose prompt came before the app attached (T8)", () => {
  it("is the row above a one-row command", () => {
    expect(replayedHeaderLine(12, () => false)).toBe(10);
  });

  it("is the row above every row of a wrapped command", () => {
    // Output starts on row 12; the command fills rows 9-11 (10 and 11 wrapped).
    expect(replayedHeaderLine(12, (y) => y === 10 || y === 11)).toBe(8);
  });
});

describe("command text from the screen (T8)", () => {
  it("joins a wrapped command without inserting newlines", () => {
    // An 10-column terminal: `echo abcdefghij klm` wraps after `echo abcde`.
    expect(commandFromRows([{ text: "echo abcde", wrapped: false }, { text: "fghij klm ", wrapped: true }])).toBe("echo abcdefghij klm");
  });

  it("keeps a space that fell at the wrap", () => {
    expect(commandFromRows([{ text: "ls -la    ", wrapped: false }, { text: "src", wrapped: true }])).toBe("ls -la    src");
  });

  it("keeps the line breaks of a multi-line command", () => {
    expect(commandFromRows([{ text: "for f in *; do  ", wrapped: false }, { text: "  echo $f; done", wrapped: false }])).toBe("for f in *; do\n  echo $f; done");
  });
});

describe("block selection (T8)", () => {
  // Two finished blocks (rows 0-3 and 4-9) and one still running from row 10.
  const blocks = [{ start: 0, end: 4 }, { start: 4, end: 10 }, { start: 10 }];

  it("finds the finished block under a row", () => {
    expect(blockAt(blocks, 0)).toBe(0);
    expect(blockAt(blocks, 9)).toBe(1);
  });

  it("finds nothing on a running block or below the blocks", () => {
    expect(blockAt(blocks, 12)).toBeNull();
    expect(blockAt([{ start: 3, end: 5 }], 1)).toBeNull();
  });

  it("steps up from the input to the newest finished block, then older ones", () => {
    expect(selectStep(blocks, null, -1)).toBe(1);
    expect(selectStep(blocks, 1, -1)).toBe(0);
    expect(selectStep(blocks, 0, -1)).toBe(0);
  });

  it("steps down to newer blocks, then back to the input", () => {
    expect(selectStep(blocks, 0, 1)).toBe(1);
    expect(selectStep(blocks, 1, 1)).toBeNull();
    expect(selectStep(blocks, null, 1)).toBeNull();
  });

  it("has nothing to select without finished blocks", () => {
    expect(selectStep([{ start: 0 }], null, -1)).toBeNull();
  });
});

describe("copying a block (T8)", () => {
  const ls = { command: "ls", output: "README.md\nsrc" };

  it("copies the command line and its output", () => {
    expect(blockCopy(ls, "all")).toBe("$ ls\nREADME.md\nsrc");
  });

  it("copies just the output or just the command", () => {
    expect(blockCopy(ls, "output")).toBe("README.md\nsrc");
    expect(blockCopy(ls, "command")).toBe("ls");
  });

  it("copies only the command line when there was no output", () => {
    expect(blockCopy({ command: "true", output: "" }, "all")).toBe("$ true");
  });
});

describe("⇧⌘C (T8)", () => {
  it("copies the selected block's output", () => {
    expect(outputToCopy("README.md", "older")).toEqual({ text: "README.md", toast: "Copied output" });
  });

  it("says so when the selected block printed nothing, instead of copying another block", () => {
    expect(outputToCopy("", "older")).toEqual({ text: null, toast: "No output" });
  });

  it("copies the last output when no block is selected, and does nothing without one", () => {
    expect(outputToCopy(null, "older")).toEqual({ text: "older", toast: "Copied output" });
    expect(outputToCopy(null, "")).toEqual({ text: null, toast: null });
  });
});

describe("sending a block to an agent (T8)", () => {
  it("fences the command line and its output", () => {
    expect(blockForAgent({ command: "npm test", output: "1 failed\n  expected 2, got 3" })).toBe(
      "```\n$ npm test\n1 failed\n  expected 2, got 3\n```\n",
    );
  });

  it("uses a longer fence when the output contains one", () => {
    expect(blockForAgent({ command: "cat README.md", output: "```sh\nls\n```" })).toBe("````\n$ cat README.md\n```sh\nls\n```\n````\n");
  });
});
