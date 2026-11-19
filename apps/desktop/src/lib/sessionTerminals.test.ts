import { describe, expect, it, vi } from "vitest";
import { sessionTerminals } from "./store";
import type { TerminalInfo } from "./protocol";

vi.mock("./daemon", () => ({ rpc: vi.fn(), sendInput: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: () => Promise.resolve() }) }));

const term = (id: number, session_id: string) => ({ id, session_id, kind: "shell" }) as unknown as TerminalInfo;

describe("a session's terminals", () => {
  it("are the session's own, in id order", () => {
    const s = { terminals: { local: { 9: term(9, "a"), 3: term(3, "b"), 4: term(4, "a"), 1: term(1, "a") } } };
    expect(sessionTerminals(s, "local", "a").map((t) => t.id)).toEqual([1, 4, 9]);
    expect(sessionTerminals(s, "local", "b").map((t) => t.id)).toEqual([3]);
    expect(sessionTerminals(s, "local", "none")).toEqual([]);
    expect(sessionTerminals(s, "devbox", "a")).toEqual([]);
  });

  // Every sidebar row asks for its session's terminals on every state change
  // (the app froze at start with 105 rows): the same terminals give the same
  // list, not a new scan.
  it("come back as the same list while the host's terminals are unchanged", () => {
    const local = { 3: term(3, "a"), 4: term(4, "b") };
    const s = { terminals: { local } };
    const first = sessionTerminals(s, "local", "a");
    expect(sessionTerminals({ terminals: { local } }, "local", "a")).toBe(first);
    const changed = { terminals: { local: { ...local, 5: term(5, "a") } } };
    expect(sessionTerminals(changed, "local", "a").map((t) => t.id)).toEqual([3, 5]);
  });
});
