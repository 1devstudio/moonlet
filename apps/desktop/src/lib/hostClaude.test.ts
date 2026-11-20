import { describe, expect, it } from "vitest";
import type { HostInfo } from "./protocol";
import { claudeHosts, hostClaudeLine, hostClaudeOffer, NOT_ASKED, recheckHostClaudeOnReconnect, type HostClaude } from "./hostClaude";

const host = (patch: Partial<HostInfo>): HostInfo => ({
  id: "studio-mini",
  label: "studio-mini",
  remote: true,
  kind: "tailnet",
  status: "connected",
  message: null,
  daemon_version: "0.2.0",
  hostname: null,
  home: null,
  ...patch,
});

describe("which hosts get a Claude Code row (X109)", () => {
  it("lists every connected remote host, tailnet or SSH, by label", () => {
    const hosts = [
      host({ id: "studio-mini", label: "studio-mini" }),
      host({ id: "local", label: "This Mac", remote: false, kind: "local" }),
      host({ id: "build-box", label: "build-box", kind: "ssh" }),
      host({ id: "attic", label: "attic", status: "reconnecting" }),
      host({ id: "old", label: "old", status: "needs_update" }),
    ];
    expect(claudeHosts(hosts).map((h) => h.id)).toEqual(["build-box", "studio-mini"]);
  });
});

const mini = host({});
const asked = (patch: Partial<HostClaude>): HostClaude => ({ ...NOT_ASKED, answered: true, installed: "2.1.292", ...patch });

describe("the Claude Code line of a host (X109)", () => {
  it("says what the host runs against npm's newest", () => {
    expect(hostClaudeLine(mini, { ...NOT_ASKED, checking: true }, "2.1.296")).toEqual({ tone: "muted", text: "Checking…" });
    expect(hostClaudeLine(mini, asked({}), "2.1.296")).toEqual({ tone: "accent", text: "2.1.296 is available" });
    expect(hostClaudeLine(mini, asked({ installed: "2.1.296" }), "2.1.296")).toEqual({ tone: "done", text: "Up to date" });
    expect(hostClaudeLine(mini, asked({ installed: null }), "2.1.296")).toEqual({ tone: "blocked", text: "Not found on the PATH" });
    expect(hostClaudeLine(mini, asked({ installed: null, unasked: true }), "2.1.296")).toEqual({ tone: "muted", text: "Could not ask studio-mini" });
    // Offline: npm did not answer, so only the version shows.
    expect(hostClaudeLine(mini, asked({}), null)).toBeNull();
  });

  it("says a host has no claude even when npm did not answer", () => {
    expect(hostClaudeLine(mini, asked({ installed: null }), null)).toEqual({ tone: "blocked", text: "Not found on the PATH" });
  });

  it("names the release an update elsewhere goes to once npm answers", () => {
    // Found running by a check made before npm answered: the release is unknown.
    const elsewhere = asked({ run: { phase: "updating", installed: "2.1.292", latest: "", step: "check" } });
    expect(hostClaudeLine(mini, elsewhere, null)).toEqual({ tone: "muted", text: "Updating…" });
    expect(hostClaudeLine(mini, elsewhere, "2.1.296")).toEqual({ tone: "muted", text: "Updating to 2.1.296…" });
  });

  it("follows an update to its end", () => {
    const run = { installed: "2.1.292", latest: "2.1.296" };
    expect(hostClaudeLine(mini, asked({ run: { phase: "updating", ...run, step: "check" } }), "2.1.296")).toEqual({ tone: "muted", text: "Updating to 2.1.296…" });
    expect(hostClaudeLine(mini, asked({ run: { phase: "updating", ...run, step: "install" } }), "2.1.296")).toEqual({ tone: "muted", text: "Installing 2.1.296…" });
    expect(hostClaudeLine(mini, asked({ installed: "2.1.296", run: { phase: "updated", version: "2.1.296" } }), "2.1.296")).toEqual({
      tone: "done",
      text: "Updated to 2.1.296. New agents on studio-mini start on it.",
    });
    expect(hostClaudeLine(mini, asked({ run: { phase: "current", version: "2.1.292" } }), "2.1.296")).toEqual({ tone: "done", text: "2.1.292 is up to date" });
    const failed = { phase: "failed", ...run, step: "check", message: "To update, run: brew upgrade claude-code" } as const;
    expect(hostClaudeLine(mini, asked({ run: failed }), "2.1.296")).toEqual({ tone: "error", text: "To update, run: brew upgrade claude-code" });
  });

  it("offers the newest release to an older host that is not updating, a failed one again", () => {
    expect(hostClaudeOffer(asked({}), "2.1.296")).toBe("2.1.296");
    // 2.1.10 is newer than 2.1.9.
    expect(hostClaudeOffer(asked({ installed: "2.1.9" }), "2.1.10")).toBe("2.1.10");
    expect(hostClaudeOffer(asked({ installed: "2.1.296" }), "2.1.296")).toBeNull();
    expect(hostClaudeOffer(asked({ installed: null }), "2.1.296")).toBeNull();
    expect(hostClaudeOffer(asked({}), null)).toBeNull();
    // The last check got no answer: what it runs now is unknown.
    expect(hostClaudeOffer(asked({ unasked: true }), "2.1.296")).toBeNull();
    expect(hostClaudeOffer(asked({ run: { phase: "updating", installed: "2.1.292", latest: "2.1.296", step: "check" } }), "2.1.296")).toBeNull();
    const failed = { phase: "failed", installed: "2.1.292", latest: "2.1.296", step: "install", message: "claude update failed" } as const;
    expect(hostClaudeOffer(asked({ run: failed }), "2.1.296")).toBe("2.1.296");
  });
});

describe("asking a host again when it reconnects (X109)", () => {
  it("asks a remote host Settings asked before once it is connected again", () => {
    expect(recheckHostClaudeOnReconnect(mini, "reconnecting", true)).toBe(true);
    expect(recheckHostClaudeOnReconnect(mini, undefined, true)).toBe(true);
  });

  it("leaves a host never asked, one still connected, one not back and this Mac alone", () => {
    expect(recheckHostClaudeOnReconnect(mini, "reconnecting", false)).toBe(false);
    expect(recheckHostClaudeOnReconnect(mini, "connected", true)).toBe(false);
    expect(recheckHostClaudeOnReconnect(host({ status: "error" }), "connected", true)).toBe(false);
    expect(recheckHostClaudeOnReconnect(host({ id: "local", remote: false, kind: "local" }), "reconnecting", true)).toBe(false);
  });
});
