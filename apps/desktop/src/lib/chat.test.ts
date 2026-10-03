import { describe, expect, it } from "vitest";
import { activeToken, diffStat, fuzzyFilter, mergeItem, transcript } from "./chat";
import type { ChatItem } from "./protocol";

const item = (id: string, text: string, kind: ChatItem["kind"] = "assistant"): ChatItem => ({ id, kind, text, ts: 0 });

describe("chat helpers", () => {
  it("merges streamed items in place", () => {
    const a = [item("a", "he"), item("b", "x")];
    const b = mergeItem(a, item("a", "hello"));
    expect(b.map((i) => i.text)).toEqual(["hello", "x"]);
    expect(mergeItem(b, item("c", "new")).length).toBe(3);
  });

  it("counts diff lines", () => {
    expect(diffStat("--- a\n+++ b\n@@\n-old\n+new\n+more\n")).toEqual({ add: 2, del: 1 });
  });

  it("finds @ and / tokens at the caret", () => {
    expect(activeToken("look at @src/ma", 15)).toEqual({ kind: "@", start: 8, query: "src/ma" });
    expect(activeToken("/rev", 4)).toEqual({ kind: "/", start: 0, query: "rev" });
    expect(activeToken("run /rev", 8)).toBeNull();
    expect(activeToken("email a@b", 9)).toBeNull();
  });

  it("ranks fuzzy file matches by name", () => {
    const files = ["docs/main.md", "src/main.rs", "src/lib/manager.rs"];
    expect(fuzzyFilter(files, "main")[0]).toBe("src/main.rs");
    expect(fuzzyFilter(files, "mgr")).toEqual(["src/lib/manager.rs"]);
  });

  it("writes a transcript without thinking", () => {
    const t = transcript([item("1", "hi", "user"), item("2", "secret", "thinking"), { ...item("3", "", "tool"), tool: { name: "Bash", summary: "ls", input: {}, status: "denied" } }, item("4", "done")]);
    expect(t).toBe("> hi\n\n[Bash] ls (denied)\n\ndone");
  });
});
