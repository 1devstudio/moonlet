import { describe, expect, it } from "vitest";
import { type Aside, asideFooter, asideSettled, canAskAside, composerPlaceholder, interruptedLine, queuedCount, queuedHeader, queuedLine, sendNowLabel, sendNowParams, sendNowWarning, stoppingLine, unqueued, waitingOn } from "./queued";
import type { ChatItem, ChatState, QueuedMessage } from "./protocol";

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

describe("queuedHeader", () => {
  const running = waitingOn([ask, reply, check]);
  const warn = sendNowWarning(running, T0 + 60_000);

  it("is the queued line, the hover warning, or the stopping line after Send now", () => {
    expect(queuedHeader([port], running, null)).toEqual({ line: { text: "Queued · Claude reads it after", command: "pnpm stack:check" }, tone: "waiting", ring: false });
    expect(queuedHeader([port], running, warn)).toEqual({ line: { text: "Send now stops", command: "pnpm stack:check", tail: "(running 0:57)" }, tone: "warn", ring: true });
    expect(queuedHeader([{ ...port, sending: true }], running, warn)).toEqual({ line: { text: "Stopping", command: "pnpm stack:check", tail: "…" }, tone: "sending", ring: true });
  });

  it("rings nothing when no command runs", () => {
    expect(queuedHeader([{ ...port, sending: true }], null, null)).toEqual({ line: { text: "Sending…" }, tone: "sending", ring: false });
  });
});

describe("sendNowParams", () => {
  it("names the message when it is the only one, and sends every one otherwise", () => {
    expect(sendNowParams([port])).toEqual({ message: port.id });
    expect(sendNowParams([timeout, port])).toEqual({});
  });
});

describe("unqueued", () => {
  const st = (queued: QueuedMessage[], ...items: ChatItem[]): Pick<ChatState, "queued" | "items"> => ({ queued, items: [ask, reply, check, ...items] });

  it("waits while the message is queued", () => {
    expect(unqueued(st([port]), port.id)).toBe("waiting");
  });

  it("is cancelled when the message left the queue without being read", () => {
    expect(unqueued(st([]), port.id)).toBe("cancelled");
  });

  it("is taken when Claude read the message first", () => {
    // The daemon gives a message Claude reads its uuid as its id.
    expect(unqueued(st([], { id: port.id, kind: "user", text: port.text, ts: T0 + 9_000 }), port.id)).toBe("taken");
  });
});

describe("asideSettled", () => {
  const asking: Aside = { question: "and the web port?" };

  it("keeps the answer or the error of the question still open", () => {
    expect(asideSettled(asking, "and the web port?", { error: "No conversation found with session ID: e2e-queue" })).toEqual({ question: "and the web port?", error: "No conversation found with session ID: e2e-queue" });
    expect(asideSettled(asking, "and the web port?", { answer: { text: "3000.", cost_usd: 0.0015, duration_ms: 3_200 } })).toEqual({
      question: "and the web port?",
      answer: { text: "3000.", cost_usd: 0.0015, duration_ms: 3_200 },
    });
  });

  it("drops a late reply to a question that was closed or replaced", () => {
    expect(asideSettled(null, "and the web port?", { error: "late" })).toBeNull();
    expect(asideSettled({ question: "which db?" }, "and the web port?", { error: "late" })).toEqual({ question: "which db?" });
  });
});

describe("canAskAside", () => {
  it("is offered while Claude works, and not while a plan is revised", () => {
    expect(canAskAside("claude", true, false)).toBe(true);
    expect(canAskAside("claude", false, false)).toBe(false);
    expect(canAskAside("codex", true, false)).toBe(false);
    expect(canAskAside("claude", true, true)).toBe(false);
  });
});
