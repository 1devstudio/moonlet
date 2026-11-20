import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostClaudeLine, NOT_ASKED } from "./hostClaude";
import { checkHostClaude, hostClaudeEvent, updateHostClaude, useHostClaude } from "./hostClaudeStore";
import type { HostInfo } from "./protocol";

/** What each host's daemon answers, by host and method. */
const hosts = vi.hoisted(() => ({ answers: {} as Record<string, Record<string, () => Promise<unknown>>> }));
vi.mock("./daemon", async (original) => {
  const real = await original<typeof import("./daemon")>();
  return { ...real, rpc: (host: string, method: string) => hosts.answers[host][method]() };
});

const info = (id: string): HostInfo => ({ id, label: id, remote: true, kind: "tailnet", status: "connected", message: null, daemon_version: "0.2.0", hostname: null, home: null });
const LATEST = "2.1.296";
/** The line Settings shows for `id` now. */
const line = (id: string) => hostClaudeLine(info(id), useHostClaude.getState().hosts[id] ?? NOT_ASKED, LATEST)?.text ?? null;
const version = (id: string) => useHostClaude.getState().hosts[id]?.installed ?? null;

/** A reply the test sends when it chooses. */
function later<T>() {
  let send!: (v: T) => void;
  const p = new Promise<T>((r) => (send = r));
  return { p, send };
}

// The lines `claude update` 2.1.292 prints for a native install.
const UPDATED = "Current version: 2.1.292\nChecking for updates to latest version...\nUpdating to 2.1.296...\nSuccessfully updated from 2.1.292 to version 2.1.296\n";

