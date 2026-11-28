import { describe, expect, it } from "vitest";
import { stripView } from "@desktop/lib/subagents";
import type { ChatState, Subagent } from "@desktop/lib/protocol";
import { dismissStrip, reviewScreen, stripDismissedAt } from "./agentsStrip";
import { NOW } from "./fixtures";

const agent = (id: string, status: Subagent["status"], started: number): Subagent => ({
  id,
  tool_use_id: `t-${id}`,
  description: id,
  prompt: "",
  status,
  started_at: started,
  ended_at: status === "running" ? null : started + 10_000,
  tokens: 0,
  tool_uses: 0,
  tools: [],
});
const chatWith = (subagents: Subagent[]): ChatState => ({
  items: [{ id: "u", kind: "user", text: "Go", ts: NOW - 60_000 }],
  pending: [],
  status: "idle",
  cost_usd: 0,
  input_tokens: 0,
  output_tokens: 0,
  slash_commands: [],
  queued: [],
  subagents,
});

describe("dismissStrip (X40, X42)", () => {
  it("hides that chat's agents strip until a new agent starts, and only that chat's", () => {
    const st = chatWith([agent("a1", "done", NOW - 50_000), agent("a2", "stopped", NOW - 40_000)]);
    expect(stripView(st, NOW, stripDismissedAt("mac:7"))).toMatchObject({ dismissible: true });
    dismissStrip("mac:7", st);
    expect(stripView(st, NOW, stripDismissedAt("mac:7"))).toBeNull();
    expect(stripView(st, NOW, stripDismissedAt("mac:8"))).toMatchObject({ dismissible: true });
    const again = chatWith([...st.subagents!, agent("a3", "running", NOW - 1_000)]);
    expect(stripView(again, NOW, stripDismissedAt("mac:7"))).toMatchObject({ counts: [{ text: "1 running" }, { text: "1 done" }, { text: "1 stopped" }] });
  });
});

describe("reviewScreen (X40, X42)", () => {
  it("reviews a session's agents in its Changes tab, and offers nothing for an agent without a session", () => {
    expect(reviewScreen({ kind: "session", host: "mac", id: "fix-login", tab: "chat" })).toEqual({ kind: "session", host: "mac", id: "fix-login", tab: "changes" });
    expect(reviewScreen({ kind: "agent", host: "mac", terminal: 7 })).toBeNull();
  });
});
