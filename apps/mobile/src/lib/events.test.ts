import { describe, expect, it } from "vitest";
import type { ChatState, ReadRequest, TerminalInfo } from "@desktop/lib/protocol";
import { type HostData, emptyData } from "./app";
import { applyChanges, eventChanges } from "./events";

const term = (id: number, agent_state: TerminalInfo["agent_state"]) => ({ id, agent_state }) as TerminalInfo;
const read = (request_id: number) => ({ request_id }) as ReadRequest;
const state = (pending: string[]): ChatState =>
  ({ items: [{ id: "i1" }], pending: pending.map((id) => ({ id, tool: "Bash" })), status: pending.length ? "blocked" : "idle" }) as unknown as ChatState;
const start = (): HostData => ({ ...emptyData(), terminals: { 1: term(1, "working"), 2: term(2, "idle") }, chats: { 1: { ...state([]), items: undefined } as never }, reads: [read(7)] });
const apply = (d: HostData, name: string, data: unknown) => {
  const c = eventChanges(name, data);
  return c === "reload" ? "reload" : applyChanges(d, c);
};

describe("events", () => {
  it("keep terminals as the daemon reports them", () => {
    const d = apply(start(), "terminal.updated", term(1, "blocked")) as HostData;
    expect(d.terminals[1].agent_state).toBe("blocked");
    expect((apply(start(), "terminal.created", term(3, "idle")) as HostData).terminals[3].id).toBe(3);
  });

  it("forget a removed terminal and its chat", () => {
    const d = apply(start(), "terminal.removed", { id: 1 }) as HostData;
    expect(Object.keys(d.terminals)).toEqual(["2"]);
    expect(d.chats[1]).toBeUndefined();
  });

  it("keep a chat's state without its items", () => {
    const d = apply(start(), "chat.state", { id: 1, state: state(["a1"]) }) as HostData;
    expect(d.chats[1].pending.map((a) => a.id)).toEqual(["a1"]);
    expect("items" in d.chats[1]).toBe(false);
  });

  it("add a read request once, and drop it when done", () => {
    let d = apply(start(), "terminal.read_request", read(8)) as HostData;
    d = apply(d, "terminal.read_request", read(8)) as HostData;
    expect(d.reads.map((r) => r.request_id)).toEqual([7, 8]);
    d = apply(d, "terminal.read_done", { request_id: 7 }) as HostData;
    expect(d.reads.map((r) => r.request_id)).toEqual([8]);
  });

  it("ask for a reload when projects, sessions, workspaces or sections change", () => {
    for (const name of ["sessions.changed", "projects.changed", "workspaces.changed", "sections.changed"]) expect(eventChanges(name, {})).toBe("reload");
    expect(eventChanges("fs.changed", {})).toEqual([]);
  });

  it("win over a load that started before them", () => {
    // The load's replies left the daemon before these events did.
    const loaded: HostData = { ...emptyData(), terminals: { 1: term(1, "working") }, reads: [read(7), read(8)] };
    const during = [...(eventChanges("terminal.updated", term(1, "blocked")) as never[]), ...(eventChanges("terminal.read_done", { request_id: 8 }) as never[])];
    const merged = applyChanges(loaded, during);
    expect(merged.terminals[1].agent_state).toBe("blocked");
    expect(merged.reads.map((r) => r.request_id)).toEqual([7]);
  });
});
