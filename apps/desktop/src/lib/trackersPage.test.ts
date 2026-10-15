import { describe, expect, it } from "vitest";
import { githubConnection } from "./trackersPage";

describe("Settings › Task trackers: the GitHub connection (X44)", () => {
  it("says who gh is signed in as, or why it isn't", () => {
    expect(githubConnection("This Mac", undefined, null)).toEqual({ tone: "muted", text: "Checking gh on This Mac…" });
    expect(githubConnection("This Mac", "sam-rivera", null)).toEqual({ tone: "done", text: "Connected as sam-rivera · uses gh on This Mac" });
    expect(githubConnection("mac-mini", null, "gh api user --jq .login: To get started with GitHub CLI, please run:  gh auth login")).toEqual({
      tone: "error",
      text: "gh is not signed in on mac-mini · run gh auth login there",
    });
    expect(githubConnection("This Mac", null, "cannot run gh")).toEqual({ tone: "error", text: "gh is not installed on This Mac" });
    expect(githubConnection("This Mac", null, "HTTP 502")).toEqual({ tone: "error", text: "gh failed on This Mac: HTTP 502" });
  });
});
