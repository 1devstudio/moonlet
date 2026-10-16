import { describe, expect, it } from "vitest";
import { asideFooter, composerPlaceholder, interruptedLine, queuedCount, queuedLine, sendNowLabel, sendNowWarning, stoppingLine, waitingOn } from "./queued";
import type { ChatItem, QueuedMessage } from "./protocol";

const T0 = 1_792_150_000_000;

// The chat after "Run the full stack check" while `pnpm stack:check` runs (X49).
const ask: ChatItem = { id: "user-1", kind: "user", text: "Great. Run the full stack check before we push.", ts: T0 };
const reply: ChatItem = { id: "msg_1:0", kind: "assistant", text: "Running the full stack check.", ts: T0 + 2_000 };
const check: ChatItem = {
  id: "toolu_01",
  kind: "tool",
  text: "",
  ts: T0 + 3_000,
  tool: { name: "Bash", summary: "pnpm stack:check", input: { command: "pnpm stack:check" }, status: "running" },
};
const port: QueuedMessage = { id: "11111111-1111-4111-8111-111111111111", text: "wait, which port did we end up on for the api?" };
const timeout: QueuedMessage = { id: "22222222-2222-4222-8222-222222222222", text: "also bump the e2e timeout to 60s" };

describe("queuedLine", () => {
  it("names the running command a queued message waits for", () => {
    expect(queuedLine([port], waitingOn([ask, reply, check]))).toEqual({ text: "Queued · Claude reads it after", command: "pnpm stack:check" });
  });

  it("says Claude reads it at its next step when no command runs", () => {
    expect(queuedLine([port], waitingOn([ask, reply]))).toEqual({ text: "Queued · Claude reads it at its next step" });
  });

  it("counts two or more", () => {
    expect(queuedLine([timeout, port], waitingOn([ask, reply, check]))).toEqual({ text: "2 queued · Claude reads them after", command: "pnpm stack:check" });
  });
});

describe("Send now", () => {
  it("counts the messages it sends", () => {
    expect(sendNowLabel([port])).toBe("Send now");
    expect(sendNowLabel([timeout, port])).toBe("Send 2 now");
  });

  it("warns that it stops the running command, and for how long it ran", () => {
    const running = waitingOn([ask, reply, check]);
    expect(sendNowWarning(running, T0 + 3_000 + 492_000)).toEqual({ text: "Send now stops", command: "pnpm stack:check", tail: "(running 8:12)" });
    expect(sendNowWarning(null, T0)).toBeNull();
  });

  it("says what it is stopping until Claude reads the message", () => {
    expect(stoppingLine(waitingOn([ask, reply, check]))).toEqual({ text: "Stopping", command: "pnpm stack:check", tail: "…" });
    expect(stoppingLine(null)).toEqual({ text: "Sending…" });
  });
});

describe("interruptedLine", () => {
  // The daemon's items after Send now stopped the check 8:12 in (X49).
  const stopped: ChatItem = { ...check, tool: { ...check.tool!, status: "error", output: "Interrupted by user" } };
  const interrupted: ChatItem = { id: "system-1", kind: "system", text: "Interrupted", ts: T0 + 3_000 + 492_000 };

  it("names the command a stop ended and when", () => {
    expect(interruptedLine([ask, reply, stopped, interrupted], 3)).toEqual({ text: "Interrupted by you ·", command: "pnpm stack:check", tail: "stopped at 8:12" });
  });

  it("leaves other notes, and a stop while Claude wrote, alone", () => {
    expect(interruptedLine([ask, reply, interrupted], 2)).toBeNull();
    expect(interruptedLine([ask, reply, stopped, { ...interrupted, text: "Stopped" }], 3)).toBeNull();
  });
});

describe("Ask aside", () => {
  it("shows how long the answer took and what it cost", () => {
    // Claude Code 2.1.301's aside reply (`claude-aside.json`).
    expect(asideFooter({ text: "Teal.", cost_usd: 0.00278639, duration_ms: 1493 })).toBe("1s · $0.0028");
    expect(asideFooter({ text: "4000.", cost_usd: 0.0015, duration_ms: 3_200 })).toBe("3s · $0.0015");
  });
});

describe("the composer while Claude works", () => {
  it("offers to queue a message for Claude", () => {
    expect(composerPlaceholder("claude", true)).toBe("Queue a message for Claude");
    expect(composerPlaceholder("codex", true)).toBe("Queue a message…");
    expect(composerPlaceholder("claude", false)).toBe("Ask for a change, @ to mention a file, / for commands");
  });

  it("counts the queue in the footer", () => {
    expect(queuedCount([])).toBeNull();
    expect(queuedCount([port])).toBe("· 1 queued");
    expect(queuedCount([timeout, port])).toBe("· 2 queued");
  });
});
