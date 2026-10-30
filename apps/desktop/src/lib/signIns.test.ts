import { describe, expect, it } from "vitest";
import { addEntry, needSignIn, runningLine, stateMark } from "./signIns";

const states = [
  { member: "book", name: "MacBook", state: "signed_in" },
  { member: "mini", name: "studio-mini", state: "signed_out" },
  { member: "linux", name: "build-box", state: "needs_approval" },
  { member: "air", name: "MacBook Air", state: "away" },
];

describe("Sign-ins (X75)", () => {
  it("the_sign_ins_list_shows_each_member_signed_in_or_not", () => {
    expect(states.map((s) => stateMark(s.state))).toEqual([
      { mark: "✓", label: "Signed in" },
      { mark: "✕", label: "Not signed in" },
      { mark: "?", label: "Approve its commands there first" },
      { mark: "–", label: "Away" },
    ]);
  });

  it("signs in on every member that is not signed in", () => {
    expect(needSignIn(states)).toEqual(["mini"]);
  });

  it("adds an entry with all three fields, or says what is missing", () => {
    expect(addEntry([], { name: " npm ", login: "npm login", check: "npm whoami" }, "id-1")).toEqual({
      entries: [{ id: "id-1", name: "npm", login: "npm login", check: "npm whoami" }],
    });
    expect(addEntry([], { name: "npm", login: "", check: "npm whoami" }, "id-1")).toEqual({ error: "A sign-in needs a name, a sign-in command and a check command." });
  });
});

describe("a sign-in running on this Mac (X75)", () => {
  it("says what to do while it runs, and why it stopped when it failed", () => {
    expect(runningLine(undefined)).toBe("Finish signing in in your browser. This window closes when the sign-in is done.");
    expect(runningLine({ code: 1 })).toBe("The sign-in stopped with exit code 1. Its output is below.");
    expect(runningLine({ code: 0 })).toBeNull();
  });
});
