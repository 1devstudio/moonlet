import { describe, expect, it } from "vitest";
import { cantReach, copyCheck, foundLine, getProjectTitle, isTooOld, noOrigin, originName } from "./getProject";

const ledger = { origin: "gitlab.com/acme/ledger", root: "41f5b5f0a1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6" };

describe("getProjectTitle (X70)", () => {
  it("names the project and the host it is got on", () => {
    expect(getProjectTitle("ledger", "This Mac")).toBe("Get ledger on This Mac");
    expect(getProjectTitle("ledger", "studio-mini")).toBe("Get ledger on studio-mini");
  });
});

describe("originName (X70)", () => {
  it("starts the folder name as the origin's last path segment", () => {
    expect(originName("gitlab.com/group/sub/ledger")).toBe("ledger");
    expect(originName("git.example.com:2222/acme/shop")).toBe("shop");
  });
});

describe("foundLine (X70)", () => {
  it("says found, with the default branch when git gave one", () => {
    expect(foundLine({ default_branch: "main" })).toBe("Found · main");
    expect(foundLine({ default_branch: null })).toBe("Found");
  });
});

describe("cantReach (X70)", () => {
  it("names both addresses tried and why each failed", () => {
    const error =
      "git@gitlab.com:acme/ledger.git: git@gitlab.com: Permission denied (publickey).\nhttps://gitlab.com/acme/ledger.git: could not read Username for 'https://gitlab.com': terminal prompts disabled";
    expect(cantReach("This Mac", "gitlab.com/acme/ledger", error)).toEqual({
      title: "This Mac can't reach gitlab.com/acme/ledger",
      body: "This Mac tried git@gitlab.com:acme/ledger.git and https://gitlab.com/acme/ledger.git. Check that this Mac can read the repository, with an SSH key or a signed-in credential helper, then retry.",
      details: [
        "git@gitlab.com:acme/ledger.git: git@gitlab.com: Permission denied (publickey).",
        "https://gitlab.com/acme/ledger.git: could not read Username for 'https://gitlab.com': terminal prompts disabled",
      ],
    });
  });

  it("says what the daemon said when it tried no address", () => {
    expect(cantReach("studio-mini", "github.com/../etc", "not a project origin: github.com/../etc")).toEqual({
      title: "studio-mini can't reach github.com/../etc",
      body: "Check that studio-mini can read the repository, with an SSH key or a signed-in credential helper, then retry.",
      details: ["not a project origin: github.com/../etc"],
    });
  });
});

describe("noOrigin (X70)", () => {
  it("says a project without a remote can only be located", () => {
    expect(noOrigin("scratch", "This Mac")).toBe("scratch has no remote, so This Mac can't clone it. Push it to a remote from the Mac that has it, or locate a copy here.");
  });
});

describe("copyCheck (X70)", () => {
  it("accepts a folder of the same project, in green", () => {
    expect(copyCheck(ledger, ledger, "~/work/ledger", "ledger")).toEqual({ ok: true, text: "This is a clone of gitlab.com/acme/ledger." });
    const scratch = { origin: null, root: ledger.root };
    expect(copyCheck(scratch, scratch, "~/work/scratch", "scratch")).toEqual({ ok: true, text: "This is a copy of scratch." });
  });

  it("says why any other folder is not a copy", () => {
    expect(copyCheck({ origin: null, root: null }, ledger, "~/Downloads", "ledger")).toEqual({ ok: false, text: "~/Downloads is not a git repository." });
    expect(copyCheck({ ...ledger, root: "d58b70923e9f8c1a2b3c4d5e6f708192a3b4c5d6" }, ledger, "~/work/shop", "ledger")).toEqual({
      ok: false,
      text: "~/work/shop holds another repository.",
    });
    expect(copyCheck({ ...ledger, origin: "github.com/sam/ledger" }, ledger, "~/fork", "ledger")).toEqual({
      ok: false,
      text: "~/fork has the same history but its origin is github.com/sam/ledger, not gitlab.com/acme/ledger.",
    });
    expect(copyCheck({ ...ledger, origin: null }, ledger, "~/copy", "ledger")).toEqual({
      ok: false,
      text: "~/copy has the same history but no origin; the project's is gitlab.com/acme/ledger.",
    });
  });
});

describe("isTooOld (X70)", () => {
  it("reads a daemon that wants a repository as one from before X70", () => {
    expect(isTooOld({ code: "invalid_params", message: "missing field `repo`" })).toBe(true);
    expect(isTooOld({ code: "internal", message: "not a project origin: x" })).toBe(false);
  });
});
