import { describe, expect, it } from "vitest";
import { addEntry, needSignIn, nextRun, runExit, runHost, runTitle, runningLine, stateMark } from "./signIns";

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

describe("another member's sign-in, from this Mac's Sign in on every member (X75)", () => {
  // `signins.running` as a MacBook's daemon sends it for build-box's
  // sign-in, through the central host studio-mini.
  const boxRun = { terminal: 3, name: "gh", member: "5b2e8d4f-6a1c-4f3e-b7d9-0e2a4c6f8b15", member_name: "build-box", relayed: true };

  it("follows its terminal through the central host, or on the central host itself", () => {
    expect(runHost({ terminal: 3, name: "gh" }, "studio-mini", ["studio-mini"])).toBe("local");
    expect(runHost(boxRun, "studio-mini", ["studio-mini"])).toBe("studio-mini#signin:5b2e8d4f-6a1c-4f3e-b7d9-0e2a4c6f8b15");
    expect(runHost({ ...boxRun, relayed: false }, "studio-mini", ["studio-mini"])).toBe("studio-mini");
    // This Mac is the central host: through its own daemon.
    expect(runHost(boxRun, null, [])).toBe("local#signin:5b2e8d4f-6a1c-4f3e-b7d9-0e2a4c6f8b15");
    // The app does not reach the central host: nothing to follow.
    expect(runHost(boxRun, "studio-mini", [])).toBeNull();
  });

  it("names the member in the window's title", () => {
    expect(runTitle(boxRun)).toBe("Sign in: gh on build-box");
    expect(runTitle({ terminal: 3, name: "gh" })).toBe("Sign in: gh");
  });

  it("ends with the exit its daemon reports, as its terminal's exit never comes here", () => {
    const shown = nextRun(null, boxRun);
    expect(runExit(shown!, undefined)).toBeUndefined();
    const ended = nextRun(shown, { ...boxRun, exit: { code: 0, signal: null } });
    expect(runExit(ended!, undefined)).toEqual({ code: 0, signal: null });
    // The end of another sign-in leaves this one as it is.
    expect(nextRun(shown, { ...boxRun, terminal: 9, exit: { code: 1, signal: null } })).toEqual(boxRun);
    // This Mac's own sign-in ends with its terminal.
    expect(runExit({ terminal: 3, name: "gh" }, { code: 1, signal: null })).toEqual({ code: 1, signal: null });
  });
});
