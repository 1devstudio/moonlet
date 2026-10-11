import { describe, expect, it } from "vitest";
import { footerLabel, profileChangeConfirm, profileName, profileOptions, tildePath } from "./profiles";
import type { ProfileInfo, Workspace } from "./protocol";

const work: ProfileInfo = { id: "pw", name: "Work profile", path: "/Users/jane/.claude-work", created_at: 0, account: null, hooks_installed: true };
const ws = (claude_profile: string | null): Workspace => ({ id: "w", name: "CipherHealth", color: "blue", section_ids: [], claude_profile, created_at: 0 });

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
    expect(footerLabel(ws(null), [work], null)).toEqual({ text: "Claude · Default", warn: false, title: "~/.claude" });
    expect(footerLabel(ws("pw"), [work], "/Users/jane")).toEqual({ text: "Claude · Work profile", warn: false, title: "~/.claude-work" });
    const signedIn = { ...work, account: { logged_in: true, email: "jane@cipherhealth.com", org_name: "CipherHealth", subscription: "team" } };
    expect(footerLabel(ws("pw"), [signedIn], "/Users/jane")).toEqual({ text: "Claude · Work profile", warn: false, title: "jane@cipherhealth.com · CipherHealth · ~/.claude-work" });
    const signedOut = { ...work, account: { logged_in: false, email: null, org_name: null, subscription: null } };
    expect(footerLabel(ws("pw"), [signedOut], "/Users/jane")).toEqual({ text: "Claude · Work profile · not signed in", warn: true, title: "~/.claude-work" });
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
