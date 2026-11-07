import { describe, expect, it } from "vitest";
import { archivedCount, archivedSummary, historyNote, keptTabs } from "./archivedSession";
import { DaemonError } from "./daemon";

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

  it("says when it kept no chat, when the host's moonlet is too old to say, and why else it could not", () => {
    expect([
      historyNote({ chats: [] }),
      historyNote({ chats: [{ id: 1, title: "Claude", agent: "claude", items: [] }] }),
      historyNote(new DaemonError({ code: "unknown_method", message: "unknown method session.history" })),
      historyNote(new DaemonError({ code: "internal", message: "no such session" })),
    ]).toEqual([
      "No chat transcripts were kept for this session.",
      null,
      "This host's moonlet cannot show this session's transcripts. Update it, or Restore the session.",
      "Couldn't read this session's transcripts: no such session",
    ]);
  });

  it("names the tabs Restore starts again: an agent's goes on with its conversation", () => {
    expect(
      keptTabs([
        { kind: "agent", title: "claude", agent: "claude" },
        { kind: "shell", title: "zsh", agent: null },
      ]),
    ).toEqual(["claude: its conversation continues", "zsh: starts again"]);
    expect([keptTabs(undefined), keptTabs([])]).toEqual([[], []]);
  });

  it("says a PR whose state it no longer knows by its number", () => {
    const s = { branch: "carts", created_at: now - DAY, archived_at: null };
    expect(archivedSummary(s, { project: "web", task: null, pr: { number: 131, state: "" }, now }).pr).toBe("#131");
  });
});

describe("archived sessions on a task (X86)", () => {
  it("counts them for the folded line", () => {
    expect([archivedCount(0), archivedCount(1), archivedCount(3)]).toEqual([null, "1 archived", "3 archived"]);
  });
});
