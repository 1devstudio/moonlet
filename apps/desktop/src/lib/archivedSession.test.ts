import { describe, expect, it } from "vitest";
import { archivedCount, archivedSummary, historyNote } from "./archivedSession";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = 1_800_000_000_000;

describe("an archived session's page (X86)", () => {
  it("says its task, where it worked, its PR and when it was created and archived", () => {
    const s = { branch: "moon-142-hosts", created_at: now - 3 * DAY, archived_at: now - 2 * HOUR };
    expect(
      archivedSummary(s, {
        project: "web",
        task: { key: "MOON-142", title: "Remote hosts sidebar" },
        pr: { number: 131, state: "merged" },
        now,
      }),
    ).toEqual({
      task: "MOON-142 Remote hosts sidebar",
      where: "web/moon-142-hosts",
      pr: "#131 merged",
      when: "Created 3 days ago · archived 2 h ago",
    });
  });

  it("leaves out what it does not know, as for a session archived before X86", () => {
    const s = { branch: "spike", created_at: now - DAY, archived_at: null };
    expect(archivedSummary(s, { project: undefined, task: null, pr: null, now })).toEqual({
      task: null,
      where: "spike",
      pr: null,
      when: "Created 1 day ago",
    });
  });

  it("says when it kept no chat, or the daemon cannot say", () => {
    expect([historyNote({ chats: [] }), historyNote({ chats: [{ id: 1, title: "Claude", agent: "claude", items: [] }] }), historyNote(new Error("unknown method"))]).toEqual([
      "No chat transcripts were kept for this session.",
      null,
      "This host's moonlet cannot show this session's transcripts. Update it, or Restore the session.",
    ]);
  });
});

describe("archived sessions on a task (X86)", () => {
  it("counts them for the folded line", () => {
    expect([archivedCount(0), archivedCount(1), archivedCount(3)]).toEqual([null, "1 archived", "3 archived"]);
  });
});
