import { describe, expect, it } from "vitest";
import { accountLabel, switchConfirm, accountState, defaultFolder, footerLabel, movingSessions, profileChangeConfirm, profileName, profileOptions, removeProfileConfirm, runningClaudeAgents, signInFor, tildePath } from "./profiles";
import type { ChatItem, Section, Session, TerminalInfo } from "./protocol";
import type { ProfileInfo, Workspace } from "./protocol";

const work: ProfileInfo = { id: "pw", name: "Work profile", path: "/Users/jane/.claude-work", created_at: 0, account: null, hooks_installed: true };
const ws = (claude_profile: string | null): Workspace => ({ id: "w", name: "Acme", color: "blue", section_ids: [], claude_profile, created_at: 0 });

describe("tildePath", () => {
  it("shortens the home folder to ~", () => {
    expect(tildePath("/Users/jane/.claude-work", "/Users/jane")).toBe("~/.claude-work");
    expect(tildePath("/Volumes/x/claude", "/Users/jane")).toBe("/Volumes/x/claude");
    expect(tildePath("/Users/janet/x", "/Users/jane")).toBe("/Users/janet/x");
  });
});

describe("profileOptions", () => {
  it("offers the default, every profile and New profile…, as the design shows them", () => {
    expect(profileOptions([work], "/Users/jane")).toEqual([
      { value: "", label: "Default — ~/.claude" },
      { value: "pw", label: "Work profile — ~/.claude-work" },
      { value: "new", label: "New profile…" },
    ]);
  });
});

describe("footerLabel", () => {
  it("names the workspace's profile, and warns when it is not signed in", () => {
    expect(footerLabel(ws(null), [work], null, null)).toEqual({ text: "Claude · Default", warn: false, title: "~/.claude" });
    expect(footerLabel(ws(null), [work], null, { logged_in: false, email: null, org_name: null })).toEqual({ text: "Claude · Default · not signed in", warn: true, title: "~/.claude" });
    expect(footerLabel(ws("pw"), [work], "/Users/jane", null)).toEqual({ text: "Claude · Work profile", warn: false, title: "~/.claude-work" });
    const signedIn = { ...work, account: { logged_in: true, email: "jane@acme.example", org_name: "Acme" } };
    expect(footerLabel(ws("pw"), [signedIn], "/Users/jane", null)).toEqual({ text: "Claude · Work profile", warn: false, title: "jane@acme.example · Acme · ~/.claude-work" });
    const signedOut = { ...work, account: { logged_in: false, email: null, org_name: null } };
    expect(footerLabel(ws("pw"), [signedOut], "/Users/jane", null)).toEqual({ text: "Claude · Work profile · not signed in", warn: true, title: "~/.claude-work" });
  });

  it("names a deleted profile's workspace as on the default", () => {
    expect(profileName(ws("gone"), [work])).toBe("Default");
  });
});

describe("profileChangeConfirm", () => {
  it("asks only when sessions run agents, and says what happens to them", () => {
    expect(profileChangeConfirm(0, "Work profile")).toBeNull();
    expect(profileChangeConfirm(1, "Work profile")).toBe(
      "1 session in this workspace has an agent. A running agent keeps its account until it restarts, then signs in with Work profile and starts a new conversation.",
    );
    expect(profileChangeConfirm(3, "Default")).toBe(
      "3 sessions in this workspace have agents. A running agent keeps its account until it restarts, then signs in with Default and starts a new conversation.",
    );
  });
});

describe("account labels", () => {
  it("names who a profile is signed in as, and whether it is known yet", () => {
    expect(accountLabel({ logged_in: true, email: "jane@acme.example", org_name: "Acme" })).toBe("jane@acme.example · Acme");
    expect(accountLabel({ logged_in: true, email: null, org_name: null })).toBe("an account");
    expect(accountState(null)).toBe("checking");
    expect(accountState({ logged_in: false, email: null, org_name: null })).toBe("signed-out");
    expect(accountState({ logged_in: true, email: "j@x", org_name: null })).toBe("signed-in");
  });
});

