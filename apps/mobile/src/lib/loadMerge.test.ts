import { describe, expect, it } from "vitest";
import type { ReadRequest, TerminalInfo } from "@desktop/lib/protocol";
import { type HostData, emptyData } from "./app";
import { mergeLoaded, touchedSince } from "./loadMerge";

const term = (id: number, agent_state: TerminalInfo["agent_state"]) => ({ id, agent_state }) as TerminalInfo;
const summary = (pending: string[]) => ({ pending: pending.map((id) => ({ id, tool: "Bash", summary: "", input: {}, can_always: true })), status: "blocked" }) as unknown as HostData["chats"][number];
const read = (request_id: number) => ({ request_id }) as ReadRequest;

describe("mergeLoaded", () => {
  it("keeps what events said while the load was on its way", () => {
    // The load's replies left the daemon before these events did.
    const loaded: HostData = { ...emptyData(), terminals: { 1: term(1, "working") }, chats: { 1: summary([]), 2: summary(["old"]) }, reads: [read(7), read(8)] };
    const touched = touchedSince();
    touched.terminals.set(1, term(1, "blocked"));
    touched.chats.set(1, summary(["a1"]));
    touched.chats.set(2, null);
    touched.reads.set(8, null);
    touched.reads.set(9, read(9));
    const merged = mergeLoaded(loaded, touched);
    expect(merged.terminals[1].agent_state).toBe("blocked");
    expect(merged.chats[1].pending.map((a) => a.id)).toEqual(["a1"]);
    expect(merged.chats[2]).toBeUndefined();
    expect(merged.reads.map((r) => r.request_id)).toEqual([7, 9]);
  });

  it("is the load as it came when nothing happened meanwhile", () => {
    const loaded: HostData = { ...emptyData(), reads: [read(7)] };
    expect(mergeLoaded(loaded, touchedSince())).toEqual(loaded);
  });
});