describe("Claude Code on a remote host (X109)", () => {
  beforeEach(() => {
    useHostClaude.setState({ hosts: {} });
    hosts.answers = {};
  });

  it("asks each host its version", async () => {
    hosts.answers["studio-mini"] = { "claude.version": async () => ({ version: "2.1.292", updating: false }) };
    hosts.answers["build-box"] = { "claude.version": async () => ({ version: "2.1.296", updating: false }) };
    await Promise.all([checkHostClaude("studio-mini"), checkHostClaude("build-box")]);
    expect(line("studio-mini")).toBe("2.1.296 is available");
    expect(line("build-box")).toBe("Up to date");
  });

  it("says the host could not be asked when it does not answer", async () => {
    hosts.answers["studio-mini"] = { "claude.version": () => Promise.reject({ code: "failed", message: "disconnected" }) };
    await checkHostClaude("studio-mini");
    expect(line("studio-mini")).toBe("Could not ask studio-mini");
  });

  it("follows an update's lines on that host to its result, and reads the new version", async () => {
    let installed = "2.1.292";
    const run = later<unknown>();
    hosts.answers["studio-mini"] = { "claude.version": async () => ({ version: installed, updating: false }), "claude.update": () => run.p };
    await checkHostClaude("studio-mini");
    const updating = updateHostClaude("studio-mini", LATEST);
    expect(line("studio-mini")).toBe("Updating to 2.1.296…");
    hostClaudeEvent("studio-mini", "claude.update_output", { line: "Checking for updates to latest version..." });
    hostClaudeEvent("studio-mini", "claude.update_output", { line: "Updating to 2.1.296..." });
    expect(line("studio-mini")).toBe("Installing 2.1.296…");
    installed = "2.1.296";
    run.send({ ok: true, output: UPDATED });
    await updating;
    expect(line("studio-mini")).toBe("Updated to 2.1.296. New agents on studio-mini start on it.");
    expect(version("studio-mini")).toBe("2.1.296");
    // The daemon's claude.update_done, which comes as well, changes nothing.
    hostClaudeEvent("studio-mini", "claude.update_done", { ok: true, output: UPDATED });
    expect(line("studio-mini")).toBe("Updated to 2.1.296. New agents on studio-mini start on it.");
  });

  it("leaves another host's row alone", async () => {
    const run = later<unknown>();
    hosts.answers["studio-mini"] = { "claude.version": async () => ({ version: "2.1.292", updating: false }), "claude.update": () => run.p };
    hosts.answers["build-box"] = { "claude.version": async () => ({ version: "2.1.292", updating: false }) };
    await Promise.all([checkHostClaude("studio-mini"), checkHostClaude("build-box")]);
    const updating = updateHostClaude("studio-mini", LATEST);
    hostClaudeEvent("build-box", "claude.update_output", { line: "Updating to 2.1.296..." });
    hostClaudeEvent("build-box", "claude.update_done", { ok: true, output: UPDATED });
    expect(line("studio-mini")).toBe("Updating to 2.1.296…");
    expect(line("build-box")).toBe("2.1.296 is available");
    run.send({ ok: false, output: "" });
    await updating;
  });

  it("gives a host Settings never asked no row from its events", () => {
    hostClaudeEvent("attic", "claude.update_output", { line: "Updating to 2.1.296..." });
    hostClaudeEvent("attic", "claude.update_done", { ok: true, output: UPDATED });
    expect(line("attic")).toBeNull();
    expect(version("attic")).toBeNull();
  });

  it("replaces a result with Could not ask when the next check gets no answer", async () => {
    hosts.answers["studio-mini"] = {
      "claude.version": async () => ({ version: "2.1.292", updating: false }),
      "claude.update": async () => ({ ok: false, output: "Checking for updates to latest version...\nclaude update failed badly\n" }),
    };
    await checkHostClaude("studio-mini");
    await updateHostClaude("studio-mini", LATEST);
    expect(line("studio-mini")).toBe("claude update failed badly");
    hosts.answers["studio-mini"]["claude.version"] = () => Promise.reject({ code: "failed", message: "disconnected" });
    await checkHostClaude("studio-mini");
    expect(line("studio-mini")).toBe("Could not ask studio-mini");
  });

  it("shows what claude update said when it failed, and offers the update again", async () => {
    hosts.answers["studio-mini"] = {
      "claude.version": async () => ({ version: "2.1.292", updating: false }),
      "claude.update": async () => ({
        ok: false,
        output: "Current version: 2.1.292\nChecking for updates to latest version...\nClaude is managed by Homebrew.\nTo update, run:\n  brew upgrade claude-code\n",
      }),
    };
    await checkHostClaude("studio-mini");
    await updateHostClaude("studio-mini", LATEST);
    expect(line("studio-mini")).toBe("Claude is managed by Homebrew.\nTo update, run:\n  brew upgrade claude-code");
    // The next check shows the version line again.
    await checkHostClaude("studio-mini");
    expect(line("studio-mini")).toBe("2.1.296 is available");
  });

  it("shows an update started elsewhere until that host says it ended", async () => {
    hosts.answers["studio-mini"] = { "claude.version": async () => ({ version: "2.1.292", updating: true }) };
    await checkHostClaude("studio-mini");
    expect(line("studio-mini")).toBe("Updating to 2.1.296…");
    hosts.answers["studio-mini"]["claude.version"] = async () => ({ version: "2.1.296", updating: false });
    hostClaudeEvent("studio-mini", "claude.update_done", { ok: true, output: UPDATED });
    await vi.waitFor(() => expect(version("studio-mini")).toBe("2.1.296"));
    expect(line("studio-mini")).toBe("Updated to 2.1.296. New agents on studio-mini start on it.");
  });

  it("keeps the result when a check begun before the update ended answers after it", async () => {
    const stale = later<unknown>();
    hosts.answers["studio-mini"] = {
      "claude.version": async () => ({ version: "2.1.292", updating: false }),
      "claude.update": async () => ({ ok: true, output: UPDATED }),
    };
    await checkHostClaude("studio-mini");
    hosts.answers["studio-mini"]["claude.version"] = () => stale.p;
    const checking = checkHostClaude("studio-mini");
    hosts.answers["studio-mini"]["claude.version"] = async () => ({ version: "2.1.296", updating: false });
    await updateHostClaude("studio-mini", LATEST);
    stale.send({ version: "2.1.292", updating: false });
    await checking;
    expect(line("studio-mini")).toBe("Updated to 2.1.296. New agents on studio-mini start on it.");
    expect(version("studio-mini")).toBe("2.1.296");
  });

  it("leaves a running update where it is when Check now answers meanwhile", async () => {
    const run = later<unknown>();
    hosts.answers["studio-mini"] = { "claude.version": async () => ({ version: "2.1.292", updating: false }), "claude.update": () => run.p };
    await checkHostClaude("studio-mini");
    const updating = updateHostClaude("studio-mini", LATEST);
    hostClaudeEvent("studio-mini", "claude.update_output", { line: "Updating to 2.1.296..." });
    hosts.answers["studio-mini"]["claude.version"] = async () => ({ version: "2.1.292", updating: true });
    await checkHostClaude("studio-mini");
    expect(line("studio-mini")).toBe("Installing 2.1.296…");
    run.send({ ok: false, output: "" });
    await updating;
  });

  it("ignores a second click while the host updates", async () => {
    const run = later<unknown>();
    const busy = { code: "failed", message: "Claude Code is already updating" };
    let ask = () => run.p;
    hosts.answers["studio-mini"] = { "claude.version": async () => ({ version: "2.1.292", updating: false }), "claude.update": () => ask() };
    await checkHostClaude("studio-mini");
    const first = updateHostClaude("studio-mini", LATEST);
    ask = () => Promise.reject(busy);
    await updateHostClaude("studio-mini", LATEST);
    expect(line("studio-mini")).toBe("Updating to 2.1.296…");
    run.send({ ok: true, output: UPDATED });
    await first;
    expect(line("studio-mini")).toBe("Updated to 2.1.296. New agents on studio-mini start on it.");
  });
});
