import { describe, expect, it, vi } from "vitest";
import { chatHasItem, chatKey, chatSummary, holdChat, loadChatSummaries, onChatItem, onChatState, reloadChats, showChat, showChats, useChat } from "./chat";
import { newChatContext } from "./chatContext";
import type { ChatItem, ChatState, TerminalInfo } from "./protocol";

/** What the daemon's `chat.state` answers, by `host:id`; nothing while its
 *  host is down. `chat.summaries` answers each of the host's without items.
 *  `asked` notes each request, as `chat.state e:1` or `chat.summaries e`. */
const { daemon, asked } = vi.hoisted(() => ({ daemon: {} as Record<string, unknown>, asked: [] as string[] }));
vi.mock("./daemon", () => ({
  rpc: (host: string, method: string, params?: { id: number }) => {
    if (method === "chat.summaries") {
      asked.push(`${method} ${host}`);
      const mine = Object.entries(daemon).filter(([k, v]) => k.startsWith(`${host}:`) && !(v instanceof Promise));
      return Promise.resolve(mine.map(([k, v]) => ({ id: Number(k.split(":")[1]), state: { ...(v as object), items: [] } })));
    }
    asked.push(`${method} ${host}:${params?.id}`);
    const st = daemon[`${host}:${params?.id}`];
    return st === undefined ? Promise.reject(new Error(`${host} is not connected`)) : Promise.resolve(st);
  },
}));

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
    await loadChatSummaries("d");
    expect(chatSummary(useChat.getState(), "d", 1)?.status).toBe("working");
    expect(texts("d", 1)).toBeUndefined();
    // Its transcript was not asked for until it is shown.
    expect(asked.filter((a) => a.endsWith(" d") || a.includes(" d:"))).toEqual(["chat.summaries d"]);
    await showChat("d", 1);
    expect(texts("d", 1)).toEqual(["never shown"]);
  });

  it("keeps the status of a chat whose state comes while its first summary is read", async () => {
    daemon["l:1"] = chat("", { status: "idle" });
    // The Agents panel asks for the summaries; the chat starts working
    // before they come.
    const read = loadChatSummaries("l");
    onChatState("l", 1, { ...chat(""), items: [], status: "working" });
    await read;
    expect(chatSummary(useChat.getState(), "l", 1)?.status).toBe("working");
    expect(texts("l", 1)).toBeUndefined();
  });

  it("reloads on connect only the chats already in memory", async () => {
    daemon["e:1"] = chat("shown");
    daemon["e:2"] = chat("in the Agents panel");
    await showChat("e", 1);
    await loadChatSummaries("e");
    // The host reconnects: each chat moved on meanwhile.
    daemon["e:1"] = chat("shown, later");
    daemon["e:2"] = chat("in the Agents panel, later", { status: "done" });
    daemon["e:3"] = chat("never asked for");
    await reloadChats("e", [1, 2, 3]);
    expect(texts("e", 1)).toEqual(["shown, later"]);
    expect(chatSummary(useChat.getState(), "e", 2)?.status).toBe("done");
    expect(texts("e", 2)).toBeUndefined();
    expect(chatSummary(useChat.getState(), "e", 3)).toBeUndefined();
    // Only the shown chat's transcript was read again.
    expect(asked.filter((a) => a.endsWith(" e") || a.includes(" e:"))).toEqual(["chat.state e:1", "chat.summaries e", "chat.state e:1", "chat.summaries e"]);
  });

  it("loads on reconnect a chat shown while its host was down", async () => {
    const release = holdChat("i", 1);
    await expect(showChat("i", 1)).rejects.toThrow("i is not connected");
    daemon["i:1"] = chat("read once the host is back");
    await reloadChats("i", [1]);
    expect(texts("i", 1)).toEqual(["read once the host is back"]);
    release();
  });

  it("never drops the items of a chat on screen, however many are on screen", async () => {
    for (let id = 1; id <= 10; id++) daemon[`f:${id}`] = chat(`chat ${id}`);
    // Ten views show a chat each, and each shows its chat again, as a view
    // does when it renders again: none drops another's items.
    const release: (() => void)[] = [];
    for (let id = 1; id <= 10; id++) {
      release.push(holdChat("f", id));
      await showChat("f", id);
    }
    for (let id = 1; id <= 10; id++) await showChat("f", id);
    for (let id = 1; id <= 10; id++) expect(texts("f", id)).toEqual([`chat ${id}`]);
    // Off screen, chat 1 is not among the last 8 shown (3–10): it drops its
    // items. Chat 10 is, and keeps them.
    release[0]();
    release[9]();
    expect(texts("f", 1)).toBeUndefined();
    expect(texts("f", 10)).toEqual(["chat 10"]);
  });

  it("keeps the chats a new chat's chips read while it is shown, however many there are", async () => {
    const terms = Array.from({ length: 11 }, (_, i) => ({ id: i + 1, kind: "agent", title: "claude", cwd: "/Users/jane/code/app", command: ["claude"], session_id: "s1", agent: "claude", cols: 120, rows: 32, pid: 1, chat: true, created_at: i + 1 }) as TerminalInfo);
    for (let id = 1; id <= 10; id++) daemon[`h:${id}`] = { ...chat(""), items: [{ id: `u${id}`, kind: "user", text: `Task ${id}`, ts: 0 }] };
    daemon["h:11"] = { ...chat(""), items: [] };
    // Chat 11 is new and shown: its chips offer the other ten.
    await showChat("h", 11);
    const release = showChats("h", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await vi.waitFor(() => expect(texts("h", 10)).toEqual(["Task 10"]));
    const chips = () => {
      const chats = Object.fromEntries(terms.map((t) => [t.id, useChat.getState().chats[chatKey("h", t.id)]]));
      return newChatContext(terms, chats, { session: "s1", self: 11, cwd: "/Users/jane/code/app" }).transcripts.map((c) => c.title);
    };
    expect(chips()).toEqual(["Task 10", "Task 9", "Task 8", "Task 7", "Task 6", "Task 5", "Task 4", "Task 3", "Task 2", "Task 1"]);
    // Clicked, the first chip still has its transcript.
    expect(texts("h", 1)).toEqual(["Task 1"]);
    // The chips do not count among the last 8 shown: the new chat stays
    // among them, and off screen they drop their items.
    release();
    for (let id = 1; id <= 10; id++) expect(texts("h", id)).toBeUndefined();
    expect(texts("h", 11)).toEqual([]);
  });

  it("keeps the items of a chat on screen that falls out of the last 8 shown while it loads", async () => {
    let answer = (_st: ChatState) => {};
    daemon["j:1"] = new Promise<ChatState>((r) => (answer = r));
    const release = holdChat("j", 1);
    const loading = showChat("j", 1);
    // Eight other chats are shown before its `chat.state` answers.
    for (let id = 2; id <= 9; id++) {
      daemon[`j:${id}`] = chat(`chat ${id}`);
      await showChat("j", id);
    }
    answer(chat("the visible chat"));
    await loading;
    expect(texts("j", 1)).toEqual(["the visible chat"]);
    release();
  });

  it("knows whether a chat in memory has the item a jump goes to, rendered or not", async () => {
    daemon["k:1"] = chat("Comment 3 on the login page");
    const isPin = (item: ChatItem) => item.text.startsWith("Comment 3");
    expect(chatHasItem("k", 1, isPin)).toBe(false);
    await showChat("k", 1);
    expect(chatHasItem("k", 1, isPin)).toBe(true);
    expect(chatHasItem("k", 1, (item) => item.text.startsWith("Comment 4"))).toBe(false);
  });

  it("keeps a chat two views show until both let it go", async () => {
    daemon["g:1"] = chat("in a pane and in the Plan tab");
    const pane = holdChat("g", 1);
    const plan = holdChat("g", 1);
    await showChat("g", 1);
    for (let id = 2; id <= 9; id++) {
      daemon[`g:${id}`] = chat(`chat ${id}`);
      await showChat("g", id);
    }
    pane();
    expect(texts("g", 1)).toEqual(["in a pane and in the Plan tab"]);
    plan();
    expect(texts("g", 1)).toBeUndefined();
  });
});
