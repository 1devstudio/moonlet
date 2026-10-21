import { describe, expect, it } from "vitest";
import { centralHostId, linkLine, linkRetries, pickCentral } from "./workerLink";
import type { HostInfo, LinkInfo, LinkState } from "./protocol";

const info = (state: LinkState, central: string | null = "studio-mini"): LinkInfo => ({
  central: central ? { name: central, addrs: ["100.101.102.103:47428"] } : null,
  worker: { id: "7d3f1c2a-5b8e-4e61-9a0f-2c4d6e8b1f37", name: "Alex's MacBook Pro", enabled: true },
  state,
});

describe("the link's status line (X41)", () => {
  it("reads one line per link state", () => {
    const since = new Date(2026, 9, 21, 10, 42).getTime();
    expect(linkLine(info({ kind: "off" }, null))).toEqual({ tone: "muted", text: "Not linked" });
    expect(linkLine(info({ kind: "connecting" }))).toEqual({ tone: "blocked", text: "Linking to studio-mini…" });
    expect(linkLine(info({ kind: "connected", since }))).toEqual({ tone: "done", text: "Linked to studio-mini since 10:42" });
    expect(linkLine(info({ kind: "reconnecting" }))).toEqual({ tone: "blocked", text: "Reconnecting to studio-mini…" });
    expect(linkLine(info({ kind: "needs_update", daemon_version: "0.1.26" }))).toEqual({ tone: "error", text: "Update moonlet on studio-mini" });
    expect(linkLine(info({ kind: "refused" }))).toEqual({
      tone: "error",
      text: "studio-mini no longer accepts this Mac. Pair it again.",
    });
    expect(linkLine(info({ kind: "error", message: "connection refused" }))).toEqual({ tone: "error", text: "connection refused" });
  });

  it("pads the time of day", () => {
    const since = new Date(2026, 9, 21, 9, 5).getTime();
    expect(linkLine(info({ kind: "connected", since })).text).toBe("Linked to studio-mini since 09:05");
  });

  it("offers Retry for a connection error and after updating, not for a host that removed this Mac", () => {
    expect(linkRetries(info({ kind: "error", message: "connection refused" }))).toBe(true);
    expect(linkRetries(info({ kind: "needs_update", daemon_version: "0.1.26" }))).toBe(true);
    expect(linkRetries(info({ kind: "refused" }))).toBe(false);
    expect(linkRetries(info({ kind: "connected", since: 0 }))).toBe(false);
  });
});

describe("the central host choice (X41)", () => {
  const host = (id: string, kind: HostInfo["kind"]): HostInfo => ({ id, label: id, remote: true, kind, status: "connected", message: null, daemon_version: null, hostname: null, home: null });
  const hosts = [host("studio-mini", "tailnet"), host("build-box", "tailnet"), host("devbox", "ssh")];

  it("is the tailnet host the link goes to", () => {
    expect(centralHostId(hosts, info({ kind: "off" }, "studio-mini"))).toBe("studio-mini");
    expect(centralHostId(hosts, info({ kind: "off" }, null))).toBeNull();
    expect(centralHostId(hosts, null)).toBeNull();
  });

  it("is never an SSH host, nor a host this Mac no longer has", () => {
    expect(centralHostId(hosts, info({ kind: "off" }, "devbox"))).toBeNull();
    expect(centralHostId(hosts, info({ kind: "off" }, "old-mini"))).toBeNull();
  });

  it("moves to another host, and choosing it again clears it", () => {
    expect(pickCentral(null, "studio-mini")).toBe("studio-mini");
    expect(pickCentral("studio-mini", "build-box")).toBe("build-box");
    expect(pickCentral("studio-mini", "studio-mini")).toBeNull();
  });
});
