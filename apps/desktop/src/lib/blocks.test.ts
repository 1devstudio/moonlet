import { describe, expect, it } from "vitest";
import { blockActions, blockAt, blockCopy, blockForAgent, blockHeader, blockLayout, blockRects, commandFromRows, inlineHeader, outputToCopy, pickBlockForAgent, replayedPromptLine, rerunInput, selectStep } from "./terminals";

const ctx = { home: "/Users/me", worktree: "/Users/me/src/app", branch: "main" };

describe("block headers (T8)", () => {
  it("shows the directory, the session branch and the duration", () => {
    expect(blockHeader({ cwd: "/Users/me/src/app", end: {}, exit: 0, startedAt: 0, endedAt: 53 }, ctx)).toEqual({
      node: null,
      place: "~/src/app",
      branch: "main",
      changes: null,
      exit: null,
      duration: "(0.053s)",
      running: false,
    });
  });

  it("adds a failing exit code before the duration", () => {
    expect(blockHeader({ cwd: "/Users/me", end: {}, exit: 1, startedAt: 0, endedAt: 300 }, ctx)).toEqual({
      node: null,
      place: "~",
      branch: null,
      changes: null,
      exit: "exit 1",
      duration: "(0.300s)",
      running: false,
    });
  });

  it("leaves the branch out outside the session's worktree", () => {
    expect(blockHeader({ cwd: "/tmp", end: {}, exit: 0, startedAt: 0, endedAt: 12_340 }, ctx)).toMatchObject({ place: "/tmp", branch: null });
  });

  it("formats long durations like T7", () => {
    expect(blockHeader({ cwd: "/tmp", end: {}, startedAt: 0, endedAt: 12_340 }, ctx).duration).toBe("(12.3s)");
    expect(blockHeader({ cwd: "/tmp", end: {}, startedAt: 0, endedAt: 125_000 }, ctx).duration).toBe("(2m 5s)");
  });

  it("marks a running block and has no duration yet", () => {
    expect(blockHeader({ cwd: "/Users/me/src/app/lib", startedAt: 0 }, ctx)).toEqual({
      node: null,
      place: "~/src/app/lib",
      branch: "main",
      changes: null,
      exit: null,
      duration: null,
      running: true,
    });
  });

  it("has no duration for a block replayed from before the app attached", () => {
    expect(blockHeader({ cwd: "/Users/me", end: {}, exit: 0 }, ctx).duration).toBeNull();
  });

  it("does not treat a sibling directory as inside the worktree", () => {
    expect(blockHeader({ cwd: "/Users/me/src/app-old", end: {} }, ctx)).toMatchObject({ place: "~/src/app-old", branch: null });
  });
});

