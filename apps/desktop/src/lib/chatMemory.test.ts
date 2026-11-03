import { describe, expect, it, vi } from "vitest";
import { chatKey, chatSummary, loadChatSummary, onChatItem, onChatState, reloadChats, showChat, useChat } from "./chat";
import type { ChatState } from "./protocol";

/** What the daemon's `chat.state` answers, by `host:id`. */
const daemon = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("./daemon", () => ({ rpc: (host: string, _method: string, params: { id: number }) => Promise.resolve(daemon[`${host}:${params.id}`]) }));

const chat = (text: string, extra: Partial<ChatState> = {}): ChatState => ({
  items: [{ id: `${text}-1`, kind: "assistant", text, ts: 0 }],
  pending: [],
  status: "idle",
  cost_usd: 0,
  input_tokens: 0,
  output_tokens: 0,
  slash_commands: [],
  queued: [],
  ...extra,
});
const texts = (host: string, id: number) => useChat.getState().chats[chatKey(host, id)]?.items.map((i) => i.text);

describe("chats kept in memory (X81)", () => {
  it("keeps the items of the last 8 chats shown and drops the others'", async () => {
    for (let id = 1; id <= 9; id++) daemon[`a:${id}`] = chat(`chat ${id}`, { status: "done" });
    for (let id = 1; id <= 9; id++) await showChat("a", id);
    expect(texts("a", 1)).toBeUndefined();
    expect(texts("a", 2)).toEqual(["chat 2"]);
    expect(texts("a", 9)).toEqual(["chat 9"]);
  });

  it("loads a dropped chat's items again when it is shown again", async () => {
    for (let id = 1; id <= 9; id++) daemon[`b:${id}`] = chat(`chat ${id}`);
    for (let id = 1; id <= 9; id++) await showChat("b", id);
    daemon["b:1"] = chat("chat 1, later");
    await showChat("b", 1);
    expect(texts("b", 1)).toEqual(["chat 1, later"]);
    // The 8 shown last are 1 and 3–9 now: 2 dropped its items.
    expect(texts("b", 2)).toBeUndefined();
    expect(texts("b", 3)).toEqual(["chat 3"]);
  });

  it("keeps a dropped chat's status and asks current, without its items", async () => {
    for (let id = 1; id <= 9; id++) daemon[`c:${id}`] = chat(`chat ${id}`);
    for (let id = 1; id <= 9; id++) await showChat("c", id);
    const ask = { id: "ask-1", tool: "Bash", summary: "rm -rf build", input: { command: "rm -rf build" }, can_always: true };
    onChatState("c", 1, { ...chat(""), items: [], status: "blocked", pending: [ask] });
    onChatItem("c", 1, { id: "late", kind: "assistant", text: "streamed while dropped", ts: 0 });
    const st = chatSummary(useChat.getState(), "c", 1);
    expect(st?.status).toBe("blocked");
    expect(st?.pending.map((a) => a.summary)).toEqual(["rm -rf build"]);
    expect(texts("c", 1)).toBeUndefined();
    // Shown again, it reads its items from the daemon, not from the events.
    await showChat("c", 1);
    expect(texts("c", 1)).toEqual(["chat 1"]);
  });

  it("keeps only the status and asks of a chat loaded but not shown", async () => {
    daemon["d:1"] = chat("never shown", { status: "working" });
    await loadChatSummary("d", 1);
    expect(chatSummary(useChat.getState(), "d", 1)?.status).toBe("working");
    expect(texts("d", 1)).toBeUndefined();
    // Shown, it reads its items.
    await showChat("d", 1);
    expect(texts("d", 1)).toEqual(["never shown"]);
  });

  it("reloads on connect only the chats already in memory", async () => {
    daemon["e:1"] = chat("shown");
    daemon["e:2"] = chat("in the Agents panel");
    await showChat("e", 1);
    await loadChatSummary("e", 2);
    // The host reconnects: each chat moved on meanwhile.
    daemon["e:1"] = chat("shown, later");
    daemon["e:2"] = chat("in the Agents panel, later", { status: "done" });
    daemon["e:3"] = chat("never asked for");
    await reloadChats("e", [1, 2, 3]);
    expect(texts("e", 1)).toEqual(["shown, later"]);
    expect(chatSummary(useChat.getState(), "e", 2)?.status).toBe("done");
    expect(texts("e", 2)).toBeUndefined();
    expect(chatSummary(useChat.getState(), "e", 3)).toBeUndefined();
  });
});