describe("defaultFolder", () => {
  it("is the daemon's ~/.claude-<slug> for a new profile's name", () => {
    expect(defaultFolder("Work profile")).toBe("~/.claude-work-profile");
    expect(defaultFolder("Client: Acme!")).toBe("~/.claude-client-acme");
    expect(defaultFolder("***")).toBe("~/.claude-task");
  });
});

describe("removeProfileConfirm", () => {
  it("says which workspaces fall back to the default and that the folder stays", () => {
    const workspaces = [ws("pw"), { ...ws("pw"), id: "w2", name: "Lab" }, { ...ws(null), id: "w3", name: "Personal" }];
    expect(removeProfileConfirm(work, workspaces, "/Users/jane")).toBe("Forget Work profile? Acme, Lab will use the default profile. The folder ~/.claude-work and its sign-in stay on disk.");
    expect(removeProfileConfirm(work, [], "/Users/jane")).toBe("Forget Work profile? The folder ~/.claude-work and its sign-in stay on disk.");
  });
});

const session = (id: string, workspace_id: string, project_id = "p", archived = false): Session => ({ id, project_id, name: id, branch: "b", base: "main", path: "/w", agent: null, archived, created_at: 0, workspace_id, terminals: [], layout: null });
const term = (id: number, session_id: string, agent: string, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({ id, kind: "agent", title: agent, cwd: "/w", command: [], session_id, agent, agent_state: "idle", cols: 80, rows: 24, pid: 1, ...extra }) as TerminalInfo;

describe("runningClaudeAgents", () => {
  it("counts the sessions running a Claude agent, not Codex, custom agents, exited tabs or archived sessions", () => {
    const sessions = [session("a", "w"), session("b", "w"), session("c", "w"), session("d", "w", "p", true), session("e", "other")];
    const terminals = [term(1, "a", "claude"), term(2, "a", "claude"), term(3, "b", "codex"), term(4, "c", "claude", { exit: { code: 0, signal: null } }), term(5, "d", "claude"), term(6, "e", "claude")];
    expect(runningClaudeAgents(sessions, terminals, ["a", "b", "c", "d"])).toBe(1);
  });
});

describe("movingSessions", () => {
  it("is the workspace's sessions of the projects only the moving section holds there", () => {
    const sec = (id: string, project_ids: string[]): Section => ({ id, name: id, project_ids, view: { group_by: "project", sort_by: "recent", filter: [] }, created_at: 0 });
    const from = { ...ws(null), id: "w", section_ids: ["s1", "s2"] };
    const sections = [sec("s1", ["p", "q"]), sec("s2", ["q"])];
    const sessions = [session("a", "w", "p"), session("b", "w", "q"), session("c", "other", "p")];
    expect(movingSessions(from, sections, sessions, "s1")).toEqual(["a"]);
  });
});

describe("switchConfirm", () => {
  const profiles = [work];
  it("asks only when the profile differs and Claude agents run, naming the new profile", () => {
    expect(switchConfirm(null, "pw", 2, profiles)).toBe(profileChangeConfirm(2, "Work profile"));
    expect(switchConfirm("pw", null, 1, profiles)).toBe(profileChangeConfirm(1, "Default"));
    expect(switchConfirm("pw", "pw", 3, profiles)).toBeNull();
    expect(switchConfirm(null, "pw", 0, profiles)).toBeNull();
  });
});

describe("signInFor", () => {
  // The error item the daemon makes from Claude Code's failed login.
  const expired: ChatItem = { id: "error-1", kind: "error", text: "Failed to authenticate: OAuth session expired and could not be refreshed", ts: 0, error: "authentication_failed" };

  it("offers to sign in to the workspace's profile when the agent's login failed", () => {
    expect(signInFor(expired, ws("pw"), [work])).toEqual({ profile: work });
    expect(signInFor(expired, ws(null), [work])).toEqual({ profile: null });
    // A deleted profile reads as the default.
    expect(signInFor(expired, ws("gone"), [work])).toEqual({ profile: null });
  });

  it("offers nothing for other errors", () => {
    expect(signInFor({ id: "error-2", kind: "error", text: "The turn failed.", ts: 0 }, ws("pw"), [work])).toBeNull();
    expect(signInFor({ id: "m1:0", kind: "assistant", text: "Not logged in · Please run /login", ts: 0 }, ws("pw"), [work])).toBeNull();
  });
});
