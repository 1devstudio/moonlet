import { describe, expect, it } from "vitest";
import type { CheckRun, PrStack } from "@desktop/lib/protocol";
import { checkMark, checkNote, checksDot, checksSummary, fixPrompt, reviewText, stackedOn, startsDraft, updatedAgo } from "./checks";

// Shapes as `gh pr view --json statusCheckRollup` reports them.
const run = (name: string, status: string, conclusion: string | null): CheckRun => ({ name, status, conclusion, url: `https://github.com/acme/storefront/actions/runs/1/${name}` });
const CHECKS = [run("ci / test", "completed", "failure"), run("ci / lint", "completed", "success"), run("ci / build", "in_progress", null), run("preview", "completed", "skipped")];

describe("checks", () => {
  it("marks each check", () => {
    expect(CHECKS.map(checkMark)).toEqual(["error", "ok", "running", "ok"]);
    expect(CHECKS.map(checkNote)).toEqual(["failed", "passed", "running", "skipped"]);
  });

  it("sums them up: failures first, then what runs", () => {
    expect(checksSummary(CHECKS)).toBe("1 failing");
    expect(checksSummary(CHECKS.slice(1))).toBe("1 running");
    expect(checksSummary([CHECKS[1], CHECKS[3]])).toBe("all passing");
    expect(checksSummary([])).toBe("no checks");
  });

  it("gives the PR tab's dot the worst check's state", () => {
    expect(checksDot(CHECKS)).toBe("error");
    expect(checksDot(CHECKS.slice(1))).toBe("running");
    expect(checksDot([CHECKS[1]])).toBe("ok");
    expect(checksDot([])).toBeNull();
  });
});

describe("reviewText", () => {
  it("names GitHub's review decision", () => {
    expect(reviewText("REVIEW_REQUIRED")).toBe("Review required");
    expect(reviewText("APPROVED")).toBe("Approved");
    expect(reviewText("CHANGES_REQUESTED")).toBe("Changes requested");
    expect(reviewText(null)).toBeNull();
  });
});

describe("stackedOn", () => {
  it("is the PR under this one in its stack", () => {
    const stack: PrStack = {
      number: 147,
      base: "main",
      position: 2,
      size: 2,
      prs: [
        { number: 141, title: "Search API endpoint", url: "u", state: "MERGED", draft: false, branch: "moonlet/search-api" },
        { number: 147, title: "Add product search", url: "u", state: "OPEN", draft: false, branch: "moonlet/add-search" },
      ],
    };
    expect(stackedOn(stack, 147)).toBe("#141 Search API endpoint · merged");
    expect(stackedOn(stack, 141)).toBeNull();
    expect(stackedOn(null, 147)).toBeNull();
  });
});

describe("fixPrompt", () => {
  it("asks the agent to fix a failing check, with its link", () => {
    expect(fixPrompt(CHECKS[0], 147)).toBe(
      "The ci / test check fails on PR #147 (https://github.com/acme/storefront/actions/runs/1/ci / test). Find out why with gh and fix it.",
    );
  });
});

describe("updatedAgo", () => {
  it("says how fresh the checks are", () => {
    expect(updatedAgo(1_000, 21_000)).toBe("updated 20s ago");
    expect(updatedAgo(1_000, 1_500)).toBe("updated just now");
    expect(updatedAgo(0, 125_000)).toBe("updated 2 min ago");
  });
});

describe("startsDraft", () => {
  it("starts the Create PR form as the host's Draft pull requests setting says (X55)", () => {
    expect(startsDraft({ draft_prs: true })).toBe(true);
    expect(startsDraft({ draft_prs: false })).toBe(false);
    // A daemon too old for Git settings: the default, not a draft.
    expect(startsDraft(null)).toBe(false);
  });
});
