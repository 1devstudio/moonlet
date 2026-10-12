import { describe, expect, it } from "vitest";
import { afterClaudeCheck, afterClaudeUpdateExit, afterClaudeUpdateLine, claudeBanner, claudeOffer, claudeStatus, closeClaudeBanner } from "./claudeUpdate";
import type { ClaudeUpdateStep } from "./claudeUpdate";

const IDLE = { phase: "idle" } as const;

describe("afterClaudeCheck", () => {
  it("offers a newer release", () => {
    expect(afterClaudeCheck(IDLE, { installed: "2.1.292", latest: "2.1.296" }, null)).toEqual({ phase: "available", installed: "2.1.292", latest: "2.1.296" });
  });

  it("compares number by number: 2.1.10 is newer than 2.1.9", () => {
    expect(afterClaudeCheck(IDLE, { installed: "2.1.9", latest: "2.1.10" }, null)).toEqual({ phase: "available", installed: "2.1.9", latest: "2.1.10" });
  });

  it("shows nothing when the release is the same, older or unknown", () => {
    expect(afterClaudeCheck(IDLE, { installed: "2.1.296", latest: "2.1.296" }, null)).toEqual(IDLE);
    expect(afterClaudeCheck(IDLE, { installed: "2.1.296", latest: "2.1.290" }, null)).toEqual(IDLE);
    expect(afterClaudeCheck(IDLE, { installed: null, latest: "2.1.296" }, null)).toEqual(IDLE);
    expect(afterClaudeCheck(IDLE, { installed: "2.1.292", latest: null }, null)).toEqual(IDLE);
  });

  it("hides the release the user said Later to, and shows a newer one", () => {
    expect(afterClaudeCheck(IDLE, { installed: "2.1.292", latest: "2.1.296" }, "2.1.296")).toEqual(IDLE);
    expect(afterClaudeCheck(IDLE, { installed: "2.1.292", latest: "2.1.297" }, "2.1.296")).toEqual({ phase: "available", installed: "2.1.292", latest: "2.1.297" });
  });

  it("keeps a result on screen until the user closes it", () => {
    const failed = { phase: "failed", installed: "2.1.292", latest: "2.1.296", step: "install", message: "To update, run:\n  brew upgrade claude-code" } as const;
    expect(afterClaudeCheck(failed, { installed: "2.1.292", latest: "2.1.296" }, null)).toEqual(failed);
    // A check that began before the update finished still reads 2.1.292.
    expect(afterClaudeCheck({ phase: "updated", version: "2.1.296" }, { installed: "2.1.292", latest: "2.1.296" }, null)).toEqual({ phase: "updated", version: "2.1.296" });
    expect(afterClaudeCheck({ phase: "current", version: "2.1.292" }, { installed: "2.1.292", latest: null }, null)).toEqual({ phase: "current", version: "2.1.292" });
  });

  it("follows an update the daemon is already running, as after a reload", () => {
    expect(afterClaudeCheck(IDLE, { installed: "2.1.292", latest: "2.1.296", updating: true }, null)).toEqual({ phase: "updating", installed: "2.1.292", latest: "2.1.296", step: "check" });
  });

  it("leaves a running update alone", () => {
    const updating = { phase: "updating", installed: "2.1.292", latest: "2.1.296", step: "install" } as const;
    expect(afterClaudeCheck(updating, { installed: "2.1.292", latest: "2.1.297" }, null)).toEqual(updating);
  });
});

describe("afterClaudeUpdateLine", () => {
  const updating = (step: ClaudeUpdateStep) => ({ phase: "updating", installed: "2.1.292", latest: "2.1.296", step }) as const;

  it("moves to Download and install when claude update finds the release", () => {
    // The lines `claude update` 2.1.296 prints, from its update command.
    expect(afterClaudeUpdateLine(updating("check"), "Checking for updates to latest version...")).toEqual(updating("check"));
    // Native install.
    expect(afterClaudeUpdateLine(updating("check"), "Updating to 2.1.296...")).toEqual(updating("install"));
    // npm install.
    expect(afterClaudeUpdateLine(updating("check"), "New version available: 2.1.296 (current: 2.1.292)")).toEqual(updating("install"));
    expect(afterClaudeUpdateLine(updating("check"), "Installing update...")).toEqual(updating("install"));
  });
});

