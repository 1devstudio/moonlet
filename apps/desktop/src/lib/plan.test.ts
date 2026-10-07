import { describe, expect, it } from "vitest";
import { planChat, planLabels, planTabDot, planView } from "./plan";
import type { ChatItem, ChatState, PermissionAsk } from "./protocol";

// The input of an ExitPlanMode call as claude 2.1.291 sent it.
const input = {
  plan: "# Add a dark theme\n\n- Add a `theme` setting\n",
  planFilePath: "/Users/me/.claude/plans/add-a-dark-theme.md",
};

const call = (id: string, status: "running" | "ok" | "error" | "denied", plan = input): ChatItem => ({
  id,
  kind: "tool",
  text: "",
  tool: { name: "ExitPlanMode", summary: "Add a dark theme", input: plan, status },
  ts: 1_760_000_000_000,
});

const ask: PermissionAsk = { id: "r1", tool: "ExitPlanMode", summary: "Add a dark theme", input, can_always: false };

const chat = (items: ChatItem[], pending: PermissionAsk[] = [], mode: string | null = "plan"): ChatState => ({
  items,
  pending,
  status: pending.length ? "blocked" : "done",
  mode,
  cost_usd: 0,
  input_tokens: 0,
  output_tokens: 0,
  slash_commands: [],
  queued: [],
});

const user: ChatItem = { id: "u1", kind: "user", text: "Plan a dark theme", ts: 1_759_999_990_000 };

describe("planView (X24)", () => {
  it("shows a waiting plan with its ask and its transcript row", () => {
    expect(planView(chat([user, call("t1", "running")], [ask]))).toEqual({
      plan: "# Add a dark theme\n\n- Add a `theme` setting\n",
      file: "/Users/me/.claude/plans/add-a-dark-theme.md",
      title: "Add a dark theme",
      ts: 1_760_000_000_000,
      itemId: "t1",
      askId: "r1",
      status: "pending",
      mode: null,
    });
  });

  it("is null for a chat without a plan", () => {
    expect(planView(chat([user]))).toBeNull();
    expect(planView(chat([user, call("t1", "ok", { plan: " ", planFilePath: "" })]))).toBeNull();
  });

  it("reads an answered plan's outcome from its call", () => {
    expect(planView(chat([user, call("t1", "denied")]))).toMatchObject({ status: "revising", askId: null, itemId: "t1", mode: null });
    expect(planView(chat([user, call("t1", "error")]))).toMatchObject({ status: "stopped", mode: null });
    expect(planView(chat([user, call("t1", "ok")], [], "auto"))).toMatchObject({ status: "approved", mode: "auto" });
    expect(planView(chat([user, call("t1", "ok")], [], "manual"))).toMatchObject({ status: "approved", mode: "manual" });
  });

  it("waits while the call runs, before its ask arrives", () => {
    expect(planView(chat([user, call("t1", "running")]))).toMatchObject({ status: "pending", askId: null, itemId: "t1" });
  });

  it("shows the latest plan", () => {
    const revised = { plan: "# Add a dark theme behind a flag\n", planFilePath: input.planFilePath };
    const v = planView(chat([user, call("t1", "denied"), call("t2", "running", revised)], [{ ...ask, id: "r2", input: revised }]));
    expect(v).toMatchObject({ plan: "# Add a dark theme behind a flag\n", itemId: "t2", askId: "r2", status: "pending" });
  });

  it("falls back to the ask when its call is not in the transcript", () => {
    expect(planView(chat([user], [ask]))).toMatchObject({ itemId: null, askId: "r1", status: "pending", title: "Add a dark theme", ts: null });
  });
});

describe("planLabels (X24)", () => {
  it("names each status for the card and the panel", () => {
    expect(planLabels("pending", null)).toEqual({ card: "Claude has a plan · waiting for approval", panel: "Waiting for your approval", tone: "blocked" });
    expect(planLabels("revising", null)).toEqual({ card: "Plan · revising with your feedback", panel: "Revising", tone: "accent" });
    expect(planLabels("stopped", null)).toEqual({ card: "Plan · stopped", panel: "Stopped", tone: "muted" });
  });

  it("names an approved plan after the mode it runs in", () => {
    expect(planLabels("approved", "auto")).toEqual({ card: "Plan approved · auto mode", panel: "Approved · auto mode", tone: "done" });
    expect(planLabels("approved", "acceptEdits")).toEqual({ card: "Plan approved · accepting edits", panel: "Approved · accepting edits", tone: "done" });
    expect(planLabels("approved", "manual")).toEqual({ card: "Plan approved · asking before edits", panel: "Approved · asking before edits", tone: "done" });
    // Before Claude reports the new mode, or in a mode a plan does not approve into.
    expect(planLabels("approved", "plan")).toEqual({ card: "Plan approved", panel: "Approved", tone: "done" });
    expect(planLabels("approved", null)).toEqual({ card: "Plan approved", panel: "Approved", tone: "done" });
  });
});

describe("planChat (X24)", () => {
  const plain = chat([user]);
  const waiting = chat([user, call("t1", "running")], [ask]);

  it("follows the chat whose plan waits", () => {
    expect(planChat(3, [{ id: 3, st: plain }, { id: 7, st: waiting }])).toBe(7);
  });

  it("else the focused chat, else the session's first", () => {
    expect(planChat(7, [{ id: 3, st: plain }, { id: 7, st: plain }])).toBe(7);
    // The focused pane is a shell, or its chat has not loaded.
    expect(planChat(12, [{ id: 7, st: plain }, { id: 3, st: undefined }])).toBe(3);
    expect(planChat(null, [])).toBeNull();
  });
});

describe("planTabDot (X24)", () => {
  it("marks the Plan tab while a plan waits and the tab is not showing", () => {
    expect(planTabDot("files", true)).toBe(true);
    expect(planTabDot("plan", true)).toBe(false);
    expect(planTabDot("files", false)).toBe(false);
  });
});
