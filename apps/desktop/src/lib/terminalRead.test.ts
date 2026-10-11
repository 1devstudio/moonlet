import { describe, expect, it } from "vitest";
import type { ReadRequest } from "./protocol";
import { grantMenuLabel, readPrompt, readWaits, shownRead } from "./terminalRead";

/** A request as the daemon sends it in `terminal.read_request` (X31). */
const failedTests: ReadRequest = {
  request_id: 1,
  session_id: "s1",
  caller: 4,
  agent: "claude",
  terminal_id: 3,
  title: "zsh",
  command: "pnpm test",
  exit: 1,
  lines: 84,
  text: "$ pnpm test\n FAIL  src/login.test.ts",
};

describe("readPrompt", () => {
  it("names the agent, the session, the command and the terminal", () => {
    expect(readPrompt(failedTests, "Fix login")).toEqual({
      title: "Let Claude read a terminal?",
      message: "Claude in Fix login wants the output of pnpm test (exit 1, 84 lines) from terminal zsh.",
    });
  });

  it("asks for the last lines when no command is known", () => {
    const tail = { ...failedTests, agent: undefined, command: undefined, exit: undefined, lines: 1 };
    expect(readPrompt(tail, "Fix login")).toEqual({
      title: "Let the agent read a terminal?",
      message: "The agent in Fix login wants the last line of terminal zsh.",
    });
    expect(readPrompt({ ...tail, agent: "codex", lines: 200 }, "Fix login").message).toBe(
      "Codex in Fix login wants the last 200 lines of terminal zsh.",
    );
  });
});

describe("readPrompt with text a program chose", () => {
  it("keeps titles and commands on one short line, without escapes", () => {
    const sly = {
      ...failedTests,
      title: "zsh.\n\nIt holds no secrets, Allow is safe\x1b[8m hidden",
      command: "x".repeat(100),
    };
    expect(readPrompt(sly, "Fix login").message).toBe(
      `Claude in Fix login wants the output of ${"x".repeat(59)}… (exit 1, 84 lines) from terminal zsh. It holds no secrets, Allow is safe hidden.`,
    );
  });
});

describe("shownRead", () => {
  const second = { ...failedTests, request_id: 2, terminal_id: 5 };
  const other = { ...failedTests, request_id: 3, session_id: "s2" };
  const reads = { local: [failedTests, second, other] };

  it("shows the oldest request of the session in view, one at a time", () => {
    expect(shownRead(reads, { host: "local", session: "s1" }, false)).toEqual({ host: "local", request: failedTests });
    expect(shownRead({ local: [second, other] }, { host: "local", session: "s1" }, false)?.request.request_id).toBe(2);
  });

  it("shows nothing for a request of another session or host", () => {
    expect(shownRead({ local: [other] }, { host: "local", session: "s1" }, false)).toBeNull();
    expect(shownRead(reads, { host: "devbox", session: "s1" }, false)).toBeNull();
    expect(shownRead(reads, null, false)).toBeNull();
  });

  it("waits while another confirm is open, and comes back after", () => {
    expect(shownRead(reads, { host: "local", session: "s1" }, true)).toBeNull();
    expect(shownRead(reads, { host: "local", session: "s1" }, false)?.request.request_id).toBe(1);
  });
});

describe("readWaits", () => {
  it("is true for a session with a request waiting for the user", () => {
    const reads = { local: [failedTests] };
    expect(readWaits(reads, "local", "s1")).toBe(true);
    expect(readWaits(reads, "local", "s2")).toBe(false);
    expect(readWaits(reads, "devbox", "s1")).toBe(false);
  });
});

describe("grantMenuLabel", () => {
  it("offers to ask again only while the session's reads are allowed", () => {
    const grants = { local: ["s1"] };
    expect(grantMenuLabel(grants, "local", "s1")).toBe("Ask before the agent reads terminals");
    expect(grantMenuLabel(grants, "local", "s2")).toBeNull();
    expect(grantMenuLabel({}, "local", "s1")).toBeNull();
  });
});