describe("afterClaudeUpdateExit", () => {
  const updating = { phase: "updating", installed: "2.1.292", latest: "2.1.296", step: "install" } as const;
  // Output of `claude update` 2.1.296, line by line as its update command
  // writes it; the up-to-date case was captured from a real run.
  const run = (...lines: string[]) => ["Current version: 2.1.292", "Checking for updates to latest version...", ...lines].join("\n") + "\n";

  it("finishes on the version claude update installed", () => {
    expect(afterClaudeUpdateExit(updating, { ok: true, output: run("Updating to 2.1.296...", "Successfully updated from 2.1.292 to version 2.1.296") })).toEqual({
      state: { phase: "updated", version: "2.1.296" },
      dismiss: null,
    });
  });

  it("is up to date when the user's channel is behind latest, and hides that release", () => {
    expect(afterClaudeUpdateExit(updating, { ok: true, output: "Current version: 2.1.292\nChecking for updates to stable version...\nClaude Code is up to date (2.1.292)\n" })).toEqual({
      state: { phase: "current", version: "2.1.292" },
      dismiss: "2.1.296",
    });
  });

  it("fails with what claude update said when a package manager owns Claude", () => {
    const output = run("", "Claude is managed by Homebrew.", "Update available: 2.1.292 \u2192 2.1.296", "", "To update, run:", "  brew upgrade claude-code");
    expect(afterClaudeUpdateExit(updating, { ok: true, output })).toEqual({
      state: { ...updating, phase: "failed", message: "Claude is managed by Homebrew.\nUpdate available: 2.1.292 \u2192 2.1.296\nTo update, run:\n  brew upgrade claude-code" },
      dismiss: null,
    });
  });

  it("fails when another Claude holds the update lock, even though it exits with 0", () => {
    const output = run("Updating to 2.1.296...", "\u001b[33mAnother Claude process (PID 4242) is currently running. Please try again in a moment.\u001b[39m");
    expect(afterClaudeUpdateExit(updating, { ok: true, output })).toEqual({
      state: { ...updating, phase: "failed", message: "Updating to 2.1.296...\nAnother Claude process (PID 4242) is currently running. Please try again in a moment." },
      dismiss: null,
    });
  });

  it("says claude update failed when it printed nothing useful", () => {
    expect(afterClaudeUpdateExit(updating, { ok: false, output: "" })).toEqual({ state: { ...updating, phase: "failed", message: "claude update failed" }, dismiss: null });
  });

  it("fails with the error when the daemon could not run it", () => {
    expect(afterClaudeUpdateExit(updating, { error: "Claude Code is already updating" })).toEqual({
      state: { ...updating, phase: "failed", message: "Claude Code is already updating" },
      dismiss: null,
    });
  });
});

