import { describe, expect, it } from "vitest";
import { connectionLine, githubConnection, trackerRules } from "./trackersPage";

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

describe("Linear, Jira and ClickUp connections (X44)", () => {
  const conn = { id: "jira:acme.atlassian.net", kind: "jira" as const, site: "acme.atlassian.net", account: "Mia Krystof", auth: "token", sources: [{ key: "OPS", name: "Operations", project: "p1", workspace: "local/acme" }] };

  it("says who each connection is signed in as, or what to do", () => {
    expect(connectionLine(conn, undefined)).toEqual({ tone: "done", text: "Connected as Mia Krystof · API token · 1 source" });
    expect(connectionLine({ ...conn, sources: [] }, undefined)).toEqual({ tone: "blocked", text: "Connected as Mia Krystof · API token · pick what to show" });
    expect(connectionLine(conn, "Jira no longer accepts the API token for acme.atlassian.net.")).toEqual({ tone: "error", text: "Jira no longer accepts the API token for acme.atlassian.net." });
  });

  it("words the rules for the tracker", () => {
    expect(trackerRules("linear").map((r) => `${r.when} → ${r.then}`)).toEqual([
      "A session starts from an issue → move it to In Progress and assign it to me",
      "A pull request opens → move the issue to In Review",
      "Every session's PR is merged → move the issue to Done",
      "A pull request opens → comment on the issue with its link",
      "The issue moves to Done → archive its sessions and remove their worktrees",
    ]);
    expect(trackerRules("clickup")[0].when).toBe("A session starts from a task");
  });
});
