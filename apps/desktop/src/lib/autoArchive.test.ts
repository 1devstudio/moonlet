import { describe, expect, it } from "vitest";
import { archivedReason, autoArchiveNote, autoArchivedNow } from "./autoArchive";
import type { Session } from "./protocol";

const session = (id: string, over: Partial<Session> = {}) =>
  ({ id, project_id: "p", name: `Session ${id}`, branch: "b", base: "main", path: "/w", agent: null, archived: false, created_at: 1, terminals: [], layout: null, ...over }) as Session;

describe("a session archived when its PR merged (X116)", () => {
  it("says on the merged icon why a merged session is still here", () => {
    expect(autoArchiveNote({ pr: 12, state: "waiting", reason: "archives when the agent is done", merged: true }, "This Mac")).toEqual({
      text: "PR merged · archives when the agent is done",
      warn: false,
    });
    expect(autoArchiveNote({ pr: 12, state: "refused", reason: "1 uncommitted file", merged: true }, "This Mac")).toEqual({
      text: "PR merged · not archived: work only on This Mac (1 uncommitted file)",
      warn: true,
    });
    expect(autoArchiveNote({ pr: 12, state: "failed", reason: "worktree is locked", merged: false }, "devbox")).toEqual({
      text: "PR closed · could not archive: worktree is locked",
      warn: true,
    });
    expect(autoArchiveNote({ pr: 12, state: "restored", merged: true }, "This Mac")).toBeNull();
    expect(autoArchiveNote(undefined, "This Mac")).toBeNull();
  });

  it("says in the Archived list which PR archived it", () => {
    expect(archivedReason({ pr: 12, state: "archived", merged: true })).toBe("Archived when #12 merged");
    expect(archivedReason({ pr: 7, state: "archived", merged: false })).toBe("Archived when #7 was closed");
    expect(archivedReason({ pr: 12, state: "restored", merged: true })).toBeNull();
    expect(archivedReason(null)).toBeNull();
  });

  it("finds the sessions the host just archived, for a toast", () => {
    const merged = { pr: 12, state: "archived" as const, merged: true };
    const before = [session("a"), session("b"), session("c", { archived: true, auto_archive: merged })];
    const after = [session("a", { archived: true, auto_archive: merged }), session("b", { archived: true }), session("c", { archived: true, auto_archive: merged })];
    expect(autoArchivedNow(before, after).map((s) => s.id)).toEqual(["a"]);
  });
});