describe("block header with node version and changes (T8)", () => {
  const changes = { files: 5, additions: 113, deletions: 30 };

  it("adds the node version and the uncommitted changes recorded when the command started", () => {
    expect(blockHeader({ cwd: "/Users/me/src/app", node: "v24.19.0", changes, end: {}, exit: 0, startedAt: 0, endedAt: 53 }, ctx)).toEqual({
      node: "v24.19.0",
      place: "~/src/app",
      branch: "main",
      changes: "5 • +113 -30",
      exit: null,
      duration: "(0.053s)",
      running: false,
    });
  });

  it("leaves the changes out outside the session's worktree", () => {
    expect(blockHeader({ cwd: "/tmp", node: "v24.19.0", changes, end: {} }, ctx).changes).toBeNull();
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

describe("prompt row of a block whose prompt came before the app attached (T8)", () => {
  // Output starts on row 12. `empty` lists the empty rows; `wrapped` the rows that continue the one above.
  const rows = (empty: number[], wrapped: number[] = []) => [(y: number) => wrapped.includes(y), (y: number) => empty.includes(y)] as const;

  it("is the spacer row of a two-row prompt", () => {
    expect(replayedPromptLine(12, ...rows([9, 10]))).toBe(9);
  });

  it("skips every row of a wrapped command", () => {
    // The command fills rows 9-11 (10 and 11 wrapped); the prompt rows are 7 and 8.
    expect(replayedPromptLine(12, ...rows([7, 8], [10, 11]))).toBe(7);
  });

  it("is the single empty row of a one-row prompt", () => {
    expect(replayedPromptLine(12, ...rows([10]))).toBe(10);
  });

  it("is the command's own row when the shell left no empty row", () => {
    // Row 10 is the previous block's output, not part of this block.
    expect(replayedPromptLine(12, ...rows([]))).toBe(11);
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

  it("uses a longer fence when the command contains one", () => {
    expect(blockForAgent({ command: "cat <<'EOF'\n```\nEOF", output: "```" })).toBe("````\n$ cat <<'EOF'\n```\nEOF\n```\n````\n");
  });

  it("uses a longer fence when the output contains one", () => {
    expect(blockForAgent({ command: "cat README.md", output: "```sh\nls\n```" })).toBe("````\n$ cat README.md\n```sh\nls\n```\n````\n");
  });
});

describe("where a block's header goes (T8)", () => {
  const empty = (rows: number[]) => (y: number) => rows.includes(y);

  it("puts the separator in the spacer row and the header below it", () => {
    // Prompt mark on row 10; rows 10 and 11 are the shell's empty prompt; the command is on 12, output from 13.
    expect(blockLayout(10, 13, empty([10, 11]))).toEqual({ separator: 10, header: 11, commandFrom: 12 });
  });

  it("shares one row between separator and header when the prompt has one empty row", () => {
    expect(blockLayout(10, 12, empty([10]))).toEqual({ separator: 10, header: 10, commandFrom: 11 });
  });

  it("puts the header at the end of the command line when the shell left no empty row", () => {
    // An older shell integration: the command sits on the prompt mark's row.
    expect(blockLayout(10, 11, empty([]))).toEqual({ separator: 10, header: null, commandFrom: 10 });
  });
});

describe("header at the end of the command line (T8)", () => {
  const h = { node: "v24.19.0", place: "~/src/app", branch: "main", changes: "5 • +113 -30", exit: "exit 1", duration: "(0.300s)", running: false };
  const status = { node: null, place: null, branch: null, changes: null, running: false };

  it("shows everything when the row has room", () => {
    expect(inlineHeader(h, 80)).toEqual(h);
  });

  it("drops the node version, directory and changes, then the duration, to stay clear of the command", () => {
    expect(inlineHeader(h, 40)).toEqual({ ...status, exit: "exit 1", duration: "(0.300s)" });
    expect(inlineHeader(h, 11)).toEqual({ ...status, exit: "exit 1", duration: null });
  });

  it("shows nothing when even the status does not fit", () => {
    expect(inlineHeader(h, 5)).toBeNull();
  });
});

describe("which block ⌘↵ sends (T8)", () => {
  it("sends the selected block", () => {
    expect(pickBlockForAgent("selected", "newest", "git status")).toBe("selected");
  });

  it("sends the newest block when nothing is selected and the input is empty", () => {
    expect(pickBlockForAgent(null, "newest", "  ")).toBe("newest");
  });

  it("leaves ⌘↵ to a typed command", () => {
    expect(pickBlockForAgent(null, "newest", "git status")).toBeNull();
    expect(pickBlockForAgent(null, null, "")).toBeNull();
  });
});

describe("block hover actions (T8)", () => {
  it("offers Copy to agent, Copy and Re-run on a finished block with a header row", () => {
    expect(blockActions({ end: {}, command: "ls" }, false)).toEqual(["agent", "copy", "rerun"]);
  });

  it("offers nothing on a running block, a block without a command, or an inline header", () => {
    expect(blockActions({ command: "sleep 9" }, false)).toEqual([]);
    expect(blockActions({ end: {} }, false)).toEqual([]);
    expect(blockActions({ end: {}, command: "ls" }, true)).toEqual([]);
  });
});

describe("re-running a block (T8)", () => {
  it("types a one-line command and presses Enter", () => {
    expect(rerunInput("ls -la")).toBe("ls -la\r");
  });

  it("sends a multi-line command as one bracketed paste, so no line runs on its own", () => {
    expect(rerunInput("for f in *; do\n  echo $f; done")).toBe("\x1b[200~for f in *; do\n  echo $f; done\x1b[201~\r");
  });

  it("drops control characters, so the text cannot end the paste or act as keys", () => {
    expect(rerunInput("echo hi\x1b[201~\x03rm -rf ~")).toBe("echo hi[201~rm -rf ~\r");
  });

  it("sends nothing for an empty command", () => {
    expect(rerunInput("  ")).toBeNull();
  });
});