describe("claudeBanner", () => {
  it("shows nothing while there is nothing to update", () => {
    expect(claudeBanner(IDLE)).toBeNull();
  });

  it("announces a release with Later and Update", () => {
    expect(claudeBanner({ phase: "available", installed: "2.1.292", latest: "2.1.296" })).toEqual({
      tone: "info",
      title: "Claude Code 2.1.296 is available",
      detail: "You have 2.1.292",
      steps: null,
      buttons: [
        { label: "Later", action: "later" },
        { label: "Update", action: "update" },
      ],
      closable: false,
    });
  });

  it("lists the steps while updating, the current one active", () => {
    const steps = (check: string, install: string) => [
      { label: "Check for updates", state: check },
      { label: "Download and install", state: install },
      { label: "Done", state: "todo" },
    ];
    expect(claudeBanner({ phase: "updating", installed: "2.1.292", latest: "2.1.296", step: "check" })).toEqual({
      tone: "progress",
      title: "Updating Claude Code",
      detail: "2.1.292 \u2192 2.1.296",
      steps: steps("active", "todo"),
      buttons: [],
      closable: false,
    });
    expect(claudeBanner({ phase: "updating", installed: "2.1.292", latest: "2.1.296", step: "install" })?.steps).toEqual(steps("done", "active"));
  });

  it("says which version new agents start on", () => {
    expect(claudeBanner({ phase: "updated", version: "2.1.296" })).toEqual({
      tone: "success",
      title: "Claude Code updated to 2.1.296",
      detail: "New agents start on 2.1.296.",
      steps: null,
      buttons: [],
      closable: true,
    });
  });

  it("says the installed version is up to date", () => {
    expect(claudeBanner({ phase: "current", version: "2.1.292" })).toEqual({
      tone: "success",
      title: "Claude Code 2.1.292 is up to date",
      detail: "",
      steps: null,
      buttons: [],
      closable: true,
    });
  });

  it("shows what went wrong with Retry", () => {
    expect(claudeBanner({ phase: "failed", installed: "2.1.292", latest: "2.1.296", step: "install", message: "To update, run:\n  brew upgrade claude-code" })).toEqual({
      tone: "error",
      title: "Claude Code update failed",
      detail: "To update, run:\n  brew upgrade claude-code",
      steps: null,
      buttons: [{ label: "Retry", action: "update" }],
      closable: true,
    });
  });
});

describe("claudeStatus", () => {
  const v = { installed: "2.1.292", latest: "2.1.296" };

  it("says a check is running", () => {
    expect(claudeStatus(IDLE, v, true)).toBe("Checking…");
  });

  it("names the newer release, or that an update runs", () => {
    expect(claudeStatus({ phase: "available", ...v }, v, false)).toBe("2.1.296 is available");
    expect(claudeStatus({ phase: "updating", ...v, step: "check" }, v, false)).toBe("Updating…");
  });

  it("is up to date when nothing newer is out, and quiet when it cannot tell", () => {
    expect(claudeStatus(IDLE, { installed: "2.1.296", latest: "2.1.296" }, false)).toBe("Up to date");
    expect(claudeStatus(IDLE, { installed: "2.1.296", latest: null }, false)).toBeNull();
  });

  it("says Claude Code was not found once a check could not run it", () => {
    expect(claudeStatus(IDLE, { installed: null, latest: "2.1.296" }, false)).toBe("Not found on the PATH");
  });
});

describe("closeClaudeBanner", () => {
  const available = { phase: "available", installed: "2.1.292", latest: "2.1.296" } as const;

  it("hides the release for good when the user says Later", () => {
    expect(closeClaudeBanner(available, "later")).toEqual({ state: IDLE, dismiss: "2.1.296" });
  });

  it("only closes a failure, so the release comes back at the next check", () => {
    const failed = { ...available, phase: "failed", step: "install", message: "Another Claude process (PID 4242) is currently running. Please try again in a moment." } as const;
    expect(closeClaudeBanner(failed, "close")).toEqual({ state: IDLE, dismiss: null });
    expect(closeClaudeBanner({ phase: "updated", version: "2.1.296" }, "close")).toEqual({ state: IDLE, dismiss: null });
  });
});

describe("claudeOffer", () => {
  const v = { installed: "2.1.292", latest: "2.1.296" };

  it("offers the newer release in Settings, even one the user said Later to", () => {
    expect(claudeOffer(IDLE, v)).toBe("2.1.296");
  });

  it("offers nothing while updating, or when nothing newer is known", () => {
    expect(claudeOffer({ phase: "updating", ...v, step: "install" }, v)).toBeNull();
    expect(claudeOffer(IDLE, { installed: "2.1.296", latest: "2.1.296" })).toBeNull();
    expect(claudeOffer(IDLE, { installed: null, latest: "2.1.296" })).toBeNull();
  });
});
